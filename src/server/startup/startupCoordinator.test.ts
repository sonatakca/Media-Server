// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  createStartupCoordinator,
  STARTUP_DEGRADE_AFTER_MS,
  STARTUP_SLOW_WARNING_MS,
  STARTUP_STILL_WAITING_INTERVAL_MS,
  type StartupObserver,
} from "./startupCoordinator";
import { createStartupState, type StartupPhaseSnapshot } from "./startupState";

/**
 * A stand-in scheduler that counts what is outstanding.
 *
 * Fake timers would do for the firing, but not for the question these tests
 * actually care about: whether a settled phase left anything behind. Startup
 * arms three timers per phase and there are seven phases, so a leak here is a
 * process that cannot be told it is idle.
 */
function testTimers() {
  let nextId = 1;
  const pending = new Map<number, { fire: () => void; repeating: boolean }>();

  return {
    outstanding: () => pending.size,
    fireAll: () => {
      for (const [id, entry] of [...pending]) {
        if (!entry.repeating) pending.delete(id);
        entry.fire();
      }
    },
    fireOne: (predicate: (repeating: boolean) => boolean) => {
      for (const [id, entry] of [...pending]) {
        if (!predicate(entry.repeating)) continue;
        if (!entry.repeating) pending.delete(id);
        entry.fire();
        return true;
      }
      return false;
    },
    timers: {
      setTimeout(callback: () => void) {
        const id = nextId++;
        pending.set(id, { fire: callback, repeating: false });
        return id;
      },
      clearTimeout(handle: unknown) {
        pending.delete(handle as number);
      },
      setInterval(callback: () => void) {
        const id = nextId++;
        pending.set(id, { fire: callback, repeating: true });
        return id;
      },
      clearInterval(handle: unknown) {
        pending.delete(handle as number);
      },
    },
  };
}

function recordingObserver() {
  const events: Array<{ event: string; phase?: StartupPhaseSnapshot }> = [];
  const record =
    (event: string) =>
    (phase: StartupPhaseSnapshot): void => {
      events.push({ event, phase });
    };

  const observer: StartupObserver = {
    began: record("began"),
    slow: record("slow"),
    waiting: record("waiting"),
    degraded: record("degraded"),
    settled: record("settled"),
    live: () => events.push({ event: "live" }),
    finished: () => events.push({ event: "finished" }),
  };

  return {
    observer,
    events,
    names: () => events.map((entry) => entry.event),
    of: (event: string) => events.filter((entry) => entry.event === event),
  };
}

function clock(start = 1_000) {
  let value = start;
  return {
    now: () => value,
    advance: (ms: number) => {
      value += ms;
    },
  };
}

