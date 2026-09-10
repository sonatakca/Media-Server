/**
 * Suspending an encode without losing it, and only saying so when it is true.
 *
 * Cancelling an encode throws away everything it has done; for a two-hour 4K
 * ladder that is hours of work. A pause instead stops the encoder where it
 * stands and lets it pick up again, so the process keeps its memory, its open
 * files and its position in the source.
 *
 * The limits are worth stating plainly, because they decide what callers may
 * promise:
 *
 * - A paused encoder still holds its file descriptors. That is what makes the
 *   resume seamless, and it is also why a pause cannot rescue an encode whose
 *   storage has been unmounted — those descriptors are already invalid, and no
 *   suspension makes them valid again. Storage that disappears costs the
 *   in-flight title its progress no matter what; what pausing buys there is
 *   that the *queue* stops rather than burning through every remaining title
 *   against a drive that is not there.
 * - The process stays resident while paused. It holds its memory and its
 *   temporary files, so a pause is a pause, not a way to free the machine.
 *
 * ## Why this is asynchronous
 *
 * The previous controller flipped a boolean and told everyone. That is fine
 * when suspending is a signal — `SIGSTOP` either arrives or the process is
 * already dead — and it is a lie everywhere else. On Windows suspension is a
 * handle, two ntdll calls and a read-back of the thread states, all of it in a
 * short-lived helper process; it takes a moment, and it can fail. A controller
 * that reports `paused` before that finishes hands the rest of the system a
 * claim it has not earned:
 *
 * - the watchdog stops treating a running encoder as one that can stall;
 * - the queue writes `state = "paused"` into the database;
 * - the page tells an operator the encoder is stopped;
 * - the encoder keeps reading the disk they are about to unplug.
 *
 * So `paused` here means one thing and nothing weaker: **every encoder bound to
 * this controller is confirmed stopped by the operating system, or gone.** It
 * is not the operator's intent — that is `pauseRequested`, which changes
 * immediately and is worth nothing to the watchdog. Between the two lives the
 * transition, which callers may show as "Pausing…" and must not show as
 * "Paused".
 */

import {
  suspendWindowsProcess,
  type WindowsProcessSuspender,
} from "./windowsProcessSuspend";

/** The outcome of asking the operating system to change a process's state. */
export type PauseTransition =
  | { ok: true }
  | {
      ok: false;
      /** Safe for an operator's screen: never a path, never raw stderr. */
      reason: string;
    };

/**
 * One encoder, from the controller's point of view.
 *
 * Implemented per platform by `bindChildToPauseController`. Deliberately narrow:
 * the controller sequences transitions and owns what `paused` means, and knows
 * nothing about signals, handles or process groups.
 */
export interface EncoderSuspender {
  /** What this suspends, for a failure message. Never a path. */
  readonly describe: string;
  /**
   * Brings the process to `paused`. Resolves with what actually happened.
   *
   * `gone` means the process no longer exists. That is a success — it is
   * certainly not encoding — and it retires this suspender from the count.
   */
  apply(
    paused: boolean,
  ): Promise<{ ok: true; gone?: boolean } | { ok: false; reason: string }>;
}

export interface PauseController {
  /**
   * Confirmed stopped by the operating system.
   *
   * True only when every bound encoder is suspended or gone. With nothing bound
   * it falls back to the intent, which is the honest answer for a job that is
   * paused between epochs or before its first FFmpeg has started: there is no
   * process, so there is nothing running.
   *
   * This is the property the watchdog and the durable `state = "paused"` are
   * allowed to read. Nothing else is.
   */
  readonly paused: boolean;
  /** What was asked for. Changes immediately; means nothing about the process. */
  readonly pauseRequested: boolean;
  /**
   * Suspends, and reports whether the operating system agreed.
   *
   * Idempotent, and serialised against every other transition on this
   * controller: a rapid Pause → Continue → Pause cannot put two suspend
   * operations on the same process at once. A failure leaves the encoder
   * running and the intent cleared — a pause that did not happen is not
   * allowed to look like one that did.
   */
  pause(): Promise<PauseTransition>;
  /**
   * Resumes, and reports whether the operating system agreed.
   *
   * A failure leaves the controller reporting `paused`, because the process is
   * still suspended and pretending otherwise would put the watchdog back on a
   * process that cannot answer it.
   */
  resume(): Promise<PauseTransition>;
  /**
   * Registers an encoder and brings it to the current intent.
   *
   * A process that starts while the queue is already paused suspends itself
   * rather than running until the next change — but only once the operating
   * system says so, which is why this returns after queueing the transition
   * and `paused` stays false until it lands.
   */
  bind(suspender: EncoderSuspender): () => void;
  /** Resolves when no transition is in flight. For tests and for shutdown. */
  settled(): Promise<void>;
}

