import { describe, expect, it, vi } from "vitest";
import {
  bindChildToPauseController,
  createPauseController,
  type EncoderSuspender,
} from "./pauseController";
import type {
  WindowsProcessSuspender,
  WindowsSuspendResult,
} from "./windowsProcessSuspend";
import { createStorageWatchdog } from "./storageWatchdog";

/**
 * These cases drive the bindings with a fake child, so the platform has to be
 * stated rather than inherited from whichever machine runs them. That is the
 * only way the Windows path in this project has ever been kept honest: it is
 * developed on a Mac and it runs on a Windows server.
 */
const POSIX = { platform: "darwin" } as const;

/** A Windows suspender that always agrees, and records what it was asked. */
function agreeableWindows(): {
  suspend: WindowsProcessSuspender;
  calls: { action: string; pid: number; imageName?: string }[];
} {
  const calls: { action: string; pid: number; imageName?: string }[] = [];
  return {
    calls,
    suspend: async (action, pid, imageName) => {
      calls.push({ action, pid, ...(imageName ? { imageName } : {}) });
      return { ok: true, gone: false };
    },
  };
}

/** A suspender whose answers a test scripts one at a time. */
function scriptedWindows(answers: WindowsSuspendResult[]): {
  suspend: WindowsProcessSuspender;
  calls: string[];
} {
  const calls: string[] = [];
  let index = 0;
  return {
    calls,
    suspend: async (action) => {
      calls.push(action);
      return answers[index++] ?? { ok: true, gone: false };
    },
  };
}

const windowsChild = { pid: 4242, kill: () => true };

describe("what `paused` is allowed to mean", () => {
  /**
   * The bug this whole redesign exists for.
   *
   * The old controller flipped a boolean, and on Windows nothing behind that
   * boolean ever suspended anything: the queue wrote `paused`, the watchdog
   * stood down, and FFmpeg carried on writing to the disk an operator was about
   * to unplug. `paused` now means the operating system has confirmed it, and
   * a request on its own must never be enough.
   */
  it("does not report paused while the suspension is still in flight", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const controller = createPauseController();
    bindChildToPauseController(windowsChild, controller, {
      platform: "win32",
      suspendWindows: async () => {
        await gate;
        return { ok: true, gone: false };
      },
    });

    const pausing = controller.pause();
    // The intent is immediate and worth nothing on its own.
    expect(controller.pauseRequested).toBe(true);
    expect(controller.paused).toBe(false);

    release?.();
    await expect(pausing).resolves.toEqual({ ok: true });
    expect(controller.paused).toBe(true);
  });

  it("reports paused when the operating system confirms it", async () => {
    const windows = agreeableWindows();
    const controller = createPauseController();
    bindChildToPauseController(windowsChild, controller, {
      platform: "win32",
      suspendWindows: windows.suspend,
      imageName: "ffmpeg.exe",
    });

    await expect(controller.pause()).resolves.toEqual({ ok: true });

    expect(controller.paused).toBe(true);
    expect(windows.calls).toEqual([
      { action: "suspend", pid: 4242, imageName: "ffmpeg.exe" },
    ]);
  });

  it("keeps reporting running when the suspension fails", async () => {
    const windows = scriptedWindows([
      {
        ok: false,
        failure: "access-denied",
        detail: "the handle was refused.",
      },
    ]);
    const controller = createPauseController();
    bindChildToPauseController(windowsChild, controller, {
      platform: "win32",
      suspendWindows: windows.suspend,
    });

    const transition = await controller.pause();

    expect(transition.ok).toBe(false);
    expect(transition).toMatchObject({ reason: /refused/ as never });
    // Not paused, and no longer even claiming to be trying: an intent that
    // cannot be honoured is not left standing.
    expect(controller.paused).toBe(false);
    expect(controller.pauseRequested).toBe(false);
  });

  it("keeps reporting paused when the resume fails", async () => {
    const windows = scriptedWindows([
      { ok: true, gone: false },
      { ok: false, failure: "nt-failed", detail: "the resume was refused." },
    ]);
    const controller = createPauseController();
    bindChildToPauseController(windowsChild, controller, {
      platform: "win32",
      suspendWindows: windows.suspend,
    });

    await controller.pause();
    const transition = await controller.resume();

    expect(transition.ok).toBe(false);
    /*
     * The process is still frozen. Saying "running" here would put the media
     * watchdog back on a process that cannot answer it, and would tell an
     * operator the encode had picked up when it had not.
     */
    expect(controller.paused).toBe(true);
  });

  it("is paused with nothing bound, because nothing is running", async () => {
    // A job held between two epochs, or before its first encoder started. There
    // is no process, so there is nothing to suspend and nothing encoding.
    const controller = createPauseController();
    await controller.pause();
    expect(controller.paused).toBe(true);
  });

  it("stops claiming paused once the encoder it suspended is gone", async () => {
    const windows = agreeableWindows();
    const controller = createPauseController();
    const unbind = bindChildToPauseController(windowsChild, controller, {
      platform: "win32",
      suspendWindows: windows.suspend,
    });

    await controller.pause();
    expect(controller.paused).toBe(true);

    // The encoder was reaped and the caller unbound it. The intent survives —
    // the job is still held — and it is the intent that answers now.
    unbind();
    expect(controller.paused).toBe(true);
    await controller.resume();
    expect(controller.paused).toBe(false);
  });

  it("treats a process that has already exited as suspended enough", async () => {
    const controller = createPauseController();
    bindChildToPauseController(windowsChild, controller, {
      platform: "win32",
      suspendWindows: async () => ({ ok: true, gone: true }),
    });

    await expect(controller.pause()).resolves.toEqual({ ok: true });
    expect(controller.paused).toBe(true);
  });

  it("refuses to suspend an encoder that is being stopped", async () => {
    const windows = agreeableWindows();
    const controller = createPauseController();
    bindChildToPauseController(windowsChild, controller, {
      platform: "win32",
      suspendWindows: windows.suspend,
      isAborting: () => true,
    });

    const transition = await controller.pause();

    expect(transition.ok).toBe(false);
    expect(controller.paused).toBe(false);
    // Nothing was sent. A process on its way out must not be frozen on the way.
    expect(windows.calls).toEqual([]);
  });

  it("still resumes an encoder that is being stopped", async () => {
    /*
     * The abort ordering the whole cancellation path depends on. Suspending a
     * dying process is refused above; letting go of one is exactly what has to
     * keep working, or a cancelled encode is a frozen orphan.
     */
    let aborting = false;
    const windows = agreeableWindows();
    const controller = createPauseController();
    bindChildToPauseController(windowsChild, controller, {
      platform: "win32",
      suspendWindows: windows.suspend,
      isAborting: () => aborting,
    });

    await controller.pause();
    aborting = true;
    await expect(controller.resume()).resolves.toEqual({ ok: true });

    expect(windows.calls.map((call) => call.action)).toEqual([
      "suspend",
      "resume",
    ]);
  });
});

