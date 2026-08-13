import path from "node:path";
import type { RenditionAnalysisReport, RenditionPaths } from "../analysis";
import {
  parseEncoderPreference,
  resolveVideoEncoder,
  type RenditionEncoderPreference,
  type RenditionVideoEncoder,
} from "../encoding";
import { acquireDirectoryLock } from "../locks";
import { classifyQualityHeight, getDisplayDimensions } from "../policy";
import type { RenditionProgressReporter } from "../progress";
import {
  loadRenditionRegistry,
  saveRenditionRegistry,
  type AdaptiveRegistryStatus,
} from "../registry";
import {
  packageAdaptiveRendition,
  type AdaptivePackageResult,
} from "./packager";
import { ADAPTIVE_PROFILE_VERSION } from "./profile";

export interface ProcessAdaptiveReportOptions {
  reserveBytes: number;
  ffmpegPath?: string;
  ffprobePath?: string;
  encoderPreference?: RenditionEncoderPreference;
  videoEncoder?: RenditionVideoEncoder;
  hdrVideoEncoder?: RenditionVideoEncoder;
  library?: string;
  mediaId?: string;
  workerCount?: number;
  maxRetries?: number;
  allAudioTracks?: boolean;
  dryRun?: boolean;
  signal?: AbortSignal;
  onEvent?: RenditionProgressReporter;
}

export interface ProcessAdaptiveReportOutcome {
  videoEncoder: RenditionVideoEncoder;
  hdrVideoEncoder?: RenditionVideoEncoder;
  results: AdaptivePackageResult[];
}

function registryStatus(
  result: AdaptivePackageResult,
): AdaptiveRegistryStatus | undefined {
  switch (result.status) {
    case "ready":
    case "already-valid":
      return "ready";
    case "failed":
    case "validation-failed":
    case "deferred-for-storage":
    case "interrupted":
    case "incompatible":
      return result.status;
    case "dry-run":
      return undefined;
  }
}

/**
 * Processes the adaptive generation without mutating legacy package state.
 *
 * Registry writes are serialised even when encoding uses several workers. This
 * prevents two completed titles from racing an atomic registry rewrite and
 * losing one another's status update.
 */
export async function processAdaptiveReport(
  report: RenditionAnalysisReport,
  paths: RenditionPaths,
  options: ProcessAdaptiveReportOptions,
): Promise<ProcessAdaptiveReportOutcome> {
  const processLock = await acquireDirectoryLock(
    path.join(paths.stateRoot, "locks", "processor.lock"),
    "adaptive-rendition-processor",
  );

  try {
    const ffmpegPath =
      options.ffmpegPath ??
      process.env.FFMPEG_PATH ??
      process.env.SEYIRLIK_FFMPEG_PATH ??
      "ffmpeg";
    const encoderPreference =
      options.encoderPreference ??
      parseEncoderPreference(process.env.SEYIRLIK_RENDITION_ENCODER);
    const candidates = report.items.filter(
      (item) =>
        item.adaptive.eligible &&
        item.adaptive.status !== "ready" &&
        item.probe !== undefined &&
        (!options.library ||
          item.library.toLowerCase() === options.library.toLowerCase()) &&
        (!options.mediaId || item.mediaId === options.mediaId),
    );
    const videoEncoder =
      options.videoEncoder ??
      (await resolveVideoEncoder(
        encoderPreference,
        ffmpegPath,
        "h264",
        false,
        options.signal,
      ));
    const needsHdrEncoder = candidates.some((item) => item.probe?.video.isHdr);
    const hdrVideoEncoder =
      options.hdrVideoEncoder ??
      (needsHdrEncoder
        ? await resolveVideoEncoder(
            encoderPreference,
            ffmpegPath,
            "hevc",
            true,
            options.signal,
          )
        : undefined);

    options.onEvent?.({
      type: "encoder-selected",
      encoder: videoEncoder,
      ...(hdrVideoEncoder ? { hdrEncoder: hdrVideoEncoder } : {}),
    });

    const registryPath = path.join(paths.stateRoot, "registry.json");
    const registry = await loadRenditionRegistry(registryPath);
    let registryWrite = Promise.resolve();
    const recordResult = (result: AdaptivePackageResult) => {
      const status = registryStatus(result);
      if (!status) return registryWrite;
      const item = registry.items.find((entry) => entry.id === result.mediaId);
      if (!item) return registryWrite;
      item.adaptiveStatus = status;
      item.adaptiveProfileVersion = ADAPTIVE_PROFILE_VERSION;
      if (result.error) item.adaptiveLastError = result.error;
      else delete item.adaptiveLastError;
      registryWrite = registryWrite.then(() =>
        saveRenditionRegistry(registryPath, registry),
      );
      return registryWrite;
    };

    const workerCount = Math.max(
      1,
      Math.min(4, Math.floor(options.workerCount ?? 1)),
    );
    const maxRetries = Math.max(
      0,
      Math.min(3, Math.floor(options.maxRetries ?? 1)),
    );
    const results: AdaptivePackageResult[] = new Array(candidates.length);
    let nextIndex = 0;

    const worker = async () => {
      while (!options.signal?.aborted) {
        const index = nextIndex;
        nextIndex += 1;
        const item = candidates[index];
        if (!item?.probe) return;
        const startedAt = Date.now();
        const display = getDisplayDimensions(item.probe.video);
        options.onEvent?.({
          type: "item-start",
          index: index + 1,
          total: candidates.length,
          mediaId: item.mediaId,
          relativePath: item.relativePath,
          source: {
            ...display,
            qualityHeight: classifyQualityHeight(item.probe.video),
            durationSeconds: item.probe.durationSeconds,
            videoCodec: item.probe.video.codec,
            isHdr: item.probe.video.isHdr,
            audioLanguage: (
              item.probe.audioTracks.find((track) => track.isDefault) ??
              item.probe.audioTracks[0]
            )?.language,
          },
          pendingQualities: item.requiredHeights,
          reusedQualities: [],
        });

        let result: AdaptivePackageResult | undefined;
        for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
          result = await packageAdaptiveRendition(
            {
              mediaId: item.mediaId,
              relativePath: item.relativePath,
              sourceFingerprint: item.sourceFingerprint,
              sourcePath: path.join(
                paths.mediaRoot,
                ...item.relativePath.split("/"),
              ),
              probe: item.probe,
            },
            paths,
            {
              reserveBytes: options.reserveBytes,
              ffmpegPath,
              ...(options.ffprobePath
                ? { ffprobePath: options.ffprobePath }
                : {}),
              encoderPreference,
              videoEncoder,
              hdrVideoEncoder,
              allAudioTracks: options.allAudioTracks,
              dryRun: options.dryRun,
              signal: options.signal,
              onEvent: options.onEvent,
            },
          );
          if (result.status !== "failed") break;
        }
        results[index] = result as AdaptivePackageResult;
        await recordResult(results[index]);
        options.onEvent?.({
          type: "item-complete",
          mediaId: item.mediaId,
          relativePath: item.relativePath,
          status: results[index].status,
          elapsedMs: Date.now() - startedAt,
          ...(results[index].error ? { error: results[index].error } : {}),
        });
      }
    };

    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    await registryWrite;
    return {
      videoEncoder,
      ...(hdrVideoEncoder ? { hdrVideoEncoder } : {}),
      results: results.filter(Boolean),
    };
  } finally {
    await processLock.release();
  }
}
