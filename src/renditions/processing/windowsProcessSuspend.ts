/**
 * Suspending a process on Windows, where there is no signal that means it.
 *
 * `SIGSTOP` does not exist here. Node rejects it with `ERR_UNKNOWN_SIGNAL`
 * before it reaches anything, and every signal Node *will* deliver on Windows
 * is `TerminateProcess` — so for the encoder the choice used to be between
 * running and dead, with "paused" a label the queue applied to a process that
 * was still writing at full speed.
 *
 * The platform does have the operation; it is just not a signal.
 * `NtSuspendProcess` and `NtResumeProcess` in ntdll, on a handle opened with
 * `PROCESS_SUSPEND_RESUME`, stop and start a process where it stands. Measured
 * against the production encoder — FFmpeg pid 11396, a direct child of the
 * worker — 9.469 s of CPU over four seconds running, 0.000000 s over eight
 * seconds suspended, 18.234 s over four seconds after the resume, and the same
 * pid throughout.
 *
 * Reaching it needs P/Invoke, which Node cannot do without a native addon. A
 * native addon is a compiler on the deployment host, a rebuild for every Node
 * version, and a new way for the worker to fail to start; PowerShell is already
 * present, already how this project asks Windows about its volumes, and costs
 * one short-lived process per operator press. So the primitive lives in
 * `windowsProcessSuspend.ps1` beside this file, and this module is the typed,
 * injectable boundary in front of it.
 *
 * Nothing here decides *policy*. Whether a pause may be reported to an operator
 * is `pauseController.ts`'s question; this module only answers whether the
 * operating system did what it was asked.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnManagedProcess } from "../processExecution";

/* ------------------------------------------------------------------ contract */

export type WindowsSuspendAction = "suspend" | "resume";

/**
 * Why a suspension did not happen.
 *
 * Every one of these is a *failure of the transition*, and the caller must not
 * report the encoder as paused on any of them. They are kept apart rather than
 * collapsed into a boolean because they need different operator words: a
 * missing helper is a broken deployment, a denied handle is a permissions
 * problem, and a wrong process is a pid that was recycled underneath us.
 */
export type WindowsSuspendFailure =
  /** The pid was not a positive integer. A guard, not a check. */
  | "invalid-pid"
  /** The helper script is not on disk where this module expects it. */
  | "helper-missing"
  /** PowerShell could not be started, or the script itself threw. */
  | "helper-failed"
  /** The helper did not finish inside its budget and was terminated. */
  | "helper-timeout"
  /** The helper produced something that is not its one-line protocol. */
  | "malformed-output"
  /** The pid exists but is no longer the image the caller named. */
  | "wrong-process"
  /** `OpenProcess` refused the handle. */
  | "access-denied"
  /** The NT call returned a failure status. */
  | "nt-failed"
  /** The call was accepted and the threads did not agree afterwards. */
  | "not-confirmed";

export type WindowsSuspendResult =
  /**
   * The operating system did it. `gone` means the process had already exited,
   * which is not a failure — a child that finished between the request and its
   * delivery is a race that resolved the better way, and it is certainly not
   * running.
   */
  | { ok: true; gone: boolean }
  | { ok: false; failure: WindowsSuspendFailure; detail: string };

export type WindowsProcessSuspender = (
  action: WindowsSuspendAction,
  pid: number,
  imageName?: string,
) => Promise<WindowsSuspendResult>;

/**
 * How long the helper is given.
 *
 * Generous, because the first call in a worker's life pays for `Add-Type`
 * compiling the P/Invoke stub — seconds on PowerShell 5.1, and on a host whose
 * every core is inside an encode. The budget is not a latency target; it is the
 * line past which a pause has demonstrably not happened and must be reported as
 * not having happened.
 */
export const WINDOWS_SUSPEND_TIMEOUT_MS = 30_000;

/** The one line the helper prints. Anything else is malformed output. */
const RESULT_LINE =
  /^SEYIRLIK-SUSPEND status=(\S+) pid=(\d+)(?: detail=(.*))?$/m;

/* --------------------------------------------------------------- helper path */