describe("one transition at a time", () => {
  it("does not run two operations against one process at once", async () => {
    let inFlight = 0;
    let overlapped = false;
    const order: string[] = [];
    const controller = createPauseController();
    bindChildToPauseController(windowsChild, controller, {
      platform: "win32",
      suspendWindows: async (action) => {
        inFlight += 1;
        if (inFlight > 1) overlapped = true;
        order.push(action);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return { ok: true, gone: false };
      },
    });

    // Pause → Continue → Pause, as fast as a person can press it.
    const first = controller.pause();
    const second = controller.resume();
    const third = controller.pause();
    await Promise.all([first, second, third]);

    expect(overlapped).toBe(false);
    // And the last press is the one the process ends up at.
    expect(controller.paused).toBe(true);
    expect(order.at(-1)).toBe("suspend");
  });

  it("does nothing when asked to repeat a pause", async () => {
    const windows = agreeableWindows();
    const controller = createPauseController();
    bindChildToPauseController(windowsChild, controller, {
      platform: "win32",
      suspendWindows: windows.suspend,
    });

    await controller.pause();
    await controller.pause();
    await controller.pause();

    expect(windows.calls.map((call) => call.action)).toEqual(["suspend"]);
    expect(controller.paused).toBe(true);
  });

  it("does nothing when asked to repeat a resume", async () => {
    const windows = agreeableWindows();
    const controller = createPauseController();
    bindChildToPauseController(windowsChild, controller, {
      platform: "win32",
      suspendWindows: windows.suspend,
    });

    await controller.pause();
    await controller.resume();
    await controller.resume();

    expect(windows.calls.map((call) => call.action)).toEqual([
      "suspend",
      "resume",
    ]);
    expect(controller.paused).toBe(false);
  });

  it("suspends an encoder that starts while the queue is already paused", async () => {
    const windows = agreeableWindows();
    const controller = createPauseController(true);

    bindChildToPauseController(windowsChild, controller, {
      platform: "win32",
      suspendWindows: windows.suspend,
    });
    // Binding queues the transition rather than awaiting it, because spawning
    // an encoder must not wait on a helper process. Until it lands the encoder
    // is running, and the controller says so.
    expect(controller.paused).toBe(false);

    await controller.settled();

    expect(controller.paused).toBe(true);
    expect(windows.calls.map((call) => call.action)).toEqual(["suspend"]);
  });

  it("rolls a partial failure back rather than leaving half an encode stopped", async () => {
    const first = agreeableWindows();
    const controller = createPauseController();
    bindChildToPauseController({ pid: 11, kill: () => true }, controller, {
      platform: "win32",
      suspendWindows: first.suspend,
    });
    bindChildToPauseController({ pid: 12, kill: () => true }, controller, {
      platform: "win32",
      suspendWindows: async () => ({
        ok: false,
        failure: "access-denied",
        detail: "the handle was refused.",
      }),
    });

    const transition = await controller.pause();

    expect(transition.ok).toBe(false);
    expect(controller.paused).toBe(false);
    // The one that did suspend was put back, so the caller's "nothing happened"
    // is true of the whole encode rather than of half of it.
    expect(first.calls.map((call) => call.action)).toEqual([
      "suspend",
      "resume",
    ]);
  });
});

