/**
 * Startup, as something that can be watched rather than waited on.
 *
 * The state machine in `startupState.ts` holds *what* startup is doing. This
 * holds *how long it has been doing it*, which is the half that was missing on
 * the day the media volume stopped answering: the phase was knowable the whole
 * time, and nothing was arranged to say so.
 *
 * One mechanism does all of it. Entering a phase arms three timers — a slow
 * warning, a bounded "still waiting" repeat, and a degrade deadline — and
 * settling the phase disarms them. There is no per-call timer anywhere else in
 * the startup path, and nothing here touches the filesystem, the database or
 * the process: the cost of observing a phase is three `setTimeout`s.
 *
 * The degrade deadline deserves its own sentence, because it is the one part
 * that is easy to make dishonest. It moves the phase out of the readiness
 * calculation. It does **not** cancel the work. A libuv `stat()` blocked in the
 * kernel cannot be cancelled from JavaScript, and pretending otherwise is how
 * you end up with a process that reports a timeout while a worker thread is
 * still gone. So the phase says "degraded", the operation carries on, and if
 * the volume answers at minute four the phase completes and startup continues
 * from where it was.
 */

import {
  createStartupState,
  type StartupPhaseId,
  type StartupPhasePatch,
  type StartupPhaseSnapshot,
  type StartupSnapshot,
  type StartupStateMachine,
} from "./startupState";

/** Long enough that a warm start never mentions it; short enough to notice. */
export const STARTUP_SLOW_WARNING_MS = 5_000;

/**
 * How often a phase that is still running repeats itself.
 *
 * Deliberately coarse. The log this lands in was already tens of megabytes of
 * request lines, and a startup that waits an hour should cost it 120 lines, not
 * 36,000.
 */
export const STARTUP_STILL_WAITING_INTERVAL_MS = 30_000;

/**
 * When a phase stops counting towards readiness.
 *
 * A minute, not the five seconds a naive timeout would use. An external drive
 * that has spun down takes tens of seconds to answer its first `stat`, and a
 * server that declared itself broken over that would be trading a rare nine
 * minute stall for a routine daily one.
 */
export const STARTUP_DEGRADE_AFTER_MS = 60_000;

export interface StartupStepSpec {
  id: StartupPhaseId;
  /** The specific call being awaited: `stat`, `realpath`, `listen`, `connect`. */
  operation?: string;
  /** The path, port or database being waited on. Never served publicly. */
  resource?: string;
  detail?: string;
  slowAfterMs?: number;
  stillWaitingEveryMs?: number;
  /** Null keeps the phase `running` however long it takes to answer. */
  degradeAfterMs?: number | null;
}

export interface StartupStepContext {
  /** Amends the phase while it runs: attempt counts, real progress, operation. */
  update(patch: StartupPhasePatch): void;
  signal: AbortSignal | undefined;
}

/**
 * Where the phase events go.
 *
 * Separated from the coordinator so the presentation — a terminal, a log line,
 * a test's array — is a choice made once at the edge rather than a `console`
 * call buried in the startup path.
 */
export interface StartupObserver {
  began?(phase: StartupPhaseSnapshot): void;
  slow?(phase: StartupPhaseSnapshot): void;
  waiting?(phase: StartupPhaseSnapshot): void;
  degraded?(phase: StartupPhaseSnapshot): void;
  settled?(phase: StartupPhaseSnapshot): void;
  live?(snapshot: StartupSnapshot): void;
  finished?(snapshot: StartupSnapshot): void;
}

type TimerHandle = unknown;

