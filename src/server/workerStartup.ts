import { assertMediaRootDirectory } from "./pathSecurity";
import {
  awaitDependency,
  createDependencyGate,
  type DependencyGate,
} from "../renditions/processing/dependencyGate";

/**
 * Telling "this deployment is misconfigured" from "the drive is not plugged in
 * yet".
 *
 * The worker used to treat both as fatal. It read `SEYIRLIK_MEDIA_ROOT`,
 * asserted the directory existed, and threw if it did not — and under
 * `KeepAlive=true` with `ThrottleInterval=10`, throwing is not an ending, it is
 * a cadence. The log filled with
 *
 *   Startup failed: SEYIRLIK_MEDIA_ROOT must point to an existing media directory.
 *   Startup failed: The database is unavailable.
 *
 * every ten seconds, indefinitely, for the entirely ordinary situations of an
 * external drive not yet mounted and Docker not yet up after a login. Six
 * launches a minute, each one paying for a Node start and a tsx compile, and
 * the one honest signal — that something was wrong — was buried under hundreds
 * of copies of itself.
 *
 * The distinction this file draws is the useful one: a *recoverable* dependency
 * is waited for, quietly, in a process that stays alive and costs nothing while
 * it waits; a *fatal* misconfiguration still exits, because no amount of
 * waiting supplies a variable nobody set.
 */

/** A dependency that will not fix itself. Exiting is right; the supervisor's
 * relaunch will fail identically, which is the correct amount of noise for a
 * mistake that needs a person. */
export class FatalWorkerConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FatalWorkerConfigurationError";
  }
}

export interface WorkerDependencyReport {
  /** What is being waited for, in one clause. Shown by the UI while degraded. */
  waitingFor: string | null;
  /** Which gates are currently closed. */
  degraded: boolean;
}

export interface WaitForWorkerDependenciesOptions {
  /** The configured media root. Absent or empty is fatal, not recoverable. */
  mediaRoot: string | undefined;
  /** Optional explicitly configured scratch volume; absence is recoverable. */
  scratchRoot?: string;
  /** One bounded connection attempt. Throwing means not yet. */
  probeDatabase?: () => Promise<void>;
  /** Injected in tests. Defaults to the real filesystem assertion. */
  probeMediaRoot?: (root: string) => Promise<string>;
  probeScratchRoot?: (root: string) => Promise<string>;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (message: string) => void;
  /** Ceiling on the backoff. Thirty seconds, as everywhere else. */
  maxDelayMs?: number;
}

export interface WorkerDependencies {
  /** The resolved, real media root. */
  mediaRoot: string;
  /** Kept so the runtime can report *why* it is degraded while it runs. */
  gates: DependencyGate[];
  report(): WorkerDependencyReport;
}

/**
 * Blocks until every recoverable dependency is satisfied, or the signal fires.
 *
 * Idle while it waits, in the sense that matters: the only work between
 * attempts is a `setTimeout`, and the attempts themselves are one `stat` and
 * one `SELECT 1` on a schedule that reaches thirty seconds within a minute. No
 * filesystem loop, no database loop, and one log line per transition however
 * long the wait lasts.
 */
export async function waitForWorkerDependencies({
  mediaRoot,
  scratchRoot,
  probeDatabase,
  probeMediaRoot = assertMediaRootDirectory,
  probeScratchRoot = assertMediaRootDirectory,
  signal,
  sleep,
  now = Date.now,
  log = (message) => console.info(message),
  maxDelayMs = 30_000,
}: WaitForWorkerDependenciesOptions): Promise<WorkerDependencies> {
  /*
   * Fatal, and checked before anything is waited for. An unset variable is not
   * a drive that has yet to spin up; nothing will ever supply it, and a worker
   * that sat waiting for one would be a process that looks healthy while doing
   * nothing at all — which is worse than the crash loop it replaced.
   */
  if (!mediaRoot || mediaRoot.trim() === "") {
    throw new FatalWorkerConfigurationError("SEYIRLIK_MEDIA_ROOT is required.");
  }

  let resolvedMediaRoot = "";
  const mediaGate = createDependencyGate({
    name: "The media root",
    probe: async () => {
      resolvedMediaRoot = await probeMediaRoot(mediaRoot);
    },
    maxDelayMs,
    onStateChange: (state, detail) =>
      log(`[Seyirlik Worker] ${state}: ${detail}`),
    now,
  });

  const gates: DependencyGate[] = [mediaGate];
  if (scratchRoot?.trim()) {
    gates.push(
      createDependencyGate({
        name: "The processing scratch root",
        probe: async () => {
          await probeScratchRoot(scratchRoot);
        },
        maxDelayMs,
        onStateChange: (state, detail) =>
          log(`[Seyirlik Worker] ${state}: ${detail}`),
        now,
      }),
    );
  }
  if (probeDatabase) {
    gates.push(
      createDependencyGate({
        name: "The database",
        probe: probeDatabase,
        maxDelayMs,
        onStateChange: (state, detail) =>
          log(`[Seyirlik Worker] ${state}: ${detail}`),
        now,
      }),
    );
  }

  for (const gate of gates) {
    const satisfied = await awaitDependency({
      gate,
      ...(signal ? { signal } : {}),
      ...(sleep ? { sleep } : {}),
      now,
    });
    if (!satisfied) {
      throw new FatalWorkerConfigurationError(
        "Startup was cancelled before the dependencies were ready.",
      );
    }
  }

  return {
    mediaRoot: resolvedMediaRoot,
    gates,
    report: () => {
      const closed = gates.filter((gate) => gate.state === "unavailable");
      return {
        degraded: closed.length > 0,
        waitingFor:
          closed.length === 0
            ? null
            : closed
                .map(
                  (gate) => `${gate.name} (${gate.lastError ?? "no answer"})`,
                )
                .join("; "),
      };
    },
  };
}
