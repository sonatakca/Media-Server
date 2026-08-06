import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type {
  DriveSpace,
  RenditionAnalysisItem,
  RenditionAnalysisReport,
  RenditionPaths,
} from "./analysis";
import { getDriveSpace } from "./analysis";
import { buildRenditionFfmpegArgs } from "./encoding";
import { acquireDirectoryLock } from "./locks";
import { DEFAULT_STORAGE_SAFETY_MARGIN } from "./planning";
import {
  RENDITION_PROFILE_VERSION,
  buildRenditionRequirements,
  classifyQualityHeight,
  getDisplayDimensions,
} from "./policy";
import { probeMediaFile } from "./probe";
import { computeSourceFingerprint } from "./registry";
import {
  inspectCompletedRendition,
  validateCompletedVersion,
  RENDITION_POINTER_SCHEMA_VERSION,
  RENDITION_METADATA_SCHEMA_VERSION,
  type RenditionMetadata,
  type RenditionFileMetadata,
} from "./validation";

const MAX_LOG_BYTES = 1024 * 1024;

export interface VariantValidationProbe {
  durationSeconds: number;
  width: number;
  height: number;
  videoCodec: string;
  audioCodec: string;
  audioLanguage?: string;
  frameRate?: number;
  averageBitrate?: number;
}

export interface RenditionProcessorOptions {
  ffmpegPath?: string;
  ffprobePath?: string;
  reserveBytes: number;
  driveSpaceProvider?: () => Promise<DriveSpace>;
  runEncoder?: (
    command: string,
    args: string[],
    options: { signal?: AbortSignal; logPath: string },
  ) => Promise<void>;
  probeVariant?: (filePath: string) => Promise<VariantValidationProbe>;
  verifySourceFingerprint?: boolean;
  signal?: AbortSignal;
  dryRun?: boolean;
}

export interface RenditionProcessResult {
  mediaId: string;
  relativePath: string;
  status:
    | "ready"
    | "already-valid"
    | "failed"
    | "deferred-for-storage"
    | "interrupted"
    | "dry-run";
  error?: string;
  versionDirectory?: string;
}

function safeSourcePath(mediaRoot: string, relativePath: string): string {
  const sourcePath = path.resolve(mediaRoot, ...relativePath.split("/"));
  const normalizedRoot = path.resolve(mediaRoot);
  const comparisonRoot =
    process.platform === "win32"
      ? normalizedRoot.toLowerCase()
      : normalizedRoot;
  const comparisonSource =
    process.platform === "win32" ? sourcePath.toLowerCase() : sourcePath;
  if (
    comparisonSource === comparisonRoot ||
    !comparisonSource.startsWith(`${comparisonRoot}${path.sep}`)
  ) {
    throw new Error("Media source path escapes the configured media root.");
  }
  return sourcePath;
}

async function appendBoundedLog(logPath: string, text: string): Promise<void> {
  await mkdir(path.dirname(logPath), { recursive: true });
  await appendFile(logPath, text, "utf8");
  const logStats = await stat(logPath);
  if (logStats.size <= MAX_LOG_BYTES) return;
  const content = await readFile(logPath);
  await writeFile(logPath, content.subarray(content.length - MAX_LOG_BYTES));
}

export async function runFfmpeg(
  command: string,
  args: string[],
  { signal, logPath }: { signal?: AbortSignal; logPath: string },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderrTail = "";
    let settled = false;
    const complete = (error?: Error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    };
    const onAbort = () => {
      child.kill("SIGTERM");
      complete(new Error("FFmpeg was cancelled."));
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderrTail = `${stderrTail}${chunk}`.slice(-32_768);
      void appendBoundedLog(logPath, chunk).catch(() => undefined);
    });
    child.once("error", (error) => complete(error));
    child.once("close", (code) => {
      if (settled) return;
      if (code === 0) complete();
      else
        complete(
          new Error(
            `FFmpeg failed with exit code ${code ?? "unknown"}: ${stderrTail}`,
          ),
        );
    });
  });
}

async function defaultProbeVariant(
  filePath: string,
  ffprobePath?: string,
): Promise<VariantValidationProbe> {
  const probe = await probeMediaFile(filePath, ffprobePath);
  return {
    durationSeconds: probe.durationSeconds,
    width: probe.video.width,
    height: probe.video.height,
    videoCodec: probe.video.codec,
    audioCodec: probe.audioTracks[0]?.codec ?? "missing",
    audioLanguage: probe.audioTracks[0]?.language,
    frameRate: probe.video.frameRate,
    averageBitrate: probe.overallBitrate,
  };
}