export function createPauseController(
  initiallyPaused = false,
): PauseController {
  /** What was asked for. */
  let desired = initiallyPaused;
  /**
   * Every bound encoder and where it actually is.
   *
   * `at` is what the operating system last confirmed, never what was asked.
   * `gone` retires a process that has exited: it stops counting towards
   * `paused` without pretending it was suspended.
   */
  const bound = new Map<EncoderSuspender, { at: boolean; gone: boolean }>();

  /** One at a time. Every transition appends to this. */
  let chain: Promise<unknown> = Promise.resolve();

  const isPaused = (): boolean => {
    let live = false;
    for (const state of bound.values()) {
      if (state.gone) continue;
      live = true;
      if (!state.at) return false;
    }
    /*
     * Nothing live to suspend. The intent is then the whole answer: a job
     * paused between two epochs, or before its first encoder started, is
     * genuinely paused and needs no system call to be so.
     */
    return live || desired;
  };

  /**
   * Brings every bound encoder to one target, and reports the first refusal.
   *
   * The target is the caller's, captured when the transition was requested, and
   * is deliberately *not* re-read from `desired` part way through. Every change
   * of intent queues its own pass behind this one, so a Continue landing during
   * a Pause is honoured by the next pass rather than by quietly changing what
   * this one was asked to do — which is the difference between each press
   * getting an honest answer and a failed pause being reported as a success
   * because something else moved the goalposts.
   *
   * Rolls back on a failed *pause*: anything suspended in this pass is resumed
   * again and the intent is dropped, so a partial failure across two children
   * cannot leave half an encode stopped while the queue is told nothing
   * happened. A failed *resume* is not rolled back — re-suspending a process
   * the operator asked to continue would be the wrong direction, and the
   * controller reporting `paused` is already the truth about it.
   */
  const reconcileTo = async (target: boolean): Promise<PauseTransition> => {
    const applied: EncoderSuspender[] = [];

    for (const [suspender, state] of bound) {
      if (state.gone || state.at === target) continue;
      const outcome = await suspender.apply(target);
      if (!outcome.ok) {
        if (target) {
          for (const done of applied) {
            const undo = await done.apply(false);
            const doneState = bound.get(done);
            if (doneState && undo.ok) {
              doneState.at = false;
              if (undo.gone) doneState.gone = true;
            }
          }
          /*
           * The intent goes back too — unless something newer has already moved
           * it, in which case that newer intent owns it and has its own pass
           * queued behind this one. Leaving a failed intent standing would have
           * the next tick try again for ever against a process that has already
           * refused, and would leave `pauseRequested` claiming an operator is
           * waiting for something that is not coming.
           */
          if (desired === target) desired = false;
        }
        return {
          ok: false,
          reason: `${suspender.describe} ${outcome.reason}`,
        };
      }
      const current = bound.get(suspender);
      if (current) {
        current.at = target;
        if (outcome.gone) current.gone = true;
      }
      if (target) applied.push(suspender);
    }

    return { ok: true };
  };

  const enqueue = (
    task: () => Promise<PauseTransition>,
  ): Promise<PauseTransition> => {
    const next = chain.then(task, task);
    // The tail never carries a rejection forward: a transition that threw must
    // not poison every transition after it.
    chain = next.catch(() => undefined);
    return next;
  };

  const request = (target: boolean): Promise<PauseTransition> => {
    desired = target;
    return enqueue(() => reconcileTo(target));
  };

  return {
    get paused() {
      return isPaused();
    },
    get pauseRequested() {
      return desired;
    },
    pause() {
      return request(true);
    },
    resume() {
      return request(false);
    },
    bind(suspender) {
      bound.set(suspender, { at: false, gone: false });
      /*
       * Only when there is something to do. An encoder spawned while the queue
       * is already held has to suspend itself rather than run until the next
       * change; one spawned into a running queue needs no system call at all,
       * and queueing a pass for it would put a second claim on an intent that
       * a pending `pause()` already owns.
       *
       * Queued rather than awaited: binding happens on the spawn path, and an
       * encoder that has to wait for a helper process before it exists is an
       * encoder that starts seconds late on every single epoch.
       */
      if (desired) void enqueue(() => reconcileTo(true));
      return () => {
        /*
         * Retired rather than left behind. A child that has exited is no longer
         * evidence of anything, and a suspender kept in the map with `at: true`
         * would hold the whole controller in `paused` for ever.
         */
        bound.delete(suspender);
      };
    },
    async settled() {
      await chain;
    },
  };
}

