/**
 * A dependency that can be away, without the noise of noticing.
 *
 * When PostgreSQL went down during an encode, the worker logged
 * `Could not read the pause state for a processing job: Connection terminated
 * due to connection timeout` several hundred times. Not because anything was
 * retrying aggressively by design, but because a one-second poll that has no
 * concept of "unavailable" simply keeps polling: every tick opened a
 * connection, waited out the five-second dial timeout, failed, wrote a line,
 * and queued the next one. The database was not helped by any of it, the log
 * became unreadable at exactly the moment it mattered, and the same shape of
 * loop was running for the media root and for the queue.
 *
 * This is the missing concept. A gate holds one dependency's availability as a
 * state rather than as the outcome of the last attempt, so:
 *
 *  - a failed check backs off, doubling with jitter to a ceiling, instead of
 *    retrying at the caller's cadence;
 *  - callers between attempts are told "unavailable" from memory, at no cost,
 *    rather than each dialling for themselves;
 *  - the transition is logged, not the attempts — one line when it goes, one
 *    when it comes back, however long it is away;
 *  - concurrent callers share a single in-flight probe.
 *
 * The jitter matters more than it looks: without it the pause poll, the queue
 * poll and the health check all retry on the same doubling schedule, and a
 * database coming back up meets three simultaneous reconnection attempts from
 * every process at each step.
 */

export type DependencyState = "available" | "unavailable";

export interface DependencyGateOptions {
  /** Names the dependency in transition logs. */
  name: string;
  /**
   * One bounded attempt. Resolving means available; throwing or resolving false
   * means not. Must not retry internally — retrying is this file's job, and a
   * probe that retries turns one backoff step into several.
   */
  probe: () => Promise<boolean | void>;
  /** First wait after a failure. */
  initialDelayMs?: number;
  /** Ceiling. Reached by doubling; never exceeded however long the outage is. */
  maxDelayMs?: number;
  /** Fraction of the delay applied as random jitter, in [0, 1]. */
  jitter?: number;
  /** Called once per transition, never per attempt. */
  onStateChange?: (state: DependencyState, detail: string) => void;
  now?: () => number;
  random?: () => number;
}

export interface DependencyGate {
  readonly name: string;
  readonly state: DependencyState;
  /** Consecutive failed probes. Zero whenever available. */
  readonly failureCount: number;
  /** Probes actually run since construction. The figure a rate test asserts on. */
  readonly probeCount: number;
  /** Last failure's message, bounded and safe to show. */
  readonly lastError: string | null;
  /** When the next probe becomes due, in epoch ms. Null when none is pending. */
  readonly nextAttemptAtMs: number | null;
  /**
   * The current answer, probing only if one is due.
   *
   * This is what a hot loop calls. While the dependency is known to be away and
   * the backoff has not elapsed it returns `false` without touching anything,
   * which is the whole point: a caller may ask a thousand times a second and
   * cost nothing.
   */
  check(): Promise<boolean>;
  /**
   * Probes now, ignoring the backoff.
   *
   * For the moments a person is waiting on the answer — an operator pressing
   * a button, a startup sequence — where a full ceiling's delay would read as
   * the system being broken.
   */
  checkNow(): Promise<boolean>;
  /** Records a failure observed elsewhere, without a probe of its own. */
  reportFailure(error: unknown): void;
  /** Records a success observed elsewhere. */
  reportSuccess(): void;
}

export const DEFAULT_INITIAL_DELAY_MS = 1_000;
export const DEFAULT_MAX_DELAY_MS = 30_000;
export const DEFAULT_JITTER = 0.2;

/** Bounded, single-line, no paths: this text reaches a browser. */
function describeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return (
    raw
      .split("\n", 1)[0]
      ?.replace(/(^|\s)(?:[A-Za-z]:)?[\\/][^\s]*/g, " ")
      .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S*/gi, " ")
      .replace(/\s{2,}/g, " ")
      .trim()
      .slice(0, 240) || "The dependency did not answer."
  );
}

