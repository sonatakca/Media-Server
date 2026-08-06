import { mkdir, statfs, writeFile } from "node:fs/promises";
import path from "node:path";
import { getEncodingPolicy } from "./encoding";
import { discoverEligibleVideoFiles } from "./inventory";
import {
  DEFAULT_MP4_CONTAINER_OVERHEAD_RATIO,
  DEFAULT_STORAGE_SAFETY_MARGIN,
  buildStorageSchedule,
  calculateReserveBytes,
  estimateRenditionBytes,
  type PlannedRenditionJob,
  type StorageSchedule,
} from "./planning";
import {
  RENDITION_PROFILE_VERSION,
  buildRenditionRequirements,
  classifyQualityHeight,
  getDisplayDimensions,
} from "./policy";
import { probeMediaFile, type RenditionMediaProbe } from "./probe";
import {
  computeSourceFingerprint,
  loadRenditionRegistry,
  saveRenditionRegistry,
  upsertRegistrySource,
} from "./registry";
import type { RenditionProgressReporter } from "./progress";
import { inspectCompletedRendition } from "./validation";

export interface RenditionPaths {
  mediaRoot: string;
  renditionRoot: string;
  workRoot: string;
  stateRoot: string;
  logsRoot: string;
}

export interface DriveSpace {
  totalBytes: number;
  freeBytes: number;
}

export interface RenditionAnalysisItem {
  mediaId: string;
  relativePath: string;
  library: string;
  sourceSizeBytes: number;
  sourceMtimeMs: number;
  sourceFingerprint: string;
  status:
    | "pending"
    | "ready"
    | "already-valid"
    | "failed"
    | "stale"
    | "validation-failed"
    | "deferred-for-storage";
  probe?: RenditionMediaProbe;
  existingStatus?: string;
  existingHeights: number[];
  requiredHeights: number[];
  jobs: PlannedRenditionJob[];
  error?: string;
}

export interface RenditionAnalysisReport {
  schemaVersion: 1;
  generatedAt: string;
  profileVersion: string;
  policy: {
    sourceLadder: string;
    scheduling: StorageSchedule["policy"];
    safetyMarginRatio: number;
    containerOverheadRatio: number;
    audioStrategy: "default-track-only";
    subtitleStrategy: "original-playback-only";
    hdrStrategy: "tonemapped-to-sdr-bt709";
  };
  summary: {
    totalEligibleVideoCount: number;
    totalSourceVideoBytes: number;
    movieCount: number;
    episodeCount: number;
    otherEligibleVideoCount: number;
    source2160pCount: number;
    source1080pCount: number;
    lowerResolutionSourceCount: number;
    existingValidRenditionCount: number;
    staleRenditionCount: number;
    validationFailureCount: number;
    probeFailureCount: number;
    hdrSourceCount: number;
    missingByHeight: Record<"480" | "720" | "1080", number>;
    sourceBytesByLibrary: Record<string, number>;
    estimatedOutputBytesByLibrary: Record<string, number>;
  };
  storage: StorageSchedule & {
    driveTotalBytes: number;
    driveFreeBytes: number;
    completePlanEstimatedFinalBytes: number;
    completePlanConservativeFinalBytes: number;
    completePlanTemporaryPeakBytes: number;
    completePlanPeakRequiredBytes: number;
    expectedRemainingBytesForCompletePlan: number;
  };
  selectedMediaIds: string[];
  deferredMediaIds: string[];
  discoveryErrors: Array<{ relativePath: string; message: string }>;
  items: RenditionAnalysisItem[];
}

export interface RenditionAnalysisOptions {
  paths: RenditionPaths;
  ffprobePath?: string;
  driveSpace?: DriveSpace;
  reserveBytes?: number;
  libraryOrder?: string[];
  probe?: (filePath: string) => Promise<RenditionMediaProbe>;
  saveReport?: boolean;
  reportPath?: string;
  onEvent?: RenditionProgressReporter;
}

export function resolveRenditionPaths(
  environment: Record<string, string | undefined> = process.env,
): RenditionPaths {
  const mediaRoot = environment.SEYIRLIK_MEDIA_ROOT?.trim();
  if (!mediaRoot) throw new Error("SEYIRLIK_MEDIA_ROOT is required.");
  const generatedRoot = path.join(mediaRoot, ".seyirlik");
  return {
    mediaRoot: path.resolve(mediaRoot),
    renditionRoot: path.resolve(
      environment.SEYIRLIK_RENDITION_ROOT?.trim() ||
        path.join(generatedRoot, "renditions"),
    ),
    workRoot: path.resolve(
      environment.SEYIRLIK_RENDITION_WORK_ROOT?.trim() ||
        path.join(generatedRoot, "work"),
    ),
    stateRoot: path.resolve(
      environment.SEYIRLIK_RENDITION_STATE_ROOT?.trim() ||
        path.join(generatedRoot, "state"),
    ),
    logsRoot: path.resolve(
      environment.SEYIRLIK_RENDITION_LOG_ROOT?.trim() ||
        path.join(generatedRoot, "logs"),
    ),
  };
}

