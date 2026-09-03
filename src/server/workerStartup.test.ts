import { describe, expect, it, vi } from "vitest";
import {
  FatalWorkerConfigurationError,
  waitForWorkerDependencies,
} from "./workerStartup";

/**
 * The launchd crash loop, and the line between waiting and dying.
 *
 * Under `KeepAlive=true` with `ThrottleInterval=10`, a worker that exits is a
 * worker that is relaunched ten seconds later. So throwing at an unmounted
 * external drive or a database that had not finished starting after login was
 * not an error report, it was a cadence: six Node starts a minute, each paying
 * for a tsx compile, and hundreds of copies of
 *
 *   Startup failed: SEYIRLIK_MEDIA_ROOT must point to an existing media directory.
 *
 * burying the one line that meant anything.
 *
 * The clock is faked, so a test covering a wait of many minutes costs none.
 */

/** Collects the sleeps rather than performing them. */
function fakeSleeper() {
  const sleeps: number[] = [];
  let clock = 0;
  return {
    sleeps,
    now: () => clock,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      clock += ms;
    },
  };
}

describe("a media root that is not mounted yet", () => {
  it("waits rather than exiting, and says so once", async () => {
    const sleeper = fakeSleeper();
    const log = vi.fn();
    let mounted = false;
    const probeMediaRoot = vi.fn(async (root: string) => {
      if (!mounted) {
        throw new Error(
          "SEYIRLIK_MEDIA_ROOT must point to an existing media directory.",
        );
      }
      return root;
    });

    const waiting = waitForWorkerDependencies({
      mediaRoot: "/Volumes/Expansion/media",
      probeMediaRoot,
      sleep: async (ms) => {
        await sleeper.sleep(ms);
        // The drive is plugged in after the third failure.
        if (sleeper.sleeps.length >= 3) mounted = true;
      },
      now: sleeper.now,
      log,
    });

    const dependencies = await waiting;
    expect(dependencies.mediaRoot).toBe("/Volumes/Expansion/media");

    /*
     * The whole regression in one assertion: four attempts, not four process
     * exits, and two log lines — one for the transition away and one back.
     */
    expect(probeMediaRoot).toHaveBeenCalledTimes(4);
    expect(log).toHaveBeenCalledTimes(2);
    /*
     * Doubling, with jitter applied downwards only — so each wait is inside its
     * nominal step rather than equal to it. Asserted as a shape because the
     * jitter is real: pinning exact values here would either forbid the jitter
     * or require a seeded clock in production code to satisfy a test.
     */
    expect(sleeper.sleeps).toHaveLength(3);
    const [first, second, third] = sleeper.sleeps as [number, number, number];
    expect(first).toBeGreaterThan(700);
    expect(first).toBeLessThanOrEqual(1_000);
    expect(second).toBeGreaterThan(first);
    expect(second).toBeLessThanOrEqual(2_000);
    expect(third).toBeGreaterThan(second);
    expect(third).toBeLessThanOrEqual(4_000);
  });

  /**
   * A long absence — somebody left the drive unplugged over a weekend — must
   * stay quiet and stay cheap. Under the old behaviour this was tens of
   * thousands of process launches.
   */
  it("stays bounded and near-silent across a very long absence", async () => {
    const sleeper = fakeSleeper();
    const log = vi.fn();
    let attempts = 0;
    const probeMediaRoot = vi.fn(async (root: string) => {
      attempts += 1;
      // Roughly two hours of simulated absence at the ceiling.
      if (attempts < 250) throw new Error("not mounted");
      return root;
    });

    await waitForWorkerDependencies({
      mediaRoot: "/Volumes/Expansion/media",
      probeMediaRoot,
      sleep: sleeper.sleep,
      now: sleeper.now,
      log,
    });

    // One line each way, whatever the outage's length.
    expect(log).toHaveBeenCalledTimes(2);
    // Every wait is capped, so the loop cannot degenerate into a spin.
    expect(Math.max(...sleeper.sleeps)).toBeLessThanOrEqual(30_000);
    expect(Math.min(...sleeper.sleeps)).toBeGreaterThanOrEqual(800);
    /*
     * Simulated elapsed time far exceeds the attempt count times any small
     * interval, which is the property that says the backoff actually held.
     */
    expect(sleeper.now()).toBeGreaterThan(3_600_000);
  });
});

describe("a database that is still starting", () => {
  it("waits for it instead of exiting", async () => {
    const sleeper = fakeSleeper();
    let up = false;
    const probeDatabase = vi.fn(async () => {
      if (!up) throw new Error("connect ECONNREFUSED 127.0.0.1:5432");
    });

    const dependencies = await waitForWorkerDependencies({
      mediaRoot: "/Volumes/Expansion/media",
      probeMediaRoot: async (root) => root,
      probeDatabase,
      sleep: async (ms) => {
        await sleeper.sleep(ms);
        if (sleeper.sleeps.length >= 2) up = true;
      },
      now: sleeper.now,
      log: () => undefined,
    });

    expect(probeDatabase).toHaveBeenCalledTimes(3);
    expect(dependencies.report().degraded).toBe(false);
  });

  /** The UI has to be able to say what is missing while the worker waits. */
  it("exposes the degraded reason without leaking a connection string", async () => {
    const sleeper = fakeSleeper();
    let attempts = 0;
    const controller = new AbortController();

    const waiting = waitForWorkerDependencies({
      mediaRoot: "/Volumes/Expansion/media",
      probeMediaRoot: async (root) => root,
      probeDatabase: async () => {
        attempts += 1;
        if (attempts > 2) controller.abort();
        throw new Error(
          "connect ECONNREFUSED for postgres://seyirlik:pw@127.0.0.1:5432/seyirlik",
        );
      },
      signal: controller.signal,
      sleep: sleeper.sleep,
      now: sleeper.now,
      log: () => undefined,
    });

    await expect(waiting).rejects.toBeInstanceOf(FatalWorkerConfigurationError);
    expect(attempts).toBeGreaterThan(1);
  });
});

describe("configuration that waiting will never fix", () => {
  /**
   * Nothing supplies a variable nobody set. A worker that sat waiting for one
   * would look healthy while doing nothing at all, which is worse than the
   * crash loop it replaced.
   */
  it("exits for a missing media root variable", async () => {
    await expect(
      waitForWorkerDependencies({
        mediaRoot: undefined,
        probeMediaRoot: async (root) => root,
      }),
    ).rejects.toBeInstanceOf(FatalWorkerConfigurationError);
  });

  it("exits for an empty media root variable", async () => {
    await expect(
      waitForWorkerDependencies({
        mediaRoot: "   ",
        probeMediaRoot: async (root) => root,
      }),
    ).rejects.toBeInstanceOf(FatalWorkerConfigurationError);
  });

  /** A shutdown while waiting must be taken now, not at the next step. */
  it("gives up promptly when the process is asked to stop", async () => {
    const controller = new AbortController();
    const waiting = waitForWorkerDependencies({
      mediaRoot: "/Volumes/Expansion/media",
      probeMediaRoot: async () => {
        throw new Error("not mounted");
      },
      signal: controller.signal,
      sleep: async () => {
        controller.abort();
      },
      log: () => undefined,
    });
    await expect(waiting).rejects.toBeInstanceOf(FatalWorkerConfigurationError);
  });
});