export function createDependencyGate({
  name,
  probe,
  initialDelayMs = DEFAULT_INITIAL_DELAY_MS,
  maxDelayMs = DEFAULT_MAX_DELAY_MS,
  jitter = DEFAULT_JITTER,
  onStateChange,
  now = Date.now,
  random = Math.random,
}: DependencyGateOptions): DependencyGate {
  /*
   * Optimistic at construction. A gate that started `unavailable` would make
   * every process announce an outage on startup and serve one backoff step of
   * refusals before its first probe — which, for the media root, means a worker
   * that reports the drive missing every time it is restarted.
   */
  let state: DependencyState = "available";
  let failureCount = 0;
  let probeCount = 0;
  let lastError: string | null = null;
  let nextAttemptAtMs: number | null = null;
  let inFlight: Promise<boolean> | null = null;

  const delayFor = (failures: number): number => {
    const exponential = Math.min(
      maxDelayMs,
      initialDelayMs * 2 ** Math.max(0, failures - 1),
    );
    /*
     * Jitter is applied downwards only. Spreading upwards as well would let a
     * caller wait longer than the documented ceiling, and the ceiling is the
     * figure an operator is promised recovery within.
     */
    const spread = exponential * jitter * random();
    return Math.max(0, Math.round(exponential - spread));
  };

  const succeed = (): void => {
    failureCount = 0;
    lastError = null;
    nextAttemptAtMs = null;
    if (state !== "available") {
      state = "available";
      onStateChange?.("available", `${name} is available again.`);
    }
  };

  const fail = (error: unknown): void => {
    failureCount += 1;
    lastError = describeError(error);
    nextAttemptAtMs = now() + delayFor(failureCount);
    if (state !== "unavailable") {
      state = "unavailable";
      onStateChange?.("unavailable", `${name} is unavailable: ${lastError}`);
    }
  };

  const runProbe = (): Promise<boolean> => {
    /*
     * One probe at a time. Without this the pause poll, the progress writer and
     * the cancellation check each open their own connection to a database that
     * is already refusing them, which is three dial timeouts where one would do.
     */
    if (inFlight) return inFlight;
    inFlight = (async () => {
      probeCount += 1;
      try {
        const result = await probe();
        if (result === false) {
          fail(new Error(`${name} reported itself unavailable.`));
          return false;
        }
        succeed();
        return true;
      } catch (error) {
        fail(error);
        return false;
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  };

  return {
    get name() {
      return name;
    },
    get state() {
      return state;
    },
    get failureCount() {
      return failureCount;
    },
    get probeCount() {
      return probeCount;
    },
    get lastError() {
      return lastError;
    },
    get nextAttemptAtMs() {
      return nextAttemptAtMs;
    },

    async check() {
      if (state === "available") return true;
      if (nextAttemptAtMs !== null && now() < nextAttemptAtMs) return false;
      return runProbe();
    },

    checkNow: runProbe,

    reportFailure(error) {
      fail(error);
    },

    reportSuccess() {
      succeed();
    },
  };
}

/**
 * Waits for a gate to open, without spinning.
 *
 * The sleep is taken from the gate's own schedule rather than from a caller's
 * guess, so a startup wait and a mid-encode wait cannot drift into different
 * cadences against the same dependency. `signal` is honoured because a worker
 * asked to shut down while waiting for a database must go now, not at the top
 * of the next thirty-second step.
 */
export async function awaitDependency({
  gate,
  signal,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
}: {
  gate: DependencyGate;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): Promise<boolean> {
  for (;;) {
    if (signal?.aborted) return false;
    if (await gate.checkNow()) return true;
    if (signal?.aborted) return false;
    const wait = Math.max(0, (gate.nextAttemptAtMs ?? now()) - now());
    await sleep(wait);
  }
}