export interface StartupTimers {
  setTimeout(callback: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
  setInterval(callback: () => void, ms: number): TimerHandle;
  clearInterval(handle: TimerHandle): void;
}

/*
 * Unref'd, every one of them.
 *
 * These timers exist to describe a wait, and a description must never be the
 * reason a process stays alive. Without this a startup abandoned half-way —
 * SIGTERM during the storage phase — would keep the event loop busy with its
 * own progress reports.
 */
const defaultTimers: StartupTimers = {
  setTimeout: (callback, ms) => {
    const handle = setTimeout(callback, ms);
    (handle as { unref?: () => void }).unref?.();
    return handle;
  },
  clearTimeout: (handle) =>
    clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval: (callback, ms) => {
    const handle = setInterval(callback, ms);
    (handle as { unref?: () => void }).unref?.();
    return handle;
  },
  clearInterval: (handle) =>
    clearInterval(handle as ReturnType<typeof setInterval>),
};

export interface StartupCoordinator {
  /** The listener is bound. Liveness is this and nothing else. */
  markLive(): void;
  /** Enters a phase and arms its timers. Safe to call again to retry one. */
  begin(spec: StartupStepSpec): void;
  update(id: StartupPhaseId, patch: StartupPhasePatch): void;
  complete(id: StartupPhaseId): void;
  fail(id: StartupPhaseId, error: unknown): void;
  /**
   * Fails whichever phases are still open.
   *
   * For the case where a span covers several phases — `createNativeRuntime`
   * owns both `database` and `processing` — and the caller knows only that it
   * threw, not which half it was in.
   */
  failRunning(error: unknown): void;
  run<T>(
    spec: StartupStepSpec,
    work: (context: StartupStepContext) => Promise<T>,
  ): Promise<T>;
  snapshot(): StartupSnapshot;
  /** Emits the closing summary. Called once startup can go no further. */
  finish(): void;
  /** Shutdown began; readiness is pinned false and every timer goes. */
  stop(): void;
  readonly stopping: boolean;
  dispose(): void;
}

/**
 * The narrow view handed to code that owns a phase but should not own startup.
 *
 * `createNativeRuntime` reports the `database` and `processing` phases from
 * inside itself, because only it knows where one ends and the other begins. It
 * has no business being able to declare the server ready.
 */
export interface StartupPhaseReporter {
  begin(spec: StartupStepSpec): void;
  update(id: StartupPhaseId, patch: StartupPhasePatch): void;
  complete(id: StartupPhaseId): void;
}

interface ArmedTimers {
  slow?: TimerHandle;
  waiting?: TimerHandle;
  degrade?: TimerHandle;
}

export function createStartupCoordinator({
  state = createStartupState(),
  observer = {},
  timers = defaultTimers,
  signal,
}: {
  state?: StartupStateMachine;
  observer?: StartupObserver;
  timers?: StartupTimers;
  signal?: AbortSignal;
} = {}): StartupCoordinator {
  const armed = new Map<StartupPhaseId, ArmedTimers>();
  let finished = false;

  const phaseOf = (id: StartupPhaseId): StartupPhaseSnapshot | undefined =>
    state.snapshot().phases.find((phase) => phase.id === id);

  const notify = (
    id: StartupPhaseId,
    event: keyof Omit<StartupObserver, "live" | "finished">,
  ): void => {
    const phase = phaseOf(id);
    if (phase) observer[event]?.(phase);
  };

  const disarm = (id: StartupPhaseId): void => {
    const handles = armed.get(id);
    if (!handles) return;
    if (handles.slow !== undefined) timers.clearTimeout(handles.slow);
    if (handles.waiting !== undefined) timers.clearInterval(handles.waiting);
    if (handles.degrade !== undefined) timers.clearTimeout(handles.degrade);
    armed.delete(id);
  };

  const arm = (spec: StartupStepSpec): void => {
    disarm(spec.id);
    const handles: ArmedTimers = {};
    const slowAfterMs = spec.slowAfterMs ?? STARTUP_SLOW_WARNING_MS;
    const stillWaitingEveryMs =
      spec.stillWaitingEveryMs ?? STARTUP_STILL_WAITING_INTERVAL_MS;
    const degradeAfterMs =
      spec.degradeAfterMs === undefined
        ? STARTUP_DEGRADE_AFTER_MS
        : spec.degradeAfterMs;

    if (slowAfterMs > 0) {
      handles.slow = timers.setTimeout(() => {
        notify(spec.id, "slow");
      }, slowAfterMs);
    }
    if (stillWaitingEveryMs > 0) {
      handles.waiting = timers.setInterval(() => {
        notify(spec.id, "waiting");
      }, stillWaitingEveryMs);
    }
    if (degradeAfterMs !== null && degradeAfterMs > 0) {
      handles.degrade = timers.setTimeout(() => {
        /*
         * Wording chosen with care. "Timed out" would claim the operation
         * stopped, and it has not: the call is still outstanding on a libuv
         * worker and may yet return. What has changed is only that startup no
         * longer counts it.
         *
         * A detail the phase has already set wins, because it says something
         * this generic sentence cannot: "the media root is unavailable: ..." is
         * a probe that answered with a refusal, and a blocked `stat` that has
         * not answered at all leaves nothing to report but the waiting.
         */
        const detail =
          phaseOf(spec.id)?.detail ??
          "Still waiting; the server is live but not ready.";
        if (state.degrade(spec.id, detail)) notify(spec.id, "degraded");
      }, degradeAfterMs);
    }
    armed.set(spec.id, handles);
  };

  const settle = (id: StartupPhaseId, settled: boolean): void => {
    disarm(id);
    if (settled) notify(id, "settled");
  };

  const coordinator: StartupCoordinator = {
    markLive() {
      state.markLive();
      observer.live?.(state.snapshot());
    },

    begin(spec) {
      if (state.stopping) return;
      /*
       * A phase that is already running is being *re-entered*, not started: the
       * database phase does this once per connection attempt. Re-arming there
       * would restart the slow warning and the "still waiting" interval on every
       * attempt, so a dependency retried every three seconds would never reach
       * either — the two signals that exist precisely for a dependency that is
       * taking a long time would be the ones a long wait suppressed.
       */
      const reentering = phaseOf(spec.id)?.state === "running";
      const patch: StartupPhasePatch = {};
      if (spec.operation !== undefined) patch.operation = spec.operation;
      if (spec.resource !== undefined) patch.resource = spec.resource;
      if (spec.detail !== undefined) patch.detail = spec.detail;
      state.begin(spec.id, patch);
      if (reentering) return;
      arm(spec);
      notify(spec.id, "began");
    },

    update(id, patch) {
      state.update(id, patch);
    },

    complete(id) {
      settle(id, state.complete(id));
    },

    fail(id, error) {
      settle(id, state.fail(id, error));
    },

    failRunning(error) {
      for (const phase of state.snapshot().phases) {
        if (phase.state === "running" || phase.state === "degraded") {
          coordinator.fail(phase.id, error);
        }
      }
    },

    async run(spec, work) {
      coordinator.begin(spec);
      try {
        const result = await work({
          update: (patch) => state.update(spec.id, patch),
          signal,
        });
        coordinator.complete(spec.id);
        return result;
      } catch (error) {
        coordinator.fail(spec.id, error);
        throw error;
      }
    },

    snapshot: () => state.snapshot(),

    finish() {
      // Once only. A failure path and a shutdown path can both reach here.
      if (finished) return;
      finished = true;
      observer.finished?.(state.snapshot());
    },

    stop() {
      state.stop();
      for (const id of [...armed.keys()]) disarm(id);
    },

    get stopping() {
      return state.stopping;
    },

    dispose() {
      for (const id of [...armed.keys()]) disarm(id);
    },
  };

  return coordinator;
}
