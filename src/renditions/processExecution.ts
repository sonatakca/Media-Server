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
 *    instead, and signals go to the group — on POSIX, which is the only place
 *    the flag means that; see `usesPosixProcessGroup`.
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
import { setPriority } from "node:os";

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
 * How a child is asked to stop *before* it is made to.
 *
 * `SIGTERM` was the whole answer here, and on POSIX it is a good one: measured
 * against a running FFmpeg, `SIGTERM` produced `Exiting normally, received
 * signal 15`, exit 255, and a fully decodable file 454 ms later. On Windows
 * there is no such signal. Node maps every signal it accepts there to
 * `TerminateProcess`, so the same call took 49 ms and left 2.8 MB of frames
 * with no `moov` atom — a file nothing can open. Cancelling an encode and
 * killing it outright were the same operation, and the ten-second grace period
 * this module is built around never happened.
 *
 * FFmpeg does have a cooperative stop that works on both: `q` on stdin. Same
 * measurement, same host: exit 0, the trailer written, a file that decodes.
 * It is not a signal and it does not pretend to be one, which is why it is
 * modelled as a per-child protocol rather than as another platform branch.
 */
export type GracefulStop =
  /**
   * There is no cooperative protocol; the platform's own terminate is all there
   * is. The default, because most children have nothing to say.
   */
  | { kind: "signal" }
  /** A key written to the child's stdin, which it is watching. */
  | { kind: "stdin"; write: string };

/**
 * FFmpeg's documented quit key.
 *
 * Two things have to agree for this to work and they live in different files:
 * the child needs a stdin pipe, which this module gives it, and the command
 * must not carry `-nostdin`, which tells FFmpeg not to read one. With
 * `-nostdin` present the key is accepted by the pipe and ignored by FFmpeg, and
 * the encode runs to the end of the grace period as if nothing had been asked.
 */
export const FFMPEG_GRACEFUL_STOP: GracefulStop = { kind: "stdin", write: "q" };

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

/**
 * How far below the interactive foreground this pipeline's children run.
 *
 * Priority is only ever spent under contention, which is what makes it cheap:
 * a niced FFmpeg alone on the machine still gets every core it asked for and
 * finishes in the same wall time. What changes is who loses when the user comes
 * back. At nice 0 an eight-thread encode competes on equal terms with the
 * window server for the same performance cores, and the measured result was a
 * desktop that stopped drawing — a dead Dock, a Cmd-Tab that never appeared,
 * and a load average of 99 on a ten-core machine while a quarter of the CPU sat
 * idle waiting behind it.
 *
 * Ten, rather than the maximum, because the media watchdog ends an attempt
 * whose timeline has been frozen for twenty-five seconds. A niced process is
 * still scheduled, just later; one starved hard enough to report nothing for a
 * hundred consecutive intervals would be indistinguishable from the wedged
 * process that threshold exists to catch.
 */
export const BACKGROUND_PROCESS_NICENESS = 10;

export interface ManagedProcessOutcome {
  /** Exit status, or null when a signal ended it. */
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** True when this process was asked to stop rather than ending on its own. */
  aborted: boolean;
  abortReason?: ProcessAbortReason;
  /**
   * Whether the process had to be forced.
   *
   * `false` means it stopped because it was asked. `true` means the forced step
   * ran — either because the grace period expired, or because this platform had
   * no way of asking at all, which is the ordinary case on Windows for a child
   * with no quit protocol.
   */
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
  /**
   * The cooperative stop this particular child understands.
   *
   * Defaults to `{ kind: "signal" }`, which is what every caller had before and
   * what a child with no quit protocol still gets. A `stdin` protocol also
   * changes how the child is spawned — it is given a stdin pipe instead of
   * nothing — so it is declared here rather than arranged by the caller.
   */
  gracefulStop?: GracefulStop;
  /**
   * Scheduling niceness for the child, 0 (foreground) to 19 (last in line).
   *
   * Defaults to `BACKGROUND_PROCESS_NICENESS`, because everything spawned here
   * is background media work and none of it should ever outrank the interface.
   * Pass `0` for a process whose latency a person is actually waiting on.
   */
  niceness?: number;
  /** Injected by tests so a grace period does not cost real seconds. */
  now?: () => number;
}