/* ----------------------------------------------------------- the two platforms */

/** Signals this platform uses to stop and start a process where it stands. */
type SignalChild = {
  pid?: number | undefined;
  kill(signal: NodeJS.Signals): boolean;
};

/**
 * Keeps a spawned child suspended in step with a controller.
 *
 * Returns an unbind function; calling it retires the child from the
 * controller's count, which is what a caller does once the process has been
 * reaped.
 *
 * The two platforms are genuinely different operations and are kept apart:
 *
 * - **POSIX** sends `SIGSTOP` and `SIGCONT`, to the process group first so an
 *   encoder that spawned a helper does not leave it reading the very source the
 *   pause was for. It is synchronous and it either lands or the process is
 *   gone; `kill` returning false is read as gone, which is what a child that
 *   exited between the request and its delivery is.
 * - **Windows** has no such signal and never will. It goes out to
 *   `windowsProcessSuspend.ts`, which opens a handle, calls `NtSuspendProcess`
 *   or `NtResumeProcess`, and reads the thread states back before agreeing that
 *   anything happened.
 */
export function bindChildToPauseController(
  child: SignalChild,
  controller: PauseController,
  options: {
    /** Injected by tests; defaults to this host. */
    platform?: NodeJS.Platform;
    /** Injected by tests; defaults to the real ntdll helper. */
    suspendWindows?: WindowsProcessSuspender;
    /**
     * What the caller believes this pid is — `ffmpeg`, in practice.
     *
     * Passed through to the Windows helper, which refuses to act on a pid whose
     * image disagrees. Windows recycles pids quickly, and a suspend aimed at a
     * recycled one freezes an arbitrary process on the machine.
     */
    imageName?: string;
    /** True while the process is being stopped; nothing may suspend it then. */
    isAborting?: () => boolean;
  } = {},
): () => void {
  const platform = options.platform ?? process.platform;
  const suspender: EncoderSuspender =
    platform === "win32"
      ? windowsSuspender(child, options)
      : posixSuspender(child);
  return controller.bind(suspender);
}

function posixSuspender(child: SignalChild): EncoderSuspender {
  return {
    describe: "The encoder could not be suspended:",
    apply: async (paused) => {
      const pid = child.pid;
      if (pid === undefined) return { ok: true, gone: true };
      /*
       * `kill` here is the caller's, and it is the caller that decides whether
       * the group or the leaf is addressed. False means nothing took it, which
       * on POSIX is `ESRCH` and means the process has gone.
       */
      let delivered: boolean;
      try {
        delivered = child.kill(paused ? "SIGSTOP" : "SIGCONT");
      } catch {
        delivered = false;
      }
      return delivered ? { ok: true } : { ok: true, gone: true };
    },
  };
}

function windowsSuspender(
  child: SignalChild,
  options: {
    suspendWindows?: WindowsProcessSuspender;
    imageName?: string;
    isAborting?: () => boolean;
  },
): EncoderSuspender {
  const suspend = options.suspendWindows ?? suspendWindowsProcess;
  return {
    describe: "The encoder could not be suspended:",
    apply: async (paused) => {
      const pid = child.pid;
      if (pid === undefined) return { ok: true, gone: true };
      /*
       * A process that is already being stopped must not be suspended on the
       * way out. It is not going to be resumed by anybody, the grace period it
       * was given cannot be spent by a process that is not scheduled, and the
       * queue would be told it is paused when it is dying.
       *
       * Resuming an aborting process is exactly what *should* still happen, so
       * only the suspend direction is refused.
       */
      if (paused && options.isAborting?.()) {
        return { ok: false, reason: "it is being stopped." };
      }
      const result = await suspend(
        paused ? "suspend" : "resume",
        pid,
        options.imageName,
      );
      if (result.ok)
        return result.gone ? { ok: true, gone: true } : { ok: true };
      return { ok: false, reason: result.detail };
    },
  };
}
