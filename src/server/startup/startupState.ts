/**
 * What the server is doing before it can serve, held as one fact.
 *
 * Startup used to be a sequence of awaits with no name and no record. When the
 * media volume stopped answering, the process sat in `stat("/Volumes/…")` for
 * over nine minutes: no log line, no open port, no way to ask. The only way to
 * learn what it was waiting on was `sample` and a debugger on the blocked
 * libuv worker.
 *
 * This is the record that was missing. One phase list, one owner, one snapshot
 * — so the terminal, the launchd log and `/ownAPI/v1/health` all describe the
 * same startup rather than three guesses at it.
 */

import { describeErrorSafely } from "../../lib/safeErrorText";

export type StartupPhaseId =
  | "configuration"
  | "listener"
  | "media-storage"
  | "generated-storage"
  | "database"
  | "processing"
  | "routes";

export type StartupPhaseState =
  | "pending"
  | "running"
  /**
   * Running for longer than the policy expects, and no longer counted towards
   * readiness. Deliberately *not* "failed": the underlying operation has not
   * been cancelled and may still complete, at which point the phase becomes
   * `ready` and startup carries on.
   */
  | "degraded"
  | "ready"
  | "failed"
  | "cancelled";

export type StartupState =
  | "starting"
  | "degraded"
  | "ready"
  | "failed"
  | "stopping";

/** Real work with a real denominator. Never a phase index dressed up as one. */
export interface StartupProgress {
  completed: number;
  total: number;
}

export interface StartupPhaseSnapshot {
  id: StartupPhaseId;
  label: string;
  state: StartupPhaseState;
  /** Epoch ms the phase started, or null while pending. */
  startedAtMs: number | null;
  /** Time spent so far, or the final duration once settled. */
  elapsedMs: number | null;
  /** The specific call being awaited: `stat`, `realpath`, `listen`, `connect`. */
  operation?: string;
  /**
   * The resource being waited on — a path, a port, a database name.
   *
   * Local diagnostics only. `toPublicSnapshot` strips it, because
   * `/ownAPI/v1/health` is public and its contract promises no storage paths.
   */
  resource?: string;
  detail?: string;
  /** Probe attempts made, when the phase retries. One-based. */
  attempt?: number;
  nextAttemptAtMs?: number;
  progress?: StartupProgress;
  /** Sanitised, single-line, no paths. Safe to serve. */
  error?: string;
}

export interface StartupSnapshot {
  /** The listener is bound and the event loop is answering. */
  live: boolean;
  /** Every required phase completed; ordinary routes may run. */
  ready: boolean;
  state: StartupState;
  /** The phase startup is currently blocked on, or null when none is. */
  phase: StartupPhaseId | null;
  startedAtMs: number;
  elapsedMs: number;
  phases: StartupPhaseSnapshot[];
}

export interface StartupPhaseDefinition {
  id: StartupPhaseId;
  label: string;
}

/**
 * The phases, in the order they are entered.
 *
 * `listener` sits third on purpose. Binding the port before the storage and
 * database phases is the whole architectural change: a volume that does not
 * answer now costs readiness, not the process.
 */
export const DEFAULT_STARTUP_PHASES: readonly StartupPhaseDefinition[] = [
  { id: "configuration", label: "Runtime configuration" },
  { id: "listener", label: "HTTP listener" },
  { id: "media-storage", label: "Media storage" },
  { id: "generated-storage", label: "Generated storage" },
  { id: "database", label: "Database" },
  { id: "processing", label: "Processing state" },
  { id: "routes", label: "API routes" },
] as const;

const SETTLED: ReadonlySet<StartupPhaseState> = new Set([
  "ready",
  "failed",
  "cancelled",
]);

/**
 * One line, no paths, no URLs, bounded.
 *
 * This text reaches a browser through the public health endpoint, so an
 * `ENOENT` must not carry the media root out with it. Shared with the
 * dependency gate, which makes the same promise about the same kind of message.
 */
export function describeStartupError(error: unknown): string {
  return describeErrorSafely(error, "The startup step did not complete.");
}

export interface StartupPhasePatch {
  operation?: string;
  resource?: string;
  detail?: string;
  attempt?: number;
  nextAttemptAtMs?: number;
  progress?: StartupProgress;
}

export interface StartupStateMachine {
  /** Called once the listener is bound. Liveness is nothing else. */
  markLive(): void;
  begin(id: StartupPhaseId, patch?: StartupPhasePatch): void;
  update(id: StartupPhaseId, patch: StartupPhasePatch): void;
  /** True when this call performed the transition; false when already settled. */
  complete(id: StartupPhaseId): boolean;
  /** Still running, no longer counted ready. Reversible by `complete`. */
  degrade(id: StartupPhaseId, detail: string): boolean;
  fail(id: StartupPhaseId, error: unknown): boolean;
  /**
   * Shutdown began. Readiness is pinned false from here: a dependency that
   * answers after SIGTERM must not flip a process that is on its way out into
   * claiming it can serve.
   */
  stop(): void;
  readonly stopping: boolean;
  snapshot(): StartupSnapshot;
}

interface PhaseRecord extends StartupPhaseDefinition {
  state: StartupPhaseState;
  startedAtMs: number | null;
  settledAtMs: number | null;
  operation?: string;
  resource?: string;
  detail?: string;
  attempt?: number;
  nextAttemptAtMs?: number;
  progress?: StartupProgress;
  error?: string;
}

