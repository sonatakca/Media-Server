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

  const runProbes = async (): Promise<OwnApiHealthStatus> => {
    const [
      database,
      jobs,
      ffmpegAvailable,
      ffprobeAvailable,
      mediaStorageAvailable,
      generatedStorageWritable,
    ] = await Promise.all([
      safelyWithin(databaseCheck, "unavailable", probeTimeoutMs),
      safelyWithin(jobsCheck, "unavailable", probeTimeoutMs),
      safelyWithin(() => commandProbe(ffmpegPath), false, probeTimeoutMs),
      safelyWithin(() => commandProbe(ffprobePath), false, probeTimeoutMs),
      safelyWithin(
        () => readableDirectoryProbe(mediaStoragePath),
        false,
        probeTimeoutMs,
      ),
      safelyWithin(
        () => writableDirectoryProbe(generatedStoragePath),
        false,
        probeTimeoutMs,
      ),
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