describe("running a startup step", () => {
  it("reports the operation and resource before awaiting anything", async () => {
    const { observer, of } = recordingObserver();
    const { timers } = testTimers();
    const coordinator = createStartupCoordinator({ observer, timers });

    let observedAtStart: StartupPhaseSnapshot | undefined;
    const work = coordinator.run(
      {
        id: "media-storage",
        operation: "stat",
        resource: "/Volumes/Expansion/media",
      },
      async () => {
        observedAtStart = coordinator
          .snapshot()
          .phases.find((phase) => phase.id === "media-storage");
        return "resolved";
      },
    );

    expect(await work).toBe("resolved");
    // The `began` event carries the diagnosis: it is emitted before the call
    // that hung for nine minutes, not after it.
    expect(of("began")[0]?.phase).toMatchObject({
      id: "media-storage",
      operation: "stat",
      resource: "/Volumes/Expansion/media",
      state: "running",
    });
    expect(observedAtStart?.state).toBe("running");
  });

  it("records the duration on completion", async () => {
    const time = clock();
    const { observer, of } = recordingObserver();
    const { timers } = testTimers();
    const coordinator = createStartupCoordinator({
      state: createStartupState({ now: time.now }),
      observer,
      timers,
    });

    await coordinator.run({ id: "configuration" }, async () => {
      time.advance(12);
    });

    expect(of("settled")[0]?.phase).toMatchObject({
      state: "ready",
      elapsedMs: 12,
    });
  });

  it("warns that a step is slow without marking it failed", async () => {
    const { observer, of } = recordingObserver();
    const scheduler = testTimers();
    const coordinator = createStartupCoordinator({
      observer,
      timers: scheduler.timers,
    });

    let release: (() => void) | undefined;
    const work = coordinator.run(
      { id: "media-storage", operation: "stat" },
      () => new Promise<void>((resolve) => (release = resolve)),
    );

    // The slow timer is the one-shot that fires first.
    scheduler.fireOne((repeating) => !repeating);

    expect(of("slow")).toHaveLength(1);
    expect(of("slow")[0]?.phase?.state).toBe("running");
    expect(coordinator.snapshot().state).toBe("starting");

    release?.();
    await work;
    expect(coordinator.snapshot().phases[2]?.state).toBe("ready");
  });

  it("repeats a bounded 'still waiting' rather than a stream of lines", async () => {
    const { observer, of } = recordingObserver();
    const scheduler = testTimers();
    const coordinator = createStartupCoordinator({
      observer,
      timers: scheduler.timers,
    });

    let release: (() => void) | undefined;
    const work = coordinator.run(
      { id: "media-storage" },
      () => new Promise<void>((resolve) => (release = resolve)),
    );

    scheduler.fireOne((repeating) => repeating);
    scheduler.fireOne((repeating) => repeating);

    expect(of("waiting")).toHaveLength(2);

    release?.();
    await work;
    // Nothing repeats after the phase settles.
    scheduler.fireAll();
    expect(of("waiting")).toHaveLength(2);
  });

  it("degrades a step that outlasts the deadline, and lets it recover", async () => {
    const { observer, of } = recordingObserver();
    const scheduler = testTimers();
    const coordinator = createStartupCoordinator({
      observer,
      timers: scheduler.timers,
    });

    let release: (() => void) | undefined;
    const work = coordinator.run(
      { id: "media-storage", operation: "stat", slowAfterMs: 0 },
      () => new Promise<void>((resolve) => (release = resolve)),
    );

    scheduler.fireOne((repeating) => !repeating);

    expect(of("degraded")).toHaveLength(1);
    expect(coordinator.snapshot()).toMatchObject({
      state: "degraded",
      ready: false,
    });

    /*
     * Degrading never cancelled the `stat`. The volume answering afterwards is
     * an ordinary completion, and startup carries on from where it was.
     */
    release?.();
    await work;
    expect(coordinator.snapshot().phases[2]?.state).toBe("ready");
  });

  it("prefers a detail the phase already has when it degrades", async () => {
    const { observer, of } = recordingObserver();
    const scheduler = testTimers();
    const coordinator = createStartupCoordinator({
      observer,
      timers: scheduler.timers,
    });

    let release: (() => void) | undefined;
    const work = coordinator.run(
      { id: "media-storage", slowAfterMs: 0, stillWaitingEveryMs: 0 },
      (context) => {
        context.update({ detail: "The media root is unavailable: ENOENT" });
        return new Promise<void>((resolve) => (release = resolve));
      },
    );

    scheduler.fireOne((repeating) => !repeating);

    expect(of("degraded")[0]?.phase?.detail).toContain("ENOENT");
    release?.();
    await work;
  });

  it("fails the step when the work throws, and propagates", async () => {
    const { observer, of } = recordingObserver();
    const { timers } = testTimers();
    const coordinator = createStartupCoordinator({ observer, timers });

    await expect(
      coordinator.run({ id: "database" }, async () => {
        throw new Error("The database is unavailable.");
      }),
    ).rejects.toThrow("The database is unavailable.");

    expect(of("settled")[0]?.phase).toMatchObject({
      state: "failed",
      error: "The database is unavailable.",
    });
    expect(coordinator.snapshot().state).toBe("failed");
  });

  it("emits one settled event per step", async () => {
    const { observer, of } = recordingObserver();
    const { timers } = testTimers();
    const coordinator = createStartupCoordinator({ observer, timers });

    await coordinator.run({ id: "configuration" }, async () => undefined);
    coordinator.complete("configuration");
    coordinator.fail("configuration", new Error("later"));

    expect(of("settled")).toHaveLength(1);
  });

  it("clears every timer it armed", async () => {
    const scheduler = testTimers();
    const coordinator = createStartupCoordinator({ timers: scheduler.timers });

    await coordinator.run({ id: "configuration" }, async () => undefined);
    expect(scheduler.outstanding()).toBe(0);

    await coordinator
      .run({ id: "database" }, async () => {
        throw new Error("nope");
      })
      .catch(() => undefined);
    expect(scheduler.outstanding()).toBe(0);
  });
});

