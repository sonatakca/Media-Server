import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { PlaybackSessionManager } from "../lib/playback-planner/playbackSessionManager";
import { createNativeRuntime } from "./ownApi/nativeRuntime";
import { installProcessSafetyNet } from "./processSafetyNet";
import {
  FatalWorkerConfigurationError,
  waitForWorkerDependencies,
} from "./workerStartup";
import { createDatabasePool } from "./ownApi/database/databasePool";
import { parseDatabaseConfig } from "./ownApi/database/databaseConfig";

/**
 * Optional dedicated worker process.
 *
 * The API process runs the worker in-process by default, which is the right
 * shape for a single-machine deployment. Running this entry point instead lets
 * scanning and analysis be moved off the box that serves playback, without any
 * change to the code that defines the jobs.
 */
export async function startMediaWorkerFromEnv(): Promise<() => Promise<void>> {
  /*
   * The database is probed through a pool of its own, opened and closed here.
   *
   * Deliberately not the runtime's pool: the runtime cannot be constructed
   * until the dependencies are up, and constructing it to find out whether they
   * are is what made an absent database a fatal startup error rather than
   * something to wait for.
   */
  const databaseConfig = parseDatabaseConfig(process.env);

  /*
   * Wait, do not die. Under `KeepAlive=true` an exit is a relaunch, so throwing
   * at an unmounted drive or a database that has not finished starting after
   * login produced six Node starts a minute for as long as the condition
   * lasted. This blocks instead, on a backoff that reaches thirty seconds
   * within a minute and logs once per transition.
   */
  const dependencies = await waitForWorkerDependencies({
    mediaRoot: process.env.SEYIRLIK_MEDIA_ROOT,
    ...(process.env.SEYIRLIK_PROCESSING_SCRATCH_ROOT
      ? { scratchRoot: process.env.SEYIRLIK_PROCESSING_SCRATCH_ROOT }
      : {}),
    probeDatabase: async () => {
      const pool = createDatabasePool(databaseConfig);
      try {
        await pool.query("SELECT 1");
      } finally {
        await pool.end().catch(() => undefined);
      }
    },
  });
  const resolvedMediaRoot = dependencies.mediaRoot;
  const rawSoftwareThreads = process.env.SEYIRLIK_SOFTWARE_TRANSCODE_THREADS;
  const parsedSoftwareThreads = rawSoftwareThreads
    ? Number(rawSoftwareThreads)
    : undefined;
  if (
    parsedSoftwareThreads !== undefined &&
    (!Number.isInteger(parsedSoftwareThreads) || parsedSoftwareThreads <= 0)
  ) {
    throw new FatalWorkerConfigurationError(
      "SEYIRLIK_SOFTWARE_TRANSCODE_THREADS must be a positive integer.",
    );
  }
  // The worker never serves playback; the manager exists only to satisfy the
  // runtime's contract and is configured to do nothing.
  const sessionManager = new PlaybackSessionManager({
    outputRoot: process.env.SEYIRLIK_GENERATED_STORAGE ?? tmpdir(),
    maxConcurrentVideoTranscodes: 1,
  });

  /*
   * The runtime's own database check can still fail here, in the gap between
   * the wait above and this call — Docker restarting, a pool that dials while
   * PostgreSQL is mid-recovery. Left alone that is an exit, and an exit is a
   * relaunch, and the relaunch would wait correctly but only after paying for
   * another Node start. Retrying through the same backoff keeps it in one
   * process. A schema that is out of date is deliberately *not* retried: that
   * needs `npm run db:migrate`, and waiting for it would hide the instruction.
   */
  const buildRuntime = () =>
    createNativeRuntime({
      mediaRoot: resolvedMediaRoot,
      sessionManager,
      generatedStoragePath: process.env.SEYIRLIK_GENERATED_STORAGE ?? tmpdir(),
      // The encoder path matters as much here as it does in the API process —
      // more, in fact, since this is where the encoding happens. Without it a
      // split deployment quietly encoded with whatever `ffmpeg` was first on the
      // PATH rather than the build the machine was configured for.
      ...(process.env.SEYIRLIK_FFMPEG_PATH
        ? { ffmpegPath: process.env.SEYIRLIK_FFMPEG_PATH }
        : {}),
      ...(process.env.SEYIRLIK_FFPROBE_PATH
        ? { ffprobePath: process.env.SEYIRLIK_FFPROBE_PATH }
        : {}),
      ...(parsedSoftwareThreads === undefined
        ? {}
        : { softwareTranscodeThreads: parsedSoftwareThreads }),
      runWorker: true,
    });

  let runtime: Awaited<ReturnType<typeof createNativeRuntime>>;
  for (let attempt = 1; ; attempt += 1) {
    try {
      runtime = await buildRuntime();
      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("The database is unavailable.") || attempt > 10) {
        throw error;
      }
      const wait = Math.min(30_000, 1_000 * 2 ** (attempt - 1));
      if (attempt === 1) {
        console.warn(
          "[Seyirlik Worker] database.unavailable: waiting rather than exiting.",
        );
      }
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }

  console.info(
    `Seyirlik worker running against media root: ${resolvedMediaRoot}`,
  );

  const shutdown = async (signal: NodeJS.Signals) => {
    console.info(`[Seyirlik Worker] ${signal} received; shutting down.`);

    // An encoder that is slow to take its signal must not hold the process open
    // indefinitely; the supervisor is waiting to start the replacement.
    const deadline = setTimeout(() => {
      console.error(
        "[Seyirlik Worker] Shutdown did not finish in time; exiting anyway.",
      );
      process.exit(0);
    }, 15_000);

    try {
      await runtime.close();
      clearTimeout(deadline);
      process.exit(0);
    } catch (error) {
      clearTimeout(deadline);
      console.error(
        "[Seyirlik Worker] Shutdown failed:",
        error instanceof Error ? error.message : String(error),
      );
      process.exit(1);
    }
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  return runtime.close;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  let started = false;
  installProcessSafetyNet(() => started);

  startMediaWorkerFromEnv()
    .then(() => {
      started = true;
    })
    .catch((error) => {
      /*
       * Only genuinely fatal configuration reaches here now — the recoverable
       * dependencies were waited for rather than thrown at. Exiting is still
       * right for these: the supervisor's relaunch fails identically, which is
       * exactly the amount of noise a mistake needing a person deserves, and
       * unlike the old behaviour it is no longer what an unplugged drive does.
       */
      console.error(
        error instanceof FatalWorkerConfigurationError
          ? "[Seyirlik Worker] Configuration is invalid, and waiting will not fix it:"
          : "[Seyirlik Worker] Startup failed:",
        error instanceof Error ? error.message : String(error),
      );
      process.exit(1);
    });
}
