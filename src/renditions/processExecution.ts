/**
 * Owning a child process, including the part where it refuses to die.
 *
 * Every subprocess in this pipeline used to be spawned ad hoc: `spawn`, a
 * `close` listener, and — where cancellation was supported at all — a single
 * `SIGTERM` followed by resolving the promise. On a healthy machine that is
 * indistinguishable from correct. On a disk with an unreadable region it is
 * three separate bugs at once, and a real Seagate volume demonstrated all
 * three:
 *
 *  - **The signal is not the end.** A process blocked in local kernel I/O is
 *    uninterruptible. Measured on the failing drive: `SIGTERM` left FFmpeg in
 *    state `U` five seconds later, and even `SIGKILL` could not cancel the
 *    active read — the process only became a zombie once Darwin's twenty-retry
 *    recovery unwound. So a terminator has to escalate, and then *wait to reap*
 *    rather than assume.
 *  - **The leaf is not the tree.** Without `detached`, a child joins the
 *    worker's own process group, so `kill(-pid)` is unavailable and any
 *    grandchild survives. Every spawn here becomes its own group leader
 *    instead, and signals go to the group.
 *  - **Nobody was watching.** Nothing had a wall clock. FFmpeg sat for minutes
 *    walking from one bad block to the next while the only reaction anywhere in
 *    the system was a label on a web page.
 *
 * So process lifetime lives here, once, and the layers above express intent —
 * "abort this, because media time stopped" — rather than repeating signal
 * choreography. What comes back is structured: how it ended, whether anyone
 * asked it to, and what it said on the way out.
 */

import { spawn, type ChildProcess } from "node:child_process";

/** Why something was asked to stop. Never a description of what it produced. */
export type ProcessAbortReason =
  /** The caller's `AbortSignal` fired: a cancellation, or a stopped job. */
  | "caller"
  /** Media time stopped advancing for longer than the encode is allowed. */
  | "media-watchdog"
  /** A total wall-clock limit expired. Probes have one; encodes do not. */
  | "wall-clock"
  /** The process produced more output than the caller is prepared to hold. */
  | "output-limit";

/**
 * How long a process is given to end politely before it is killed.
 *
 * `SIGTERM` lets FFmpeg finalise what it has written, which is worth waiting
 * for on an ordinary cancel. It is worth nothing at all when the process is
 * wedged in a read, and the drive that motivated this took tens of seconds to
 * return control — so the escalation is queued rather than skipped: the kernel
 * delivers the `SIGKILL` the moment the syscall unwinds.
 */
export const PROCESS_TERMINATION_GRACE_MS = 10_000;

export interface ManagedProcessOutcome {
  /** Exit status, or null when a signal ended it. */
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** True when this process was asked to stop rather than ending on its own. */
  aborted: boolean;
  abortReason?: ProcessAbortReason;
  /** Whether the escalation actually had to be used. */
  escalated: boolean;
  /** Bounded tail of everything written to stderr. */
  stderrTail: string;
  /** Wall time from spawn to reap. */
  durationMs: number;
}

export interface ManagedProcess {
  readonly pid: number | undefined;
  /**
   * Asks the process to stop, and keeps asking.
   *
   * Idempotent: the first reason wins and later calls are recorded but change
   * nothing, so a cancellation arriving during a watchdog termination cannot
   * restart the escalation or settle the promise twice. Returns immediately —
   * the process may take as long as the kernel takes.
   */
  abort(reason: ProcessAbortReason): void;
  /** Resolves when the child has actually been reaped. Never rejects. */
  readonly completed: Promise<ManagedProcessOutcome>;
}

export interface SpawnManagedProcessInput {
  command: string;
  args: readonly string[];
  /** Bytes of stderr kept. The tail, because the last words describe the end. */
  stderrTailBytes?: number;
  /** Called with each stdout chunk. Absent means stdout is drained and dropped. */
  onStdout?: (chunk: string) => void;
  /** Called with each stderr chunk, in addition to the retained tail. */
  onStderr?: (chunk: string) => void;
  /** Aborts with reason `caller`. */
  signal?: AbortSignal;
  /** Aborts with reason `wall-clock` after this long, measured from spawn. */
  timeoutMs?: number;
  /** How long `SIGTERM` is given before `SIGKILL` follows it. */
  terminationGraceMs?: number;
  /**
   * Runs the child in a process group of its own, so signals reach whatever it
   * spawns. On by default: an ffmpeg that leaves a helper behind is an orphan
   * holding a file handle on a volume this system is trying to unmount.
   */
  ownProcessGroup?: boolean;
  /** Injected by tests so a grace period does not cost real seconds. */
  now?: () => number;
}

/**
 * Signals a process group, falling back to the process itself.
 *
 * The negative pid addresses the group. It fails with `ESRCH` once everything
 * in it is gone, which is the ordinary ending and not worth reporting, and with
 * `EPERM` on a process that has already been reaped.
 */