function validateVariantProbe(
  sourceDuration: number,
  expectedWidth: number,
  expectedHeight: number,
  probe: VariantValidationProbe,
  expectedAudioLanguage?: string,
): void {
  if (probe.width !== expectedWidth || probe.height !== expectedHeight) {
    throw new Error(
      `Validated rendition dimensions ${probe.width}x${probe.height} do not match ${expectedWidth}x${expectedHeight}.`,
    );
  }
  if (probe.videoCodec.toLowerCase() !== "h264") {
    throw new Error(
      `Validated rendition video codec is ${probe.videoCodec}, not H.264.`,
    );
  }
  if (probe.audioCodec.toLowerCase() !== "aac") {
    throw new Error(
      `Validated rendition audio codec is ${probe.audioCodec}, not AAC.`,
    );
  }
  if (
    expectedAudioLanguage &&
    (probe.audioLanguage ?? "und").toLowerCase() !==
      expectedAudioLanguage.toLowerCase()
  ) {
    throw new Error("Validated rendition audio language metadata changed.");
  }
  const tolerance = Math.max(2, sourceDuration * 0.02);
  if (Math.abs(probe.durationSeconds - sourceDuration) > tolerance) {
    throw new Error(
      "Validated rendition duration differs from the source beyond tolerance.",
    );
  }
}