/**
 * Where the PowerShell helper is, resolved from this module rather than from
 * the working directory.
 *
 * The worker runs from `C:\ProgramData\Seyirlik\app\current` behind a junction,
 * is started by a service manager with a working directory nobody here chose,
 * and is executed straight from TypeScript by `tsx` — so `import.meta.url` is
 * the only thing that reliably names the directory this file was deployed into.
 */
export function windowsSuspendHelperPath(): string {
  return path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "windowsProcessSuspend.ps1",
  );
}

/**
 * The command line, as a pure function of what is being asked.
 *
 * An argument array, never a command string: the pid is numeric and the image
 * name is matched against a narrow pattern, but a helper that suspends
 * processes is exactly the wrong place to leave a shell in the path. `-File`
 * rather than `-Command` for the same reason — the script is a file on disk
 * with a declared, validated parameter block, and nothing about it is assembled
 * from text at call time.
 */
export function buildWindowsSuspendCommand(
  action: WindowsSuspendAction,
  pid: number,
  imageName: string | undefined,
  helperPath: string,
): { command: string; args: readonly string[] } {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    // Unreachable through `createWindowsProcessSuspender`, which checks first.
    throw new Error("A process id must be a positive integer.");
  }
  return {
    command: "powershell.exe",
    args: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      helperPath,
      "-Action",
      action,
      "-TargetProcessId",
      String(pid),
      ...(imageName ? ["-ImageName", imageName] : []),
    ],
  };
}

/* ------------------------------------------------------------------- parsing */

/**
 * The helper's one line, turned into the result the controller acts on.
 *
 * Exported and pure so every branch below can be asserted from a machine that
 * is not Windows — which is the only way the Windows path in this project has
 * ever been kept honest.
 */
export function parseWindowsSuspendOutput(
  action: WindowsSuspendAction,
  stdout: string,
): WindowsSuspendResult {
  const match = RESULT_LINE.exec(stdout);
  if (!match) {
    return {
      ok: false,
      failure: "malformed-output",
      detail: "The suspend helper did not report a status.",
    };
  }
  const status = match[1];
  const detail = (match[3] ?? "").trim();
  const expected = action === "suspend" ? "suspended" : "resumed";
  if (status === expected) return { ok: true, gone: false };
  if (status === "gone") return { ok: true, gone: true };
  switch (status) {
    case "wrong-process":
      return {
        ok: false,
        failure: "wrong-process",
        detail: detail || "That process id belongs to something else now.",
      };
    case "open-failed":
      return {
        ok: false,
        failure: "access-denied",
        detail: detail || "The process could not be opened for suspension.",
      };
    case "nt-failed":
      return {
        ok: false,
        failure: "nt-failed",
        detail: detail || "The suspend call was refused.",
      };
    case "not-confirmed":
      return {
        ok: false,
        failure: "not-confirmed",
        detail:
          detail ||
          `The ${action} was accepted but the process did not agree afterwards.`,
      };
    default:
      return {
        ok: false,
        failure: "malformed-output",
        detail: `The suspend helper reported an unknown status: ${status}.`,
      };
  }
}

/* -------------------------------------------------------- the last resort net */

/**
 * Processes this worker has suspended and not yet resumed.
 *
 * A running orphan finishes and exits. A *suspended* orphan never does: it sits
 * for ever holding its handles on the media volume, invisible to the queue that
 * abandoned it, and the only thing that ends it is a person with Task Manager.
 * That failure mode does not exist before this feature, so it is this feature's
 * to close.
 *
 * The service manager terminating the tree covers the ordinary restart, and
 * `pauseController` resumes before every abort it knows about. This is the case
 * neither covers — the process ending on a path nobody wrote — and it is
 * deliberately the crudest possible net: a synchronous best effort at `exit`,
 * because that handler cannot await anything.
 */
const suspended = new Map<number, string | undefined>();
let netInstalled = false;

function installExitNet(): void {
  if (netInstalled) return;
  netInstalled = true;
  process.once("exit", () => {
    for (const [pid, imageName] of suspended) {
      const { command, args } = buildWindowsSuspendCommand(
        "resume",
        pid,
        imageName,
        windowsSuspendHelperPath(),
      );
      try {
        spawnSync(command, [...args], {
          shell: false,
          windowsHide: true,
          stdio: "ignore",
          timeout: WINDOWS_SUSPEND_TIMEOUT_MS,
        });
      } catch {
        // Exiting anyway. There is nothing above this to tell.
      }
    }
    suspended.clear();
  });
}