function signalGroup(
  pid: number,
  signal: NodeJS.Signals,
  ownProcessGroup: boolean,
): void {
  if (ownProcessGroup) {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // The group is gone, or was never created; fall through to the leaf.
    }
  }
  try {
    process.kill(pid, signal);
  } catch {
    // Already reaped.
  }
}

/**
 * Spawns a child this process actually owns.
 *
 * The promise resolves on `close` — after the streams are done and the child is
 * reaped — and never rejects, because "it failed" is a fact about the outcome
 * rather than an exception. Callers that want an exception build one from the
 * outcome, where they can say what the failure meant to them.
 */
export function spawnManagedProcess({
  command,
  args,
  stderrTailBytes = 32_768,
  onStdout,
  onStderr,
  signal,
  timeoutMs,
  terminationGraceMs = PROCESS_TERMINATION_GRACE_MS,
  ownProcessGroup = true,
  now = Date.now,
}: SpawnManagedProcessInput): ManagedProcess {
  const startedAt = now();
  const child: ChildProcess = spawn(command, [...args], {
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    /*
     * Its own process group. `detached` is doing one job here and it is not
     * the one the name suggests: nothing is being backgrounded, and the child
     * is never `unref`ed. It makes the child a group leader so a single
     * `kill(-pid)` reaches it and anything it spawns.
     */
    detached: ownProcessGroup,
  });

  let stderrTail = "";
  let settled = false;
  let abortReason: ProcessAbortReason | undefined;
  let escalated = false;
  let graceTimer: NodeJS.Timeout | undefined;
  let wallClockTimer: NodeJS.Timeout | undefined;
  let resolveOutcome!: (outcome: ManagedProcessOutcome) => void;

  const completed = new Promise<ManagedProcessOutcome>((resolve) => {
    resolveOutcome = resolve;
  });

  const cleanup = (): void => {
    if (graceTimer) clearTimeout(graceTimer);
    if (wallClockTimer) clearTimeout(wallClockTimer);
    graceTimer = undefined;
    wallClockTimer = undefined;
    signal?.removeEventListener("abort", onCallerAbort);
  };

  const settle = (
    exitCode: number | null,
    exitSignal: NodeJS.Signals | null,
  ): void => {
    if (settled) return;
    settled = true;
    cleanup();
    resolveOutcome({
      exitCode,
      signal: exitSignal,
      aborted: abortReason !== undefined,
      ...(abortReason === undefined ? {} : { abortReason }),
      escalated,
      stderrTail,
      durationMs: now() - startedAt,
    });
  };

  const abort = (reason: ProcessAbortReason): void => {
    if (settled) return;
    /*
     * The first reason wins. A cancellation landing while a watchdog
     * termination is already under way must not restart the escalation, and —
     * more importantly — must not change the story the outcome tells about why
     * the process stopped.
     */
    if (abortReason !== undefined) return;
    abortReason = reason;
    const pid = child.pid;
    if (pid === undefined) return;

    /*
     * A suspended process cannot act on `SIGTERM`. Waking it first is what
     * makes cancelling a paused encode take effect now rather than leaving a
     * stopped FFmpeg holding its output files open for ever.
     */
    signalGroup(pid, "SIGCONT", ownProcessGroup);
    signalGroup(pid, "SIGTERM", ownProcessGroup);

    graceTimer = setTimeout(() => {
      if (settled) return;
      escalated = true;
      signalGroup(pid, "SIGKILL", ownProcessGroup);
      /*
       * And then wait. There is deliberately no timer after this one: a
       * `SIGKILL` that has not taken effect is a kernel operation that has not
       * returned, and nothing in user space can hurry it. The promise settles
       * when the child is reaped, however long Darwin takes to unwind the
       * read that wedged it.
       */
    }, terminationGraceMs);
    graceTimer.unref?.();
  };

  const onCallerAbort = (): void => abort("caller");

  if (signal) {
    if (signal.aborted) abort("caller");
    else signal.addEventListener("abort", onCallerAbort, { once: true });
  }

  if (timeoutMs !== undefined && timeoutMs > 0) {
    wallClockTimer = setTimeout(() => abort("wall-clock"), timeoutMs);
    wallClockTimer.unref?.();
  }

  if (onStdout) {
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => onStdout(chunk));
  } else {
    child.stdout?.resume();
  }

  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderrTail = `${stderrTail}${chunk}`.slice(-stderrTailBytes);
    onStderr?.(chunk);
  });

  /*
   * A spawn that never started has no process to reap, so it settles here.
   * `close` would never arrive, and a caller waiting for it would wait for
   * ever — which is the failure mode this whole file exists to remove.
   */
  child.once("error", () => settle(null, null));
  child.once("close", (code, closeSignal) => settle(code, closeSignal));

  return {
    get pid() {
      return child.pid;
    },
    abort,
    completed,
  };
}

