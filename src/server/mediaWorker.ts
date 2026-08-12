import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { assertMediaRootDirectory } from "./pathSecurity";
import { PlaybackSessionManager } from "../lib/playback-planner/playbackSessionManager";
import { createNativeRuntime } from "./ownApi/nativeRuntime";

/**
 * Optional dedicated worker process.
 *
 * The API process runs the worker in-process by default, which is the right
 * shape for a single-machine deployment. Running this entry point instead lets
 * scanning and analysis be moved off the box that serves playback, without any
 * change to the code that defines the jobs.
 */
export async function startMediaWorkerFromEnv(): Promise<() => Promise<void>> {
  const mediaRoot = process.env.SEYIRLIK_MEDIA_ROOT;
  if (!mediaRoot) {
    throw new Error("SEYIRLIK_MEDIA_ROOT is required.");
  }

  const resolvedMediaRoot = await assertMediaRootDirectory(mediaRoot);
  // The worker never serves playback; the manager exists only to satisfy the
  // runtime's contract and is configured to do nothing.
  const sessionManager = new PlaybackSessionManager({
    outputRoot: process.env.SEYIRLIK_GENERATED_STORAGE ?? tmpdir(),
    maxConcurrentVideoTranscodes: 1,
  });

  const runtime = await createNativeRuntime({
    mediaRoot: resolvedMediaRoot,
    sessionManager,
    generatedStoragePath: process.env.SEYIRLIK_GENERATED_STORAGE ?? tmpdir(),
    ...(process.env.SEYIRLIK_FFPROBE_PATH
      ? { ffprobePath: process.env.SEYIRLIK_FFPROBE_PATH }
      : {}),
    runWorker: true,
  });

  console.info(
    `Seyirlik worker running against media root: ${resolvedMediaRoot}`,
  );

  const shutdown = async (signal: NodeJS.Signals) => {
    console.info(`[Seyirlik Worker] ${signal} received; shutting down.`);
    try {
      await runtime.close();
      process.exit(0);
    } catch (error) {
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
  startMediaWorkerFromEnv().catch((error) => {
    console.error(
      "[Seyirlik Worker] Startup failed:",
      error instanceof Error ? error.message : String(error),
    );
    process.exit(1);
  });
}