/**
 * Whether this platform can give a child its own process group.
 *
 * A separate, exported predicate rather than an inline `process.platform` test,
 * because a platform choice buried inside a spawn call is one nothing can
 * assert on without being on that platform — which is exactly how the bug
 * below survived being written.
 *
 * On POSIX, `detached` makes the child a group leader so `kill(-pid)` reaches
 * it and every grandchild. Windows has no such group and no `kill(-pid)`, and
 * the flag there does something else entirely: Node maps it to
 * `DETACHED_PROCESS`, which starts the child with **no console**. A program
 * hosted by the console — `powershell.exe`, which is how the Windows identity
 * probe asks what a volume is — then writes nothing at all to the stdout pipe
 * it was given and exits `0`. Measured on Windows 11 with PowerShell 5.1: the
 * identical query returns a 184-byte JSON document with `detached: false` and
 * an empty string with `detached: true`, so every Windows volume came back
 * unidentified and every identity-dependent decision failed closed for a
 * reason that had nothing to do with storage.
 *
 * So the flag is POSIX-only. It buys nothing on Windows and costs the output of
 * anything the console hosts.
 */
export function usesPosixProcessGroup(
  ownProcessGroup: boolean,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return ownProcessGroup && platform !== "win32";
}

/**
 * Whether this platform has POSIX signals at all.
 *
 * Separate from `usesPosixProcessGroup` because they answer different
 * questions: a caller may decline a process group on POSIX, and that must not
 * be read as "this platform has no signals". Exported for the same reason the
 * other predicate is — it is the only way to assert the Windows branch from a
 * machine that is not Windows.
 *
 * On Windows Node accepts `SIGINT`, `SIGTERM`, `SIGKILL` and `0`, and every one
 * of the first three is `TerminateProcess`. Anything else — `SIGSTOP`,
 * `SIGCONT` — throws `ERR_UNKNOWN_SIGNAL` before it reaches the process. So
 * there is no signal there that means "please finish", and none that means
 * "pause".
 */