async function writeCurrentPointer(
  mediaRoot: string,
  versionDirectory: string,
  sourceFingerprint: string,
): Promise<void> {
  const pointerPath = path.join(mediaRoot, "current.json");
  const temporaryPath = `${pointerPath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(
    temporaryPath,
    `${JSON.stringify(
      {
        schemaVersion: RENDITION_POINTER_SCHEMA_VERSION,
        versionDirectory,
        sourceFingerprint,
        profileVersion: RENDITION_PROFILE_VERSION,
      },
      null,
      2,
    )}\n`,
    { encoding: "utf8", flag: "wx" },
  );
  try {
    await rename(temporaryPath, pointerPath);
  } catch (error) {
    if (process.platform !== "win32") {
      await rm(temporaryPath, { force: true });
      throw error;
    }
    const previousPath = `${pointerPath}.${randomUUID()}.previous`;
    try {
      await rename(pointerPath, previousPath);
      await rename(temporaryPath, pointerPath);
      await rm(previousPath, { force: true });
    } catch (replacementError) {
      await rename(previousPath, pointerPath).catch(() => undefined);
      await rm(temporaryPath, { force: true });
      throw replacementError;
    }
  }
}

export async function processRenditionItem(
  item: RenditionAnalysisItem,
  paths: RenditionPaths,
  {
    ffmpegPath = process.env.FFMPEG_PATH ??
      process.env.SEYIRLIK_FFMPEG_PATH ??
      "ffmpeg",
    ffprobePath,
    reserveBytes,
    driveSpaceProvider = () => getDriveSpace(paths.mediaRoot),
    runEncoder = runFfmpeg,
    probeVariant = (playlistPath) =>
      defaultProbeVariant(playlistPath, ffprobePath),
    verifySourceFingerprint = true,
    signal,
    dryRun = false,
  }: RenditionProcessorOptions,
): Promise<RenditionProcessResult> {
  if (!item.probe || item.jobs.length === 0) {
    return {
      mediaId: item.mediaId,
      relativePath: item.relativePath,
      status:
        item.status === "deferred-for-storage"
          ? "deferred-for-storage"
          : "already-valid",
    };
  }
  if (signal?.aborted) {
    return {
      mediaId: item.mediaId,
      relativePath: item.relativePath,
      status: "interrupted",
    };
  }
  if (dryRun) {
    return {
      mediaId: item.mediaId,
      relativePath: item.relativePath,
      status: "dry-run",
    };
  }

  const lock = await acquireDirectoryLock(
    path.join(paths.stateRoot, "locks", `${item.mediaId}.lock`),
    `rendition:${item.mediaId}`,
  );
  try {
    const completed = await inspectCompletedRendition({
      mediaRoot: path.join(paths.renditionRoot, item.mediaId),
      mediaId: item.mediaId,
      sourceFingerprint: item.sourceFingerprint,
      profileVersion: RENDITION_PROFILE_VERSION,
    });
    if (
      completed.status === "ready" &&
      item.jobs.every((job) =>
        completed.metadata?.files.some(
          (file) => file.qualityHeight === job.qualityHeight,
        ),
      )
    ) {
      return {
        mediaId: item.mediaId,
        relativePath: item.relativePath,
        status: "already-valid",
      };
    }

    const sourcePath = safeSourcePath(paths.mediaRoot, item.relativePath);
    if (verifySourceFingerprint) {
      const sourceStats = await stat(sourcePath);
      const currentFingerprint = await computeSourceFingerprint(
        sourcePath,
        sourceStats,
      );
      if (currentFingerprint !== item.sourceFingerprint) {
        throw new Error(
          "Source changed after analysis; run analysis again before processing.",
        );
      }
    }

    const drive = await driveSpaceProvider();
    const estimatedJobBytes = item.jobs.reduce(
      (total, job) => total + job.estimatedBytes,
      0,
    );
    const conservativeJobBytes = Math.ceil(
      estimatedJobBytes * (1 + DEFAULT_STORAGE_SAFETY_MARGIN),
    );
    if (drive.freeBytes - conservativeJobBytes < reserveBytes) {
      return {
        mediaId: item.mediaId,
        relativePath: item.relativePath,
        status: "deferred-for-storage",
        error: "Free-space check would breach the configured reserve.",
      };
    }

    const versionDirectory = `${RENDITION_PROFILE_VERSION}-${item.sourceFingerprint.slice(0, 16)}`;
    const mediaRoot = path.join(paths.renditionRoot, item.mediaId);
    const finalVersionRoot = path.join(mediaRoot, versionDirectory);
    try {
      await validateCompletedVersion({
        versionRoot: finalVersionRoot,
        mediaId: item.mediaId,
        sourceFingerprint: item.sourceFingerprint,
        profileVersion: RENDITION_PROFILE_VERSION,
      });
      await mkdir(mediaRoot, { recursive: true });
      await writeCurrentPointer(
        mediaRoot,
        versionDirectory,
        item.sourceFingerprint,
      );
      return {
        mediaId: item.mediaId,
        relativePath: item.relativePath,
        status: "already-valid",
        versionDirectory,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        try {
          const finalStats = await stat(finalVersionRoot);
          if (finalStats.isDirectory()) {
            throw new Error(
              "A deterministic completed-version directory exists but is invalid; validate and explicitly clean stale generated output before retrying.",
            );
          }
        } catch (statError) {
          if ((statError as NodeJS.ErrnoException).code !== "ENOENT")
            throw statError;
        }
      }
    }

    const workVersionRoot = path.join(
      paths.workRoot,
      item.mediaId,
      `${versionDirectory}.partial`,
    );
    const logPath = path.join(paths.logsRoot, `${item.mediaId}.log`);
    await mkdir(workVersionRoot, { recursive: true });
    const requirementsByQuality = new Map(
      buildRenditionRequirements(item.probe.video).map((requirement) => [
        requirement.qualityHeight,
        requirement,
      ]),
    );
    const files: RenditionFileMetadata[] = [];
    const sourceAudioTrack =
      item.probe.audioTracks.find((track) => track.isDefault) ??
      item.probe.audioTracks[0];
    if (!sourceAudioTrack) {
      throw new Error("Source does not contain the required audio stream.");
    }

    for (const job of [...item.jobs].sort(
      (left, right) => left.qualityHeight - right.qualityHeight,
    )) {
      if (signal?.aborted) {
        return {
          mediaId: item.mediaId,
          relativePath: item.relativePath,
          status: "interrupted",
        };
      }
      const requirement = requirementsByQuality.get(job.qualityHeight);
      if (!requirement)
        throw new Error(
          `No rendition requirement exists for ${job.qualityHeight}p.`,
        );
      const finalFileName = `${job.qualityHeight}p.mp4`;
      const finalFilePath = path.join(workVersionRoot, finalFileName);
      const partialFilePath = path.join(
        workVersionRoot,
        `${job.qualityHeight}p.partial.mp4`,
      );
      let variantProbe: VariantValidationProbe | undefined;
      try {
        const finalStats = await stat(finalFilePath);
        if (!finalStats.isFile() || finalStats.size <= 0) {
          throw new Error(
            "Existing complete rendition file is missing or empty.",
          );
        }
        variantProbe = await probeVariant(finalFilePath);
        validateVariantProbe(
          item.probe.durationSeconds,
          requirement.width,
          requirement.height,
          variantProbe,
          sourceAudioTrack.language,
        );
      } catch {
        await rm(finalFilePath, { force: true });
        await rm(partialFilePath, { force: true });
        const currentDrive = await driveSpaceProvider();
        const conservativeFileBytes = Math.ceil(
          job.estimatedBytes * (1 + DEFAULT_STORAGE_SAFETY_MARGIN),
        );
        if (currentDrive.freeBytes - conservativeFileBytes < reserveBytes) {
          return {
            mediaId: item.mediaId,
            relativePath: item.relativePath,
            status: "deferred-for-storage",
            error: `Free-space check before ${job.qualityHeight}p would breach the configured reserve.`,
          };
        }
        const args = buildRenditionFfmpegArgs({
          inputPath: sourcePath,
          outputPath: partialFilePath,
          qualityHeight: requirement.qualityHeight,
          width: requirement.width,
          height: requirement.height,
          audioStreamIndex: sourceAudioTrack.streamIndex,
          audioLanguage: sourceAudioTrack.language,
        });
        await runEncoder(ffmpegPath, args, { signal, logPath });
        const partialStats = await stat(partialFilePath);
        if (!partialStats.isFile() || partialStats.size <= 0) {
          throw new Error(
            "FFmpeg did not produce a non-empty complete MP4 file.",
          );
        }
        variantProbe = await probeVariant(partialFilePath);
        validateVariantProbe(
          item.probe.durationSeconds,
          requirement.width,
          requirement.height,
          variantProbe,
          sourceAudioTrack.language,
        );
        await rename(partialFilePath, finalFilePath);
      }
      const finalStats = await stat(finalFilePath);
      files.push({
        qualityHeight: requirement.qualityHeight,
        width: requirement.width,
        height: requirement.height,
        bitrate: variantProbe.averageBitrate,
        fileSize: finalStats.size,
        videoCodec: "h264",
        audioCodec: "aac",
        container: "mp4",
        frameRate: variantProbe.frameRate,
        file: finalFileName,
        sourceAudioStreamIndex: sourceAudioTrack.streamIndex,
        audioLanguage: sourceAudioTrack.language,
      });
    }

    const durationToleranceSeconds = Math.max(
      2,
      item.probe.durationSeconds * 0.02,
    );
    const metadata: RenditionMetadata = {
      schemaVersion: RENDITION_METADATA_SCHEMA_VERSION,
      mediaId: item.mediaId,
      sourceFingerprint: item.sourceFingerprint,
      profileVersion: RENDITION_PROFILE_VERSION,
      createdAt: new Date().toISOString(),
      durationSeconds: item.probe.durationSeconds,
      original: {
        width: getDisplayDimensions(item.probe.video).width,
        height: getDisplayDimensions(item.probe.video).height,
        qualityHeight: classifyQualityHeight(item.probe.video),
        codec: item.probe.video.codec,
      },
      files,
      audioStrategy: "default-track-only",
      subtitleStrategy: "original-playback-only",
      validation: {
        validatedAt: new Date().toISOString(),
        durationToleranceSeconds,
      },
    };
    await writeFile(
      path.join(workVersionRoot, "metadata.json"),
      `${JSON.stringify(metadata, null, 2)}\n`,
      "utf8",
    );
    await validateCompletedVersion({
      versionRoot: workVersionRoot,
      mediaId: item.mediaId,
      sourceFingerprint: item.sourceFingerprint,
      profileVersion: RENDITION_PROFILE_VERSION,
    });

    await mkdir(mediaRoot, { recursive: true });
    await rename(workVersionRoot, finalVersionRoot);
    await writeCurrentPointer(
      mediaRoot,
      versionDirectory,
      item.sourceFingerprint,
    );
    await rm(path.dirname(workVersionRoot), {
      recursive: true,
      force: true,
    }).catch(() => undefined);
    return {
      mediaId: item.mediaId,
      relativePath: item.relativePath,
      status: "ready",
      versionDirectory,
    };
  } catch (error) {
    return {
      mediaId: item.mediaId,
      relativePath: item.relativePath,
      status: signal?.aborted ? "interrupted" : "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await lock.release();
  }
}

export interface ProcessReportOptions extends RenditionProcessorOptions {
  library?: string;
  mediaId?: string;
  workerCount?: number;
  maxRetries?: number;
}

export async function processRenditionReport(
  report: RenditionAnalysisReport,
  paths: RenditionPaths,
  options: ProcessReportOptions,
): Promise<RenditionProcessResult[]> {
  const processLock = await acquireDirectoryLock(
    path.join(paths.stateRoot, "locks", "processor.lock"),
    "rendition-processor",
  );
  try {
    const selected = new Set(report.selectedMediaIds);
    const candidates = report.items.filter(
      (item) =>
        selected.has(item.mediaId) &&
        item.jobs.length > 0 &&
        (!options.library ||
          item.library.toLowerCase() === options.library.toLowerCase()) &&
        (!options.mediaId || item.mediaId === options.mediaId),
    );
    const workerCount = Math.max(
      1,
      Math.min(4, Math.floor(options.workerCount ?? 1)),
    );
    const maxRetries = Math.max(
      0,
      Math.min(3, Math.floor(options.maxRetries ?? 1)),
    );
    const results: RenditionProcessResult[] = new Array(candidates.length);
    let nextIndex = 0;
    const worker = async () => {
      while (!options.signal?.aborted) {
        const index = nextIndex;
        nextIndex += 1;
        const item = candidates[index];
        if (!item) return;
        let result: RenditionProcessResult | undefined;
        for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
          result = await processRenditionItem(item, paths, options);
          if (result.status !== "failed") break;
        }
        results[index] = result as RenditionProcessResult;
      }
    };
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return results.filter(Boolean);
  } finally {
    await processLock.release();
  }
}
