import { spawn } from "node:child_process";

/**
 * Restarting the server from the browser.
 *
 * A process cannot restart itself. Something has to start the replacement, and
 * which "something" that is depends entirely on how the server was launched —
 * which is why this is configuration rather than a guess. Getting it wrong is
 * not a small mistake: choosing `supervisor` with no supervisor leaves the
 * server stopped with no way to start it from the browser, and choosing
 * `respawn` under systemd starts two servers fighting over one port.
 */

export type RestartMode = "disabled" | "respawn" | "supervisor";

export interface RestartConfig {
  mode: RestartMode;
  /** Exit status handed to a supervisor. Zero, because this is a clean stop. */
  exitCode: number;
  /**
   * How long the process keeps serving after accepting the request.
   *
   * The `202` has to reach the browser before the socket closes, or the page
   * that asked for the restart sees a network error instead of an
   * acknowledgement and cannot tell a working restart from a failed one.
   */
  graceMs: number;
}

export const DEFAULT_RESTART_GRACE_MS = 250;

const MODES: RestartMode[] = ["disabled", "respawn", "supervisor"];

type Environment = Record<string, string | undefined>;

/**
 * Whether something is already watching this process and will restart it.
 *
 * Both supervisors leave a marker in the environment: systemd sets
 * `INVOCATION_ID` for every unit it starts, and launchd sets
 * `XPC_SERVICE_NAME` to the job label, where a plain shell has either no such
 * variable or the placeholder `0`.
 */
function hasSupervisor(environment: Environment): boolean {
  if (environment.INVOCATION_ID) return true;
  const launchdLabel = environment.XPC_SERVICE_NAME?.trim();
  return Boolean(launchdLabel) && launchdLabel !== "0";
}

/**
 * Reads the restart policy.
 *
 * The default is `respawn`, because that is what makes the button work for the
 * documented way of running Seyirlik — `npm run server`, with nothing watching
 * the process. systemd and launchd are detected and switched to `supervisor`
 * automatically, since under either of them respawning would double-start and
 * leave two servers fighting over one port. Anything else that supervises the
 * process — Docker with a restart policy, pm2 — has to say so, because there is
 * no marker to read.
 */
export function parseRestartConfig(
  environment: Environment = process.env,
): RestartConfig {
  const raw = environment.SEYIRLIK_RESTART_MODE?.trim().toLowerCase();

  let mode: RestartMode;
  if (raw === undefined || raw === "") {
    mode = hasSupervisor(environment) ? "supervisor" : "respawn";
  } else {
    const match = MODES.find((candidate) => candidate === raw);
    if (!match) {
      throw new Error(
        `SEYIRLIK_RESTART_MODE must be one of ${MODES.join(", ")}.`,
      );
    }
    mode = match;
  }

  return { mode, exitCode: 0, graceMs: DEFAULT_RESTART_GRACE_MS };
}

export interface RestartStatus {
  mode: RestartMode;
  /** False when the mode is `disabled`. */
  available: boolean;
  /** True once a restart has been accepted and shutdown is under way. */
  inProgress: boolean;
}

export interface RestartRequestResult extends RestartStatus {
  accepted: boolean;
}

export interface RestartController {
  status(): RestartStatus;
  /**
   * Accepts a restart and returns immediately.
   *
   * The work is scheduled rather than awaited so the route can answer before
   * the server it is answering from stops listening.
   */
  request(): RestartRequestResult;
  /** Resolves when a scheduled restart has finished its shutdown. Tests only. */
  settled(): Promise<void>;
}

export interface CreateRestartControllerOptions {
  config: RestartConfig;
  /** Graceful shutdown. Must release the listening port before it resolves. */
  close(): Promise<void>;
  /** Starts the replacement process. Never called outside `respawn` mode. */
  spawnReplacement(): void;
  exit(code: number): void;
  delay(ms: number): Promise<void>;
  logger?: {
    info(message: string): void;
    error(message: string): void;
  };
}

export function createRestartController({
  config,
  close,
  spawnReplacement,
  exit,
  delay,
  logger,
}: CreateRestartControllerOptions): RestartController {
  let inProgress = false;
  let running: Promise<void> = Promise.resolve();

  async function performRestart(): Promise<void> {
    await delay(config.graceMs);

    try {
      /*
       * Shut down before starting anything else.
       *
       * The replacement binds the same port, so the old process has to have
       * stopped listening first — spawning before closing is a race the child
       * loses with EADDRINUSE, and the parent is by then already on its way
       * out with nothing left to report the failure.
       */
      await close();
    } catch (error) {
      logger?.error(
        `[Seyirlik] Restart shutdown failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    if (config.mode === "respawn") {
      try {
        spawnReplacement();
      } catch (error) {
        // Nothing is listening at this point and the replacement did not
        // start, so this line is the only record an operator will have.
        logger?.error(
          `[Seyirlik] Could not start the replacement process: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    logger?.info("[Seyirlik] Restarting.");
    exit(config.exitCode);
  }

  return {
    status: () => ({
      mode: config.mode,
      available: config.mode !== "disabled",
      inProgress,
    }),

    request: () => {
      const base = {
        mode: config.mode,
        available: config.mode !== "disabled",
      };

      if (config.mode === "disabled") {
        return { ...base, accepted: false, inProgress: false };
      }
      // A second press while the first restart is already shutting down is the
      // same request, not a new one; accepting it idempotently keeps the page
      // that sent it on the "waiting for the server" path.
      if (inProgress) {
        return { ...base, accepted: true, inProgress: true };
      }

      inProgress = true;
      running = performRestart();
      void running.catch(() => undefined);
      return { ...base, accepted: true, inProgress: true };
    },

    settled: () => running,
  };
}

/**
 * Re-runs this process's own command line, detached.
 *
 * `execArgv` carries the Node options the process was started with — the
 * `--env-file` and `--import tsx` that `npm run server` supplies — and
 * `argv.slice(1)` carries the script and its arguments. Rebuilding from both,
 * with the same working directory and environment, is what makes the
 * replacement the same server rather than a differently configured one.
 *
 * Detached and unreferenced so it outlives the exit that follows, with stdio
 * inherited so its output still lands in the terminal the operator started
 * Seyirlik in.
 */
export function respawnCurrentProcess(): void {
  const child = spawn(
    process.execPath,
    [...process.execArgv, ...process.argv.slice(1)],
    {
      cwd: process.cwd(),
      env: process.env,
      detached: true,
      stdio: "inherit",
    },
  );
  child.unref();
}