/** Pids this worker believes it is holding suspended. For tests and reports. */
export function suspendedWindowsPids(): readonly number[] {
  return [...suspended.keys()];
}

/* -------------------------------------------------------------- the suspender */

export function createWindowsProcessSuspender(
  options: {
    /** Injected by tests. Defaults to running the helper for real. */
    run?: (
      command: string,
      args: readonly string[],
      timeoutMs: number,
    ) => Promise<{ exitCode: number | null; stdout: string; stderr: string }>;
    timeoutMs?: number;
    helperPath?: string;
    /** Injected by tests; defaults to the real filesystem. */
    helperExists?: (helperPath: string) => boolean;
    /** Injected by tests so the exit net is not installed in a test process. */
    track?: boolean;
  } = {},
): WindowsProcessSuspender {
  const run = options.run ?? runHelper;
  const timeoutMs = options.timeoutMs ?? WINDOWS_SUSPEND_TIMEOUT_MS;
  const helperExists = options.helperExists ?? existsSync;
  const track = options.track ?? true;

  return async (action, pid, imageName) => {
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      return {
        ok: false,
        failure: "invalid-pid",
        detail: "There is no process to suspend.",
      };
    }

    const helperPath = options.helperPath ?? windowsSuspendHelperPath();
    if (!helperExists(helperPath)) {
      /*
       * A deployment that copied the TypeScript and not the script beside it.
       * Reported rather than worked around: the alternative is a pause that
       * silently does nothing, which is the entire bug this replaces.
       */
      return {
        ok: false,
        failure: "helper-missing",
        detail: "The process-suspend helper is missing from this installation.",
      };
    }

    const { command, args } = buildWindowsSuspendCommand(
      action,
      pid,
      imageName,
      helperPath,
    );

    let outcome: { exitCode: number | null; stdout: string; stderr: string };
    try {
      outcome = await run(command, args, timeoutMs);
    } catch {
      return {
        ok: false,
        failure: "helper-failed",
        detail: "The process-suspend helper could not be started.",
      };
    }

    if (outcome.exitCode === null) {
      return {
        ok: false,
        failure: "helper-timeout",
        detail: `The ${action} did not finish inside its time budget.`,
      };
    }
    if (outcome.exitCode !== 0) {
      /*
       * Deliberately not the helper's stderr. This string reaches an operator
       * UI, and a PowerShell failure carries the script's own path in it.
       */
      return {
        ok: false,
        failure: "helper-failed",
        detail: `The process-suspend helper exited with code ${outcome.exitCode}.`,
      };
    }

    const result = parseWindowsSuspendOutput(action, outcome.stdout);
    if (track && result.ok) {
      if (action === "suspend" && !result.gone) {
        installExitNet();
        suspended.set(pid, imageName);
      } else {
        suspended.delete(pid);
      }
    }
    return result;
  };
}

/**
 * The real runner.
 *
 * `spawnManagedProcess` rather than a bare `spawn`, so a helper that wedges is
 * bounded and reaped by the same machinery as everything else this project
 * starts. Niceness zero: a person is waiting on this one, and it is milliseconds
 * of work on a machine whose every other thread is an encode at nice 10.
 */
async function runHelper(
  command: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  let stdout = "";
  const managed = spawnManagedProcess({
    command,
    args,
    timeoutMs,
    niceness: 0,
    /*
     * The helper is not the encoder and has no descendants worth chasing. It is
     * also the one place a Windows console host must be left alone — see
     * `usesPosixProcessGroup`, where detaching emptied PowerShell's stdout.
     */
    ownProcessGroup: false,
    onStdout: (chunk) => {
      stdout += chunk;
      if (stdout.length > 64 * 1024) {
        managed.abort("output-limit");
      }
    },
  });
  const outcome = await managed.completed;
  return {
    // An aborted helper is one that ran out of time; `null` is how the caller
    // above tells that from a script that ran and disagreed.
    exitCode: outcome.aborted ? null : outcome.exitCode,
    stdout,
    stderr: outcome.stderrTail,
  };
}

/** The suspender this host uses when nothing injects one. */
export const suspendWindowsProcess: WindowsProcessSuspender =
  createWindowsProcessSuspender();