export function supportsPosixSignals(
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform !== "win32";
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
  gracefulStop = { kind: "signal" },
  niceness = BACKGROUND_PROCESS_NICENESS,
  now = Date.now,
}: SpawnManagedProcessInput): ManagedProcess {
  const startedAt = now();
  /*
   * What was asked for, narrowed to what this platform can actually provide.
   * Used for the spawn and for every signal afterwards, so the two can never
   * disagree about whether there is a group to address.
   */
  const posixProcessGroup = usesPosixProcessGroup(ownProcessGroup);
  const child: ChildProcess = spawn(command, [...args], {
    shell: false,
    windowsHide: true,
    /*
     * stdin only when the child has something to hear. Everything else keeps
     * the closed stdin it has always had, so nothing gains a pipe — or a way to
     * block on one — that did not ask for it.
     */
    stdio: [gracefulStop.kind === "stdin" ? "pipe" : "ignore", "pipe", "pipe"],
    /*
     * Its own process group. `detached` is doing one job here and it is not
     * the one the name suggests: nothing is being backgrounded, and the child
     * is never `unref`ed. It makes the child a group leader so a single
     * `kill(-pid)` reaches it and anything it spawns.
     *
     * POSIX only — see `usesPosixProcessGroup`. On Windows the same flag means
     * "no console", which silently empties the output of anything the console
     * hosts.
     */
    detached: posixProcessGroup,
  });

  /*
   * Applied to the spawned child rather than by prefixing `nice` to the command
   * line, so nothing above here has to know: `command` stays the thing that
   * actually runs, the pid is the child's own, and it is still the group leader
   * `detached` just made — so the `kill(-pid)` escalation reaches it unchanged.
   *
   * Best effort by design. Lowering a child's priority needs no privilege, but
   * the child may have already exited (a command that does not exist never has
   * a pid at all), and a platform that declines is not a reason to fail a job
   * that is otherwise running perfectly well.
   */
  if (child.pid !== undefined && niceness !== 0) {
    try {
      setPriority(child.pid, niceness);
    } catch {
      // Already reaped, or a platform that will not reprioritise. Either way
      // the encode is unaffected; it just competes on equal terms.
    }
  }

  let stderrTail = "";
  let settled = false;
  /** Set on `exit`, which is earlier than `close` and is when the pid dies. */
  let childExited = false;
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

  /**
   * Ask the child to stop, using the strongest cooperative mechanism it and
   * this platform actually have.
   *
   * Both are attempted where both exist. On POSIX `SIGTERM` will almost always
   * win the race and the outcome is exactly what it was before this function
   * existed; the quit key costs nothing and is there for the case where the
   * signal is blocked. On Windows the quit key is the whole of it, because
   * every signal Node will deliver there is a hard kill and a hard kill is what
   * the escalation below is for.
   */
  const requestGracefulStop = (pid: number): boolean => {
    let asked = false;
    if (gracefulStop.kind === "stdin") {
      const stdin = child.stdin;
      /*
       * A pipe that has already closed — the child exited, or ended its own
       * side — is not a failure. It means the cooperative request cannot be
       * delivered, and the grace period then simply expires into the
       * escalation, which is the correct outcome for a child that is not
       * listening.
       */
      if (stdin && stdin.writable) {
        try {
          stdin.write(gracefulStop.write);
          stdin.end();
          asked = true;
        } catch {
          // The pipe went away underneath us. The escalation is the answer.
        }
      }
    }

    if (!supportsPosixSignals()) return asked;

    /*
     * A suspended process cannot act on `SIGTERM`. Waking it first is what
     * makes cancelling a paused encode take effect now rather than leaving a
     * stopped FFmpeg holding its output files open for ever.
     */
    signalGroup(pid, "SIGCONT", posixProcessGroup);
    signalGroup(pid, "SIGTERM", posixProcessGroup);
    return true;
  };

  /**
   * Stop asking.
   *
   * On POSIX this is `SIGKILL` to the group, and then waiting: a `SIGKILL` that
   * has not taken effect is a kernel operation that has not returned, and
   * nothing in user space can hurry it. The promise settles when the child is
   * reaped, however long Darwin takes to unwind the read that wedged it.
   *
   * Windows has neither signals nor process groups, and `child.kill()` there
   * terminates the leaf only — an FFmpeg that had spawned anything would leave
   * it behind holding a handle on the very volume this system is trying to
   * release. `taskkill /T` is the platform's own answer for a tree and is
   * present on every install, so it is used first and the leaf kill is the
   * fallback for the case where it cannot be spawned at all.
   */
  const forceTerminate = (pid: number): void => {
    if (supportsPosixSignals()) {
      signalGroup(pid, "SIGKILL", posixProcessGroup);
      return;
    }
    const killLeaf = (): void => {
      try {
        child.kill();
      } catch {
        // Already reaped.
      }
    };
    try {
      const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        shell: false,
        windowsHide: true,
        stdio: "ignore",
      });
      killer.once("error", killLeaf);
    } catch {
      killLeaf();
    }
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
     * Nothing to wait for if nothing could be asked.
     *
     * A child with no quit protocol, on a platform with no signal that means
     * "please finish", has heard nothing — so the grace period is not a grace
     * period, it is ten seconds of an encoder still writing to a disk somebody
     * asked it to stop touching. Waiting it out would be worse than useless: it
     * is exactly the delay a person cancelling to unplug a drive would take as
     * permission.
     */
    if (!requestGracefulStop(pid)) {
      escalated = true;
      forceTerminate(pid);
      return;
    }

    graceTimer = setTimeout(() => {
      /*
       * `childExited` and not just `settled`: `exit` fires when the process is
       * reaped, `close` only once its pipes have drained too, and between the
       * two the pid belongs to nobody. Killing it there is a kill aimed at
       * whatever the operating system hands the number to next — a real hazard
       * on Windows, where pids are recycled quickly.
       */
      if (settled || childExited) return;
      escalated = true;
      forceTerminate(pid);
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
  child.once("exit", () => {
    childExited = true;
  });
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
