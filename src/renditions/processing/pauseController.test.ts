import { describe, expect, it, vi } from "vitest";
import {
  bindChildToPauseController,
  createPauseController,
} from "./pauseController";
import { createStorageWatchdog } from "./storageWatchdog";

/**
 * These cases are about the POSIX binding, and they drive it with a fake child,
 * so the platform has to be stated rather than inherited from whichever machine
 * runs them. On Windows there is no suspend at all — see the block at the end
 * of this file, which asserts that separately.
 */
const POSIX = { platform: "darwin" } as const;

describe("suspending an encode instead of losing it", () => {
  it("reports the current state to a listener as it subscribes", () => {
    const controller = createPauseController(true);
    const seen: boolean[] = [];
    controller.subscribe((paused) => seen.push(paused));
    // An encoder that starts while the queue is already paused has to suspend
    // itself, not run until something else changes.
    expect(seen).toEqual([true]);
  });

  it("signals a child to stop and continue", () => {
    const kill = vi.fn();
    const controller = createPauseController();
    bindChildToPauseController({ pid: 42, kill }, controller, POSIX);

    controller.pause();
    controller.resume();

    expect(kill.mock.calls.map(([signal]) => signal)).toEqual([
      "SIGCONT",
      "SIGSTOP",
      "SIGCONT",
    ]);
  });

  it("does nothing when asked to repeat a state", () => {
    const kill = vi.fn();
    const controller = createPauseController();
    bindChildToPauseController({ pid: 42, kill }, controller, POSIX);
    kill.mockClear();

    controller.resume();
    controller.pause();
    controller.pause();

    expect(kill.mock.calls.map(([signal]) => signal)).toEqual(["SIGSTOP"]);
  });

  /** A child that exited between the request and its delivery is a race, not a fault. */
  it("survives signalling a process that has already exited", () => {
    const controller = createPauseController();
    bindChildToPauseController(
      {
        pid: 42,
        kill: () => {
          throw new Error("ESRCH");
        },
      },
      controller,
      POSIX,
    );

    expect(() => controller.pause()).not.toThrow();
  });

  it("keeps signalling the remaining children when one throws", () => {
    const healthy = vi.fn();
    const controller = createPauseController();
    bindChildToPauseController(
      {
        pid: 1,
        kill: () => {
          throw new Error("ESRCH");
        },
      },
      controller,
      POSIX,
    );
    bindChildToPauseController({ pid: 2, kill: healthy }, controller, POSIX);
    healthy.mockClear();

    controller.pause();

    expect(healthy).toHaveBeenCalledWith("SIGSTOP");
  });
});

describe("noticing the media volume come and go", () => {
  it("reports a loss once, not on every poll", async () => {
    const onLost = vi.fn();
    const onRestored = vi.fn();
    const watchdog = createStorageWatchdog({
      mediaRoot: "/Volumes/Expansion/media",
      check: async () => false,
      onLost,
      onRestored,
    });

    await watchdog.poll();
    await watchdog.poll();

    expect(onLost).toHaveBeenCalledTimes(1);
    expect(onRestored).not.toHaveBeenCalled();
    expect(watchdog.available).toBe(false);
  });

  it("reports the volume returning", async () => {
    let present = false;
    const onRestored = vi.fn();
    const watchdog = createStorageWatchdog({
      mediaRoot: "/Volumes/Expansion/media",
      check: async () => present,
      onRestored,
    });

    await watchdog.poll();
    present = true;
    await watchdog.poll();

    expect(onRestored).toHaveBeenCalledTimes(1);
    expect(watchdog.available).toBe(true);
  });

  /**
   * A server restart must not pause a healthy queue for one interval while the
   * first check completes.
   */
  it("assumes the volume is there until a check says otherwise", () => {
    const watchdog = createStorageWatchdog({
      mediaRoot: "/Volumes/Expansion/media",
      check: async () => false,
    });

    expect(watchdog.available).toBe(true);
  });

  it("does not let a slow check overlap itself", async () => {
    let calls = 0;
    const watchdog = createStorageWatchdog({
      mediaRoot: "/Volumes/Expansion/media",
      check: async () => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return true;
      },
    });

    await Promise.all([watchdog.poll(), watchdog.poll(), watchdog.poll()]);

    expect(calls).toBe(1);
  });
});

/**
 * The platform that cannot suspend anything.
 *
 * Windows has no `SIGSTOP`. The old binding subscribed anyway, `process.kill`
 * threw `ERR_UNKNOWN_SIGNAL`, the `catch` swallowed it, and the controller went
 * on reporting `paused: true` over an encoder running at full speed. A pause
 * nobody can honour has to be visible, because the thing an operator does after
 * pausing is unplug the drive.
 */
describe("a platform with no suspend", () => {
  it("refuses to bind, says why, and sends nothing", () => {
    const controller = createPauseController();
    const sent: NodeJS.Signals[] = [];
    const reasons: string[] = [];

    const unsubscribe = bindChildToPauseController(
      {
        pid: 4242,
        kill: (signal) => {
          sent.push(signal);
          return true;
        },
      },
      controller,
      { platform: "win32", onUnsupported: (reason) => reasons.push(reason) },
    );

    controller.pause();
    controller.resume();

    expect(sent).toEqual([]);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toMatch(/cannot be paused/i);
    expect(() => unsubscribe()).not.toThrow();
  });

  it("still suspends where the platform has the signals", () => {
    const controller = createPauseController();
    const sent: NodeJS.Signals[] = [];
    const reasons: string[] = [];

    bindChildToPauseController(
      {
        pid: 4242,
        kill: (signal) => {
          sent.push(signal);
          return true;
        },
      },
      controller,
      { platform: "darwin", onUnsupported: (reason) => reasons.push(reason) },
    );

    controller.pause();
    controller.resume();

    expect(sent).toEqual(["SIGCONT", "SIGSTOP", "SIGCONT"]);
    expect(reasons).toEqual([]);
  });
});