export function createStartupState({
  phases = DEFAULT_STARTUP_PHASES,
  now = Date.now,
}: {
  phases?: readonly StartupPhaseDefinition[];
  now?: () => number;
} = {}): StartupStateMachine {
  const startedAtMs = now();
  const records = new Map<StartupPhaseId, PhaseRecord>(
    phases.map((phase) => [
      phase.id,
      {
        ...phase,
        state: "pending",
        startedAtMs: null,
        settledAtMs: null,
      },
    ]),
  );
  let live = false;
  let stopping = false;

  const record = (id: StartupPhaseId): PhaseRecord => {
    const found = records.get(id);
    if (!found) throw new Error(`Unknown startup phase: ${id}`);
    return found;
  };

  const applyPatch = (target: PhaseRecord, patch: StartupPhasePatch): void => {
    if (patch.operation !== undefined) target.operation = patch.operation;
    if (patch.resource !== undefined) target.resource = patch.resource;
    if (patch.detail !== undefined) target.detail = patch.detail;
    if (patch.attempt !== undefined) target.attempt = patch.attempt;
    if (patch.nextAttemptAtMs !== undefined) {
      target.nextAttemptAtMs = patch.nextAttemptAtMs;
    }
    if (patch.progress !== undefined) target.progress = patch.progress;
  };

  const settle = (
    id: StartupPhaseId,
    state: Extract<StartupPhaseState, "ready" | "failed" | "cancelled">,
    error?: unknown,
  ): boolean => {
    const target = record(id);
    if (SETTLED.has(target.state)) return false;
    target.state = state;
    target.settledAtMs = now();
    target.nextAttemptAtMs = undefined as number | undefined;
    if (state === "ready") {
      target.error = undefined as string | undefined;
      target.operation = undefined as string | undefined;
    } else if (error !== undefined) {
      target.error = describeStartupError(error);
    }
    return true;
  };

  const phaseSnapshot = (target: PhaseRecord): StartupPhaseSnapshot => {
    const elapsedMs =
      target.startedAtMs === null
        ? null
        : Math.max(0, (target.settledAtMs ?? now()) - target.startedAtMs);

    return {
      id: target.id,
      label: target.label,
      state: target.state,
      startedAtMs: target.startedAtMs,
      elapsedMs,
      ...(target.operation ? { operation: target.operation } : {}),
      ...(target.resource ? { resource: target.resource } : {}),
      ...(target.detail ? { detail: target.detail } : {}),
      ...(target.attempt !== undefined ? { attempt: target.attempt } : {}),
      ...(target.nextAttemptAtMs !== undefined
        ? { nextAttemptAtMs: target.nextAttemptAtMs }
        : {}),
      ...(target.progress ? { progress: target.progress } : {}),
      ...(target.error ? { error: target.error } : {}),
    };
  };

  return {
    markLive() {
      live = true;
    },

    begin(id, patch) {
      const target = record(id);
      if (SETTLED.has(target.state)) return;
      target.state = "running";
      if (target.startedAtMs === null) target.startedAtMs = now();
      target.settledAtMs = null;
      if (patch) applyPatch(target, patch);
    },

    update(id, patch) {
      const target = record(id);
      if (SETTLED.has(target.state)) return;
      applyPatch(target, patch);
    },

    complete(id) {
      return settle(id, "ready");
    },

    degrade(id, detail) {
      const target = record(id);
      // A degrade only ever describes something still running. Applying it to a
      // settled phase would resurrect a finished step as an open one.
      if (target.state !== "running") return false;
      target.state = "degraded";
      target.detail = detail;
      return true;
    },

    fail(id, error) {
      return settle(id, "failed", error);
    },

    stop() {
      stopping = true;
      for (const target of records.values()) {
        if (!SETTLED.has(target.state)) {
          target.state = "cancelled";
          target.settledAtMs = now();
          target.nextAttemptAtMs = undefined as number | undefined;
        }
      }
    },

    get stopping() {
      return stopping;
    },

    snapshot() {
      const phaseSnapshots = [...records.values()].map(phaseSnapshot);
      const ready =
        !stopping && phaseSnapshots.every((phase) => phase.state === "ready");
      const failed = phaseSnapshots.some((phase) => phase.state === "failed");
      const degraded = phaseSnapshots.some(
        (phase) => phase.state === "degraded",
      );
      const blocking = phaseSnapshots.find(
        (phase) =>
          phase.state === "running" ||
          phase.state === "degraded" ||
          phase.state === "failed",
      );

      const state: StartupState = stopping
        ? "stopping"
        : ready
          ? "ready"
          : failed
            ? "failed"
            : degraded
              ? "degraded"
              : "starting";

      return {
        live,
        ready,
        state,
        phase: blocking?.id ?? null,
        startedAtMs,
        elapsedMs: Math.max(0, now() - startedAtMs),
        phases: phaseSnapshots,
      };
    },
  };
}

/**
 * The snapshot as the public health endpoint may serve it.
 *
 * `resource` is dropped, every time. `/ownAPI/v1/health` is unauthenticated and
 * its contract promises no storage paths, and "the media root is
 * /Volumes/Expansion/media" is exactly such a path. The terminal and the
 * process log keep it, which is where an operator diagnosing a stalled mount
 * is actually looking.
 */
export function toPublicStartupSnapshot(
  snapshot: StartupSnapshot,
): StartupSnapshot {
  return {
    ...snapshot,
    phases: snapshot.phases.map(({ resource: _resource, ...phase }) => phase),
  };
}
