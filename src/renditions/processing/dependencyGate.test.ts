import { describe, expect, it, vi } from "vitest";
import {
  awaitDependency,
  createDependencyGate,
  DEFAULT_MAX_DELAY_MS,
} from "./dependencyGate";

/**
 * Bounding what an outage costs.
 *
 * The incident: PostgreSQL went away during an encode and the worker logged
 * `Could not read the pause state for a processing job: Connection terminated
 * due to connection timeout` several hundred times. The poll ran once a second
 * and had no concept of "unavailable", so every tick paid a five-second dial
 * timeout and wrote a line, from every running job at once, for as long as the
 * database was down.
 *
 * The tests below are about *counts*: probes, and transition notifications.
 * A fake clock does the waiting so a five-minute outage costs no wall time.
 */

/** A clock the tests advance by hand. */
function fakeClock(start = 0) {
  let value = start;
  return {
    now: () => value,
    advance: (ms: number) => {
      value += ms;
    },
  };
}

describe("while the dependency is answering", () => {
  it("costs nothing and probes nothing", async () => {
    const probe = vi.fn(async () => undefined);
    const gate = createDependencyGate({ name: "db", probe });

    for (let index = 0; index < 1_000; index += 1) {
      expect(await gate.check()).toBe(true);
    }
    expect(probe).not.toHaveBeenCalled();
  });

  /**
   * A gate that started `unavailable` would make every process announce an
   * outage on startup and serve one backoff step of refusals before its first
   * probe.
   */
  it("starts optimistic", () => {
    const gate = createDependencyGate({ name: "db", probe: async () => {} });
    expect(gate.state).toBe("available");
  });
});

describe("when the dependency goes away", () => {
  it("announces the transition exactly once, however many callers ask", async () => {
    const clock = fakeClock();
    const changes: Array<[string, string]> = [];
    const gate = createDependencyGate({
      name: "db",
      probe: async () => {
        throw new Error("Connection terminated due to connection timeout");
      },
      onStateChange: (state, detail) => changes.push([state, detail]),
      now: clock.now,
      random: () => 0,
    });

    /*
     * The shape a caller that does its own work uses: it asks the gate, does
     * the query, and hands back the failure. Every subsequent ask is answered
     * from memory.
     */
    expect(await gate.check()).toBe(true);
    gate.reportFailure(
      new Error("Connection terminated due to connection timeout"),
    );
    for (let index = 0; index < 200; index += 1) {
      expect(await gate.check()).toBe(false);
    }
    expect(changes).toHaveLength(1);
    expect(changes[0]?.[0]).toBe("unavailable");
    /*
     * Zero, not one: the failure the caller handed back was not the gate's own
     * probe, and every ask since has been inside the backoff. Two hundred
     * callers cost nothing at all.
     */
    expect(gate.probeCount).toBe(0);
  });

  /**
   * The exact shape of the incident, at its real cadence: a poll asking once a
   * second for five minutes. Three hundred asks used to be three hundred dial
   * attempts and three hundred log lines.
   */
  it("bounds a five-minute outage at a one-second poll", async () => {
    const clock = fakeClock();
    const changes: string[] = [];
    const gate = createDependencyGate({
      name: "The processing database",
      probe: async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:5432");
      },
      onStateChange: (state) => changes.push(state),
      now: clock.now,
      random: () => 0,
    });

    for (let tick = 0; tick < 300; tick += 1) {
      /*
       * The real loop: ask, and on a `true` do the work that then fails. The
       * first tick is the only one that reaches the database on the caller's
       * own initiative; after that the gate is holding the line.
       */
      if (await gate.check()) {
        gate.reportFailure(new Error("connect ECONNREFUSED 127.0.0.1:5432"));
      }
      clock.advance(1_000);
    }

    expect(changes).toEqual(["unavailable"]);
    /*
     * 1s, 2s, 4s, 8s, 16s, then 30s for the remaining ~230 seconds. Around a
     * dozen, against the three hundred the old loop would have made — and the
     * assertion is a ceiling rather than an exact figure so that jitter and a
     * changed schedule stay legal while a regression to per-tick probing does
     * not.
     */
    expect(gate.probeCount).toBeLessThanOrEqual(20);
    expect(gate.probeCount).toBeGreaterThan(5);
  });

  /**
   * A thousand callers hitting a dead dependency must not become a thousand
   * connection attempts. This is the amplification that turned one outage into
   * a load problem of its own.
   */
  it("keeps the probe count bounded under thousands of failed checks", async () => {
    const clock = fakeClock();
    const gate = createDependencyGate({
      name: "media root",
      probe: async () => {
        throw new Error("ENOENT");
      },
      now: clock.now,
      random: () => 0,
    });

    gate.reportFailure(new Error("ENOENT"));
    for (let index = 0; index < 10_000; index += 1) {
      await gate.check();
      // A tenth of a second per ask: far faster than anything real polls.
      clock.advance(100);
    }
    expect(gate.probeCount).toBeLessThanOrEqual(50);
  });

  it("never waits longer than the ceiling", async () => {
    const clock = fakeClock();
    const gate = createDependencyGate({
      name: "db",
      probe: async () => {
        throw new Error("no");
      },
      now: clock.now,
      random: () => 0,
    });
    for (let index = 0; index < 40; index += 1) {
      await gate.checkNow();
    }
    expect((gate.nextAttemptAtMs ?? 0) - clock.now()).toBeLessThanOrEqual(
      DEFAULT_MAX_DELAY_MS,
    );
  });

  /**
   * Without jitter the pause poll, the queue poll and the health check all
   * retry on the same doubling schedule, so a database coming back meets
   * simultaneous reconnections from every process at each step.
   */
  it("spreads retries, and only downwards from the ceiling", async () => {
    const clock = fakeClock();
    const delays: number[] = [];
    for (const roll of [0, 0.5, 1]) {
      const gate = createDependencyGate({
        name: "db",
        probe: async () => {
          throw new Error("no");
        },
        now: clock.now,
        random: () => roll,
      });
      await gate.checkNow();
      delays.push((gate.nextAttemptAtMs ?? 0) - clock.now());
    }
    expect(new Set(delays).size).toBe(3);
    for (const delay of delays) {
      expect(delay).toBeLessThanOrEqual(1_000);
      expect(delay).toBeGreaterThanOrEqual(0);
    }
  });

  /** Concurrent callers share one in-flight probe rather than each dialling. */
  it("collapses concurrent probes into one", async () => {
    let started = 0;
    const gate = createDependencyGate({
      name: "db",
      probe: async () => {
        started += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        throw new Error("no");
      },
    });
    await Promise.all([gate.checkNow(), gate.checkNow(), gate.checkNow()]);
    expect(started).toBe(1);
  });
});