export async function getDriveSpace(filePath: string): Promise<DriveSpace> {
  const result = await statfs(filePath, { bigint: true });
  const totalBytes = Number(result.bsize * result.blocks);
  const freeBytes = Number(result.bsize * result.bavail);
  if (!Number.isSafeInteger(totalBytes) || !Number.isSafeInteger(freeBytes)) {
    throw new Error("Drive capacity exceeds JavaScript safe integer range.");
  }
  return { totalBytes, freeBytes };
}

function jobEstimate(
  durationSeconds: number,
  qualityHeight: number,
): PlannedRenditionJob {
  const policy = getEncodingPolicy(qualityHeight);
  const estimate = estimateRenditionBytes({
    durationSeconds,
    videoBitrate: policy.expectedVideoBitrate,
    audioBitrate: policy.audioBitrate,
    overheadRatio: DEFAULT_MP4_CONTAINER_OVERHEAD_RATIO,
    safetyMarginRatio: DEFAULT_STORAGE_SAFETY_MARGIN,
  });
  return { qualityHeight, estimatedBytes: estimate.withOverheadBytes };
}

function addRecordValue(
  record: Record<string, number>,
  key: string,
  value: number,
) {
  record[key] = (record[key] ?? 0) + value;
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function analyseRenditionLibrary({
  paths,
  ffprobePath,
  driveSpace,
  reserveBytes,
  libraryOrder,
  probe = (filePath) => probeMediaFile(filePath, ffprobePath),
  saveReport = true,
  reportPath = path.join(paths.stateRoot, "rendition-analysis.json"),
  onEvent,
}: RenditionAnalysisOptions): Promise<RenditionAnalysisReport> {
  await mkdir(paths.stateRoot, { recursive: true });
  const registryPath = path.join(paths.stateRoot, "registry.json");
  const registry = await loadRenditionRegistry(registryPath);
  registry.profileVersion = RENDITION_PROFILE_VERSION;
  const discoveryErrors: RenditionAnalysisReport["discoveryErrors"] = [];
  const discovered = await discoverEligibleVideoFiles(paths.mediaRoot, {
    onError: (filePath, error) => {
      discoveryErrors.push({
        relativePath: path
          .relative(paths.mediaRoot, filePath)
          .split(path.sep)
          .join("/"),
        message: safeErrorMessage(error),
      });
    },
  });
  const items: RenditionAnalysisItem[] = [];

  for (const [discoveredIndex, source] of discovered.entries()) {
    onEvent?.({
      type: "analysis-progress",
      index: discoveredIndex + 1,
      total: discovered.length,
      relativePath: source.relativePath,
    });
    let fingerprint = "";
    try {
      fingerprint = await computeSourceFingerprint(source.filePath, source);
      const registryItem = upsertRegistrySource(registry, {
        relativePath: source.relativePath,
        size: source.size,
        mtimeMs: source.mtimeMs,
        sourceFingerprint: fingerprint,
      });
      const mediaProbe = await probe(source.filePath);
      if (!(mediaProbe.durationSeconds > 0)) {
        throw new Error("FFprobe did not report a positive media duration.");
      }
      const required = buildRenditionRequirements(mediaProbe.video);
      const existing = await inspectCompletedRendition({
        mediaRoot: path.join(paths.renditionRoot, registryItem.id),
        mediaId: registryItem.id,
        sourceFingerprint: fingerprint,
        profileVersion: RENDITION_PROFILE_VERSION,
      });
      const existingHeights =
        existing.status === "ready"
          ? (existing.metadata?.files.map((file) => file.qualityHeight) ?? [])
          : [];
      const requiredHeights = required.map((variant) => variant.qualityHeight);
      const jobs = requiredHeights
        .filter((qualityHeight) => !existingHeights.includes(qualityHeight))
        .map((qualityHeight) =>
          jobEstimate(mediaProbe.durationSeconds, qualityHeight),
        )
        .sort((left, right) => left.qualityHeight - right.qualityHeight);
      const status: RenditionAnalysisItem["status"] =
        existing.status === "stale"
          ? "stale"
          : existing.status === "validation-failed"
            ? "validation-failed"
            : jobs.length === 0
              ? existing.status === "ready"
                ? "already-valid"
                : "ready"
              : "pending";
      registryItem.status = status;
      items.push({
        mediaId: registryItem.id,
        relativePath: source.relativePath,
        library: source.library,
        sourceSizeBytes: source.size,
        sourceMtimeMs: source.mtimeMs,
        sourceFingerprint: fingerprint,
        status,
        probe: mediaProbe,
        existingStatus: existing.status,
        existingHeights: [...existingHeights].sort((a, b) => a - b),
        requiredHeights: [...requiredHeights].sort((a, b) => a - b),
        jobs,
        ...(existing.reason ? { error: existing.reason } : {}),
      });
    } catch (error) {
      const registryItem = upsertRegistrySource(registry, {
        relativePath: source.relativePath,
        size: source.size,
        mtimeMs: source.mtimeMs,
        sourceFingerprint: fingerprint || "0".repeat(64),
      });
      registryItem.status = "failed";
      registryItem.lastError = safeErrorMessage(error);
      items.push({
        mediaId: registryItem.id,
        relativePath: source.relativePath,
        library: source.library,
        sourceSizeBytes: source.size,
        sourceMtimeMs: source.mtimeMs,
        sourceFingerprint: fingerprint || "0".repeat(64),
        status: "failed",
        existingHeights: [],
        requiredHeights: [],
        jobs: [],
        error: safeErrorMessage(error),
      });
    }
  }

  await saveRenditionRegistry(registryPath, registry);
  const actualDriveSpace = driveSpace ?? (await getDriveSpace(paths.mediaRoot));
  const configuredReserve =
    reserveBytes ?? calculateReserveBytes(actualDriveSpace.totalBytes);
  const schedulableItems = items
    .filter((item) => item.status !== "failed" && item.jobs.length > 0)
    .map((item) => ({
      mediaId: item.mediaId,
      relativePath: item.relativePath,
      library: item.library,
      jobs: item.jobs,
    }));
  const schedule = buildStorageSchedule({
    driveTotalBytes: actualDriveSpace.totalBytes,
    driveFreeBytes: actualDriveSpace.freeBytes,
    reserveBytes: configuredReserve,
    libraryOrder,
    items: schedulableItems,
  });
  const selectedIds = new Set(schedule.selected.map((item) => item.mediaId));
  const deferredIds = new Set(schedule.deferred.map((item) => item.mediaId));
  for (const item of items) {
    if (deferredIds.has(item.mediaId)) item.status = "deferred-for-storage";
    else if (selectedIds.has(item.mediaId) && item.status === "pending")
      item.status = "pending";
  }

  const sourceBytesByLibrary: Record<string, number> = {};
  const estimatedOutputBytesByLibrary: Record<string, number> = {};
  let movieCount = 0;
  let episodeCount = 0;
  let otherEligibleVideoCount = 0;
  let source2160pCount = 0;
  let source1080pCount = 0;
  let lowerResolutionSourceCount = 0;
  let existingValidRenditionCount = 0;
  let staleRenditionCount = 0;
  let validationFailureCount = 0;
  let probeFailureCount = 0;
  let hdrSourceCount = 0;
  const missingByHeight = { "480": 0, "720": 0, "1080": 0 };

  for (const item of items) {
    addRecordValue(sourceBytesByLibrary, item.library, item.sourceSizeBytes);
    addRecordValue(
      estimatedOutputBytesByLibrary,
      item.library,
      item.jobs.reduce((total, job) => total + job.estimatedBytes, 0),
    );
    const library = item.library.toLowerCase();
    if (library === "movies") movieCount += 1;
    else if (library === "series") episodeCount += 1;
    else otherEligibleVideoCount += 1;
    if (!item.probe) {
      probeFailureCount += 1;
    } else {
      if (item.probe.video.isHdr) hdrSourceCount += 1;
      const qualityHeight = classifyQualityHeight(item.probe.video);
      if (qualityHeight >= 2160) source2160pCount += 1;
      else if (qualityHeight >= 1080) source1080pCount += 1;
      else lowerResolutionSourceCount += 1;
    }
    existingValidRenditionCount += item.existingHeights.length;
    if (item.existingStatus === "stale") staleRenditionCount += 1;
    if (item.existingStatus === "validation-failed")
      validationFailureCount += 1;
    for (const job of item.jobs) {
      const key = String(job.qualityHeight) as keyof typeof missingByHeight;
      if (key in missingByHeight) missingByHeight[key] += 1;
    }
  }

  const completePlanEstimatedFinalBytes = schedulableItems.reduce(
    (total, item) =>
      total +
      item.jobs.reduce((itemTotal, job) => itemTotal + job.estimatedBytes, 0),
    0,
  );
  const completePlanConservativeFinalBytes = Math.ceil(
    completePlanEstimatedFinalBytes * (1 + DEFAULT_STORAGE_SAFETY_MARGIN),
  );
  const completePlanTemporaryPeakBytes = schedulableItems.reduce(
    (maximum, item) =>
      Math.max(maximum, ...item.jobs.map((job) => job.estimatedBytes)),
    0,
  );
  const completePlanPeakRequiredBytes =
    completePlanConservativeFinalBytes + completePlanTemporaryPeakBytes;
  const report: RenditionAnalysisReport = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    profileVersion: RENDITION_PROFILE_VERSION,
    policy: {
      sourceLadder:
        "classified by display long edge: 2160p=>1080p,720p,480p; 1080p=>720p,480p; 720p=>480p; never upscale or crop",
      scheduling: schedule.policy,
      safetyMarginRatio: DEFAULT_STORAGE_SAFETY_MARGIN,
      containerOverheadRatio: DEFAULT_MP4_CONTAINER_OVERHEAD_RATIO,
      audioStrategy: "default-track-only",
      subtitleStrategy: "original-playback-only",
      hdrStrategy: "tonemapped-to-sdr-bt709",
    },
    summary: {
      totalEligibleVideoCount: items.length,
      totalSourceVideoBytes: items.reduce(
        (total, item) => total + item.sourceSizeBytes,
        0,
      ),
      movieCount,
      episodeCount,
      otherEligibleVideoCount,
      source2160pCount,
      source1080pCount,
      lowerResolutionSourceCount,
      existingValidRenditionCount,
      staleRenditionCount,
      validationFailureCount,
      probeFailureCount,
      hdrSourceCount,
      missingByHeight,
      sourceBytesByLibrary,
      estimatedOutputBytesByLibrary,
    },
    storage: {
      ...schedule,
      driveTotalBytes: actualDriveSpace.totalBytes,
      driveFreeBytes: actualDriveSpace.freeBytes,
      completePlanEstimatedFinalBytes,
      completePlanConservativeFinalBytes,
      completePlanTemporaryPeakBytes,
      completePlanPeakRequiredBytes,
      expectedRemainingBytesForCompletePlan: Math.max(
        0,
        actualDriveSpace.freeBytes - completePlanConservativeFinalBytes,
      ),
    },
    selectedMediaIds: schedule.selected.map((item) => item.mediaId),
    deferredMediaIds: schedule.deferred.map((item) => item.mediaId),
    discoveryErrors,
    items,
  };

  if (saveReport) {
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  return report;
}

export function formatAnalysisReport(report: RenditionAnalysisReport): string {
  const formatBytes = (bytes: number) =>
    `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
  const lines = [
    "Seyirlik rendition analysis (encoding disabled)",
    `Eligible videos: ${report.summary.totalEligibleVideoCount}`,
    `Movies: ${report.summary.movieCount}; Series episodes: ${report.summary.episodeCount}; Other: ${report.summary.otherEligibleVideoCount}`,
    `Source size: ${formatBytes(report.summary.totalSourceVideoBytes)}`,
    `Sources: 2160p=${report.summary.source2160pCount}, 1080p=${report.summary.source1080pCount}, lower=${report.summary.lowerResolutionSourceCount}; HDR needing tone mapping: ${report.summary.hdrSourceCount}`,
    `Missing: 1080p=${report.summary.missingByHeight["1080"]}, 720p=${report.summary.missingByHeight["720"]}, 480p=${report.summary.missingByHeight["480"]}`,
    `Existing valid variants: ${report.summary.existingValidRenditionCount}; stale items: ${report.summary.staleRenditionCount}`,
    `Estimated complete output: ${formatBytes(report.storage.completePlanConservativeFinalBytes)}`,
    `Estimated temporary peak: ${formatBytes(report.storage.completePlanTemporaryPeakBytes)}`,
    `Media volume capacity: ${formatBytes(report.storage.driveTotalBytes)}; free: ${formatBytes(report.storage.driveFreeBytes)}`,
    `Reserve: ${formatBytes(report.storage.reserveBytes)}; safely usable: ${formatBytes(report.storage.safelyUsableBytes)}`,
    `Complete plan fits: ${report.storage.completePlanFits ? "yes" : "no"}`,
    `Selected titles: ${report.selectedMediaIds.length}; deferred titles: ${report.deferredMediaIds.length}`,
    `Scheduling policy: ${report.policy.scheduling}`,
    "No rendition processing was started.",
  ];
  return lines.join("\n");
}
