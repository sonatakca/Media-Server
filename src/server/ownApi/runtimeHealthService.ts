import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, rm, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import {
  buildOwnApiHealthStatus,
  type OptionalDependencyStatus,
  type OwnApiHealthService,
  type OwnApiHealthStatus,
} from "./ownApiHandler";

export interface RuntimeHealthServiceOptions {
  ffmpegPath?: string;
  ffprobePath?: string;
  mediaStoragePath: string;
  generatedStoragePath: string;
  databaseCheck?: () => Promise<OptionalDependencyStatus>;
  jobsCheck?: () => Promise<OptionalDependencyStatus>;
  commandProbe?: (command: string) => Promise<boolean>;
  readableDirectoryProbe?: (directoryPath: string) => Promise<boolean>;
  writableDirectoryProbe?: (directoryPath: string) => Promise<boolean>;
  cacheTtlMs?: number;
  probeTimeoutMs?: number;
  now?: () => number;
}

const COMMAND_TIMEOUT_MS = 2_000;

async function probeCommand(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, ["-version"], {
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    });
    let settled = false;

    const finish = (result: boolean) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish(false);
    }, COMMAND_TIMEOUT_MS);

    timeout.unref();
    child.once("error", () => finish(false));
    child.once("exit", (code) => finish(code === 0));
  });
}

async function probeReadableDirectory(directoryPath: string): Promise<boolean> {
  const directory = await stat(directoryPath);

  if (!directory.isDirectory()) {
    return false;
  }

  await access(directoryPath, constants.R_OK);
  return true;
}

async function probeWritableDirectory(directoryPath: string): Promise<boolean> {
  const directory = await stat(directoryPath);

  if (!directory.isDirectory()) {
    return false;
  }

  await access(directoryPath, constants.R_OK | constants.W_OK);

  const probePath = path.join(
    directoryPath,
    `.seyirlik-health-${randomUUID()}.tmp`,
  );

  try {
    await writeFile(probePath, "", { flag: "wx" });
    return true;
  } finally {
    await rm(probePath, { force: true }).catch(() => undefined);
  }
}

/**
 * One outstanding attempt per probe, however often the probe is asked for.
 *
 * `safelyWithin` gives up on a probe after a couple of seconds and answers
 * `false`, which keeps `/health` fast — but it does not, and cannot, stop the
 * work. A `stat` blocked in the kernel on a volume that has stopped answering
 * holds a libuv worker thread until the volume answers or the process ends, and
 * the pool has four of them. Vite polls this endpoint continuously; the cache
 * expires every ten seconds; without this guard each expiry launched a fresh
 * `stat` against the same dead mount, and inside a minute every libuv worker in
 * the process was gone — taking the file reads that serve video with them.
 *
 * So a probe that has not come back is not started again. The answer stays the
 * timeout fallback, which is the truthful one, and exactly one thread is lost
 * rather than all of them.
 */
function singleFlight<T>(operation: () => Promise<T>): () => Promise<T> {
  let inFlight: Promise<T> | undefined;

  return () => {
    if (inFlight) return inFlight;
    const running = operation().finally(() => {
      if (inFlight === running) inFlight = undefined;
    });
    inFlight = running;
    return running;
  };
}

async function safelyWithin<T>(
  operation: () => Promise<T>,
  fallback: T,
  timeoutMs: number,
): Promise<T> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: T) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };
    const timeout = setTimeout(() => finish(fallback), Math.max(1, timeoutMs));

    void Promise.resolve()
      .then(operation)
      .then((result) => finish(result))
      .catch(() => finish(fallback));
  });
}

export function createRuntimeHealthService({
  ffmpegPath = "ffmpeg",
  ffprobePath = "ffprobe",
  mediaStoragePath,
  generatedStoragePath,
  databaseCheck = async () => "unavailable",
  jobsCheck = async () => "disabled",
  commandProbe = probeCommand,
  readableDirectoryProbe = probeReadableDirectory,
  writableDirectoryProbe = probeWritableDirectory,
  cacheTtlMs = 10_000,
  probeTimeoutMs = 2_000,
  now = Date.now,
}: RuntimeHealthServiceOptions): OwnApiHealthService {
  let cached: { expiresAt: number; status: OwnApiHealthStatus } | undefined;
  let inFlight: Promise<OwnApiHealthStatus> | undefined;

  const probeDatabase = singleFlight(databaseCheck);
  const probeJobs = singleFlight(jobsCheck);
  const probeFfmpeg = singleFlight(() => commandProbe(ffmpegPath));
  const probeFfprobe = singleFlight(() => commandProbe(ffprobePath));
  const probeMediaStorage = singleFlight(() =>
    readableDirectoryProbe(mediaStoragePath),
  );
  const probeGeneratedStorage = singleFlight(() =>
    writableDirectoryProbe(generatedStoragePath),
  );

  const runProbes = async (): Promise<OwnApiHealthStatus> => {
    const [
      database,
      jobs,
      ffmpegAvailable,
      ffprobeAvailable,
      mediaStorageAvailable,
      generatedStorageWritable,
    ] = await Promise.all([
      safelyWithin(probeDatabase, "unavailable", probeTimeoutMs),
      safelyWithin(probeJobs, "unavailable", probeTimeoutMs),
      safelyWithin(probeFfmpeg, false, probeTimeoutMs),
      safelyWithin(probeFfprobe, false, probeTimeoutMs),
      safelyWithin(probeMediaStorage, false, probeTimeoutMs),
      safelyWithin(probeGeneratedStorage, false, probeTimeoutMs),
    ]);

    return buildOwnApiHealthStatus({
      database,
      jobs,
      ffmpeg: ffmpegAvailable ? "available" : "unavailable",
      ffprobe: ffprobeAvailable ? "available" : "unavailable",
      mediaStorage: mediaStorageAvailable ? "available" : "unavailable",
      generatedStorage: generatedStorageWritable ? "writable" : "unavailable",
    });
  };

  return {
    getStatus: async () => {
      const checkedAt = now();

      if (cached && checkedAt < cached.expiresAt) {
        return cached.status;
      }

      if (inFlight) {
        return inFlight;
      }

      const probePromise = runProbes()
        .then((status) => {
          cached = {
            status,
            expiresAt: now() + Math.max(0, cacheTtlMs),
          };
          return status;
        })
        .finally(() => {
          if (inFlight === probePromise) {
            inFlight = undefined;
          }
        });

      inFlight = probePromise;
      return probePromise;
    },
  };
}