describe("when the dependency comes back", () => {
  it("announces recovery exactly once and resumes normal polling", async () => {
    const clock = fakeClock();
    const changes: string[] = [];
    let healthy = false;
    const gate = createDependencyGate({
      name: "db",
      probe: async () => {
        if (!healthy) throw new Error("no");
      },
      onStateChange: (state) => changes.push(state),
      now: clock.now,
      random: () => 0,
    });

    gate.reportFailure(new Error("no"));
    expect(await gate.check()).toBe(false);
    clock.advance(60_000);
    healthy = true;
    expect(await gate.check()).toBe(true);

    const probesAfterRecovery = gate.probeCount;
    for (let index = 0; index < 500; index += 1) {
      expect(await gate.check()).toBe(true);
    }
    expect(gate.probeCount).toBe(probesAfterRecovery);
    expect(changes).toEqual(["unavailable", "available"]);
    expect(gate.failureCount).toBe(0);
    expect(gate.lastError).toBeNull();
  });

  it("reports a probe that resolves false as unavailable", async () => {
    const gate = createDependencyGate({
      name: "db",
      probe: async () => false,
    });
    expect(await gate.checkNow()).toBe(false);
    expect(gate.state).toBe("unavailable");
  });
});

describe("waiting for a dependency", () => {
  it("sleeps on the gate's own schedule rather than spinning", async () => {
    const clock = fakeClock();
    const sleeps: number[] = [];
    let attempts = 0;
    const gate = createDependencyGate({
      name: "media root",
      probe: async () => {
        attempts += 1;
        if (attempts < 4) throw new Error("not mounted");
      },
      now: clock.now,
      random: () => 0,
    });

    const ready = await awaitDependency({
      gate,
      now: clock.now,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock.advance(ms);
      },
    });

    expect(ready).toBe(true);
    expect(sleeps).toEqual([1_000, 2_000, 4_000]);
  });

  /** A worker asked to shut down must go now, not at the next backoff step. */
  it("gives up when the signal fires", async () => {
    const controller = new AbortController();
    const gate = createDependencyGate({
      name: "db",
      probe: async () => {
        throw new Error("no");
      },
    });
    const waiting = awaitDependency({
      gate,
      signal: controller.signal,
      sleep: async () => {
        controller.abort();
      },
    });
    await expect(waiting).resolves.toBe(false);
  });

  /** Text reaching a browser must carry no path and no connection string. */
  it("sanitises the recorded error", async () => {
    const gate = createDependencyGate({
      name: "db",
      probe: async () => {
        throw new Error(
          "connect failed for postgres://user:pw@host/db reading /Volumes/Expansion/media",
        );
      },
    });
    await gate.checkNow();
    expect(gate.lastError).not.toContain("/Volumes/Expansion");
    expect(gate.lastError).not.toContain("postgres://");
  });
});