describe("the POSIX signals, unchanged", () => {
  it("signals a child to stop and continue", async () => {
    const kill = vi.fn((_signal: NodeJS.Signals) => true);
    const controller = createPauseController();
    bindChildToPauseController({ pid: 42, kill }, controller, POSIX);

    await controller.pause();
    await controller.resume();

    expect(kill.mock.calls.map(([signal]) => signal)).toEqual([
      "SIGSTOP",
      "SIGCONT",
    ]);
  });

  it("does nothing when asked to repeat a state", async () => {
    const kill = vi.fn((_signal: NodeJS.Signals) => true);
    const controller = createPauseController();
    bindChildToPauseController({ pid: 42, kill }, controller, POSIX);

    await controller.resume();
    await controller.pause();
    await controller.pause();

    expect(kill.mock.calls.map(([signal]) => signal)).toEqual(["SIGSTOP"]);
  });

  /** A child that exited between the request and its delivery is a race, not a fault. */
  it("survives signalling a process that has already exited", async () => {
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

    await expect(controller.pause()).resolves.toEqual({ ok: true });
    // Gone is not running, so the pause is honest — and it is not evidence of
    // a suspension either, which is why the process is retired from the count.
    expect(controller.paused).toBe(true);
  });

  it("keeps signalling the remaining children when one has gone", async () => {
    const healthy = vi.fn(() => true);
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

    await controller.pause();

    expect(healthy).toHaveBeenCalledWith("SIGSTOP");
  });

  it("does not reach for the Windows helper on POSIX", async () => {
    const suspendWindows = vi.fn();
    const controller = createPauseController();
    bindChildToPauseController({ pid: 42, kill: () => true }, controller, {
      platform: "darwin",
      suspendWindows: suspendWindows as never,
    });

    await controller.pause();

    expect(suspendWindows).not.toHaveBeenCalled();
  });
});

describe("a controller with no child at all", () => {
  it("lets a suspender retire itself without stranding the controller", async () => {
    const controller = createPauseController();
    const suspender: EncoderSuspender = {
      describe: "The encoder could not be suspended:",
      apply: async () => ({ ok: true }),
    };
    const unbind = controller.bind(suspender);
    await controller.pause();
    expect(controller.paused).toBe(true);
    unbind();
    await controller.resume();
    expect(controller.paused).toBe(false);
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
 * The platform that has no signal for this.
 *
 * Windows has no `SIGSTOP`. The original binding subscribed anyway,
 * `process.kill` threw `ERR_UNKNOWN_SIGNAL`, a `catch` swallowed it, and the
 * controller reported `paused: true` over an encoder running at full speed. The
 * binding after that refused to install at all and said so, which was honest
 * and still left the platform unable to pause anything. This is the third
 * answer: the operation Windows actually has, through ntdll, acknowledged
 * before anything is claimed.
 */
describe("Windows, using the operation the platform really has", () => {
  it("names the image so a recycled pid cannot be frozen by mistake", async () => {
    const windows = agreeableWindows();
    const controller = createPauseController();
    bindChildToPauseController({ pid: 11396, kill: () => true }, controller, {
      platform: "win32",
      suspendWindows: windows.suspend,
      imageName: "ffmpeg.exe",
    });

    await controller.pause();
    await controller.resume();

    expect(windows.calls).toEqual([
      { action: "suspend", pid: 11396, imageName: "ffmpeg.exe" },
      { action: "resume", pid: 11396, imageName: "ffmpeg.exe" },
    ]);
  });

  it("carries the helper's own words out to the caller", async () => {
    const controller = createPauseController();
    bindChildToPauseController(windowsChild, controller, {
      platform: "win32",
      suspendWindows: async () => ({
        ok: false,
        failure: "helper-missing",
        detail: "The process-suspend helper is missing from this installation.",
      }),
    });

    const transition = await controller.pause();

    expect(transition.ok).toBe(false);
    expect(!transition.ok && transition.reason).toMatch(/helper is missing/i);
  });

  it("does nothing at all for a child with no pid", async () => {
    const suspendWindows = vi.fn();
    const controller = createPauseController();
    bindChildToPauseController({ kill: () => true }, controller, {
      platform: "win32",
      suspendWindows: suspendWindows as never,
    });

    await expect(controller.pause()).resolves.toEqual({ ok: true });
    expect(suspendWindows).not.toHaveBeenCalled();
  });
});