describe("re-entering a phase", () => {
  it("keeps the original timers so a retried step still reports slowness", () => {
    const { observer, of } = recordingObserver();
    const scheduler = testTimers();
    const coordinator = createStartupCoordinator({
      observer,
      timers: scheduler.timers,
    });

    coordinator.begin({ id: "database", operation: "connect" });
    const armed = scheduler.outstanding();

    // What the database retry loop does, once every three seconds.
    for (let attempt = 2; attempt <= 5; attempt += 1) {
      coordinator.begin({ id: "database", operation: "connect" });
      coordinator.update("database", { attempt });
    }

    expect(scheduler.outstanding()).toBe(armed);
    expect(of("began")).toHaveLength(1);
    // The heartbeat still belongs to the first attempt, so it can actually fire.
    scheduler.fireOne((repeating) => repeating);
    expect(of("waiting")).toHaveLength(1);
    expect(of("waiting")[0]?.phase?.attempt).toBe(5);
  });
});

describe("shutdown during startup", () => {
  it("stops every timer and never becomes ready afterwards", async () => {
    const { observer, names } = recordingObserver();
    const scheduler = testTimers();
    const coordinator = createStartupCoordinator({
      observer,
      timers: scheduler.timers,
    });

    coordinator.markLive();
    let release: (() => void) | undefined;
    const work = coordinator.run(
      { id: "media-storage", operation: "stat" },
      () => new Promise<void>((resolve) => (release = resolve)),
    );

    coordinator.stop();

    expect(scheduler.outstanding()).toBe(0);
    expect(coordinator.stopping).toBe(true);
    expect(coordinator.snapshot()).toMatchObject({
      live: true,
      ready: false,
      state: "stopping",
    });

    // The kernel finally answers, after the process has decided to go.
    release?.();
    await work;
    coordinator.begin({ id: "routes" });
    coordinator.complete("routes");

    expect(coordinator.snapshot().ready).toBe(false);
    expect(names()).not.toContain("degraded");
  });

  it("reports the closing summary once, however many paths reach it", () => {
    const { observer, of } = recordingObserver();
    const { timers } = testTimers();
    const coordinator = createStartupCoordinator({ observer, timers });

    coordinator.finish();
    coordinator.stop();
    coordinator.finish();

    expect(of("finished")).toHaveLength(1);
  });
});

describe("failing a span that covers several phases", () => {
  it("fails whatever was still open", () => {
    const { timers } = testTimers();
    const coordinator = createStartupCoordinator({ timers });

    coordinator.begin({ id: "database" });
    coordinator.complete("database");
    coordinator.begin({ id: "processing" });

    coordinator.failRunning(new Error("the queue would not reconcile"));

    const phases = coordinator.snapshot().phases;
    expect(phases.find((phase) => phase.id === "database")?.state).toBe(
      "ready",
    );
    expect(phases.find((phase) => phase.id === "processing")).toMatchObject({
      state: "failed",
      error: "the queue would not reconcile",
    });
  });
});

describe("the thresholds", () => {
  it("are ordered so a warning always precedes a degrade", () => {
    expect(STARTUP_SLOW_WARNING_MS).toBeLessThan(
      STARTUP_STILL_WAITING_INTERVAL_MS,
    );
    expect(STARTUP_STILL_WAITING_INTERVAL_MS).toBeLessThan(
      STARTUP_DEGRADE_AFTER_MS,
    );
  });

  it("unrefs its real timers so reporting cannot hold the process open", () => {
    const unref = vi.fn();
    const setTimeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockReturnValue({ unref } as never);
    const setIntervalSpy = vi
      .spyOn(globalThis, "setInterval")
      .mockReturnValue({ unref } as never);

    try {
      createStartupCoordinator().begin({ id: "media-storage" });
      expect(unref).toHaveBeenCalledTimes(3);
    } finally {
      setTimeoutSpy.mockRestore();
      setIntervalSpy.mockRestore();
    }
  });
});