/**
 * A process that was stopped on purpose.
 *
 * Carried as a class so the layers above can tell "we ended this" from "it
 * failed", which is the distinction that decides whether a job is retried,
 * salvaged or simply cancelled. A watchdog termination reaching the queue as
 * `FFmpeg exited with signal 15` is precisely how the damaged title got
 * requeued into the damaged region a second time.
 */
export class ProcessAbortedError extends Error {
  readonly reason: ProcessAbortReason;
  readonly outcome: ManagedProcessOutcome;
  constructor(message: string, outcome: ManagedProcessOutcome) {
    super(message);
    this.name = "ProcessAbortedError";
    this.reason = outcome.abortReason ?? "caller";
    this.outcome = outcome;
  }
}

/**
 * Runs a process to completion and returns its stdout.
 *
 * The bounded-probe primitive: every argument that matters — the wall clock,
 * the escalation, the output ceiling — is enforced by the runner above rather
 * than by the caller remembering to. Used by anything that reads the source to
 * ask it a question, because on a failing disk a question can hang as
 * thoroughly as an encode.
 */
export async function runBoundedProcess({
  command,
  args,
  signal,
  timeoutMs,
  maxOutputBytes = 16 * 1024 * 1024,
  terminationGraceMs,
  describe = command,
}: {
  command: string;
  args: readonly string[];
  signal?: AbortSignal;
  timeoutMs?: number;
  maxOutputBytes?: number;
  terminationGraceMs?: number;
  /** What to call this in an error message. Never a path. */
  describe?: string;
}): Promise<{ stdout: string; outcome: ManagedProcessOutcome }> {
  let stdout = "";
  let overflowed = false;
  const managed = spawnManagedProcess({
    command,
    args,
    ...(signal ? { signal } : {}),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(terminationGraceMs === undefined ? {} : { terminationGraceMs }),
    onStdout: (chunk) => {
      if (overflowed) return;
      stdout += chunk;
      if (stdout.length > maxOutputBytes) {
        overflowed = true;
        managed.abort("output-limit");
      }
    },
  });

  const outcome = await managed.completed;
  if (outcome.aborted) {
    throw new ProcessAbortedError(
      `${describe} was stopped (${outcome.abortReason}).`,
      outcome,
    );
  }
  if (outcome.exitCode !== 0) {
    throw new Error(
      `${describe} failed with exit code ${
        outcome.exitCode ?? outcome.signal ?? "unknown"
      }: ${outcome.stderrTail.slice(-2_000)}`,
    );
  }
  return { stdout, outcome };
}

/**
 * What ended an encoder run, in terms the layers above can act on.
 *
 * A plain `Error` cannot carry this. "FFmpeg exited with signal 15" is true of
 * a user pressing Cancel, of a vanished volume, and of a watchdog stopping a
 * process wedged on an unreadable sector — and those three demand opposite
 * handling. Conflating them is exactly how a confirmed source-damage
 * termination reached the task queue as a generic failure and had the whole
 * media job requeued straight back into the damaged region.
 */
export class EncoderAbortedError extends Error {
  readonly reason: ProcessAbortReason;
  readonly outcome: ManagedProcessOutcome;
  /** Media seconds FFmpeg had genuinely produced when it was stopped. */
  readonly lastMediaSeconds: number;
  /** When media time last advanced, in epoch milliseconds. */
  readonly lastProgressAtMs: number;
  /** How long media time had been standing still. */
  readonly stalledForMs: number;
  /** Bounded, unsanitised stderr tail. Sanitised before it leaves the worker. */
  readonly stderrTail: string;
  constructor(
    message: string,
    outcome: ManagedProcessOutcome,
    media: {
      lastMediaSeconds: number;
      lastProgressAtMs: number;
      stalledForMs: number;
    },
  ) {
    super(message);
    this.name = "EncoderAbortedError";
    this.reason = outcome.abortReason ?? "caller";
    this.outcome = outcome;
    this.lastMediaSeconds = media.lastMediaSeconds;
    this.lastProgressAtMs = media.lastProgressAtMs;
    this.stalledForMs = media.stalledForMs;
    this.stderrTail = outcome.stderrTail;
  }
}

/**
 * The media-progress watchdog, as a caller states it.
 *
 * `hardStallMs` is the only figure that ends anything. `onStall` is told when
 * the decision is taken, before the signals go out, so an operator watching the
 * page sees "stopping the encoder" rather than a job that goes quiet and then
 * announces a diagnosis.
 */
export interface EncoderWatchdog {
  hardStallMs: number;
  /**
   * Allowance before the *first* progress report, where silence is normal.
   *
   * An accurate seek decodes forward from the preceding keyframe and reports
   * nothing until the first frame it keeps, so an epoch can legitimately say
   * nothing for a long time before it has done anything wrong. Defaults to the
   * running threshold when omitted, which is right for anything that starts
   * producing immediately.
   */
  startupStallMs?: number;
  terminationGraceMs?: number;
  onStall?: (detail: {
    lastMediaSeconds: number;
    stalledForMs: number;
  }) => void;
}
