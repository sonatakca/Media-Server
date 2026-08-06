export const DEFAULT_STORAGE_SAFETY_MARGIN = 0.15;
export const DEFAULT_MP4_CONTAINER_OVERHEAD_RATIO = 0.01;
export const DEFAULT_MINIMUM_RESERVE_BYTES = 25 * 1024 ** 3;
export const DEFAULT_RESERVE_RATIO = 0.1;

export type RenditionValidationStatus =
  | "ready"
  | "stale"
  | "validation-failed"
  | "missing"
  | "processing"
  | "failed"
  | "interrupted";

export interface RenditionEstimateInput {
  durationSeconds: number;
  videoBitrate: number;
  audioBitrate: number;
  overheadRatio?: number;
  safetyMarginRatio?: number;
}

export interface RenditionEstimate {
  payloadBytes: number;
  withOverheadBytes: number;
  conservativeBytes: number;
}

export interface PlannedRenditionJob {
  /** Standard quality class (1080/720/480) this job produces. */
  qualityHeight: number;
  estimatedBytes: number;
}

export interface PlannedMediaItem {
  mediaId: string;
  relativePath: string;
  library: string;
  jobs: PlannedRenditionJob[];
}

export interface StorageScheduleInput {
  driveTotalBytes: number;
  driveFreeBytes: number;
  reserveBytes?: number;
  safetyMarginRatio?: number;
  libraryOrder?: string[];
  items: PlannedMediaItem[];
}

export interface StorageSchedule {
  policy: "complete-title-lowest-first";
  reserveBytes: number;
  safelyUsableBytes: number;
  selected: PlannedMediaItem[];
  deferred: PlannedMediaItem[];
  estimatedFinalOutputBytes: number;
  conservativeFinalOutputBytes: number;
  estimatedTemporaryPeakBytes: number;
  peakRequiredBytes: number;
  expectedRemainingFreeBytes: number;
  completePlanFits: boolean;
}

function assertNonNegativeFinite(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative finite number.`);
  }
  return value;
}

export function estimateRenditionBytes({
  durationSeconds,
  videoBitrate,
  audioBitrate,
  overheadRatio = DEFAULT_MP4_CONTAINER_OVERHEAD_RATIO,
  safetyMarginRatio = DEFAULT_STORAGE_SAFETY_MARGIN,
}: RenditionEstimateInput): RenditionEstimate {
  assertNonNegativeFinite(durationSeconds, "durationSeconds");
  assertNonNegativeFinite(videoBitrate, "videoBitrate");
  assertNonNegativeFinite(audioBitrate, "audioBitrate");
  assertNonNegativeFinite(overheadRatio, "overheadRatio");
  assertNonNegativeFinite(safetyMarginRatio, "safetyMarginRatio");

  const payloadBytes = Math.ceil(
    (durationSeconds * (videoBitrate + audioBitrate)) / 8,
  );
  const withOverheadBytes = Math.ceil(payloadBytes * (1 + overheadRatio));
  const conservativeBytes = Math.ceil(
    withOverheadBytes * (1 + safetyMarginRatio),
  );

  return { payloadBytes, withOverheadBytes, conservativeBytes };
}

export function calculateReserveBytes(
  driveTotalBytes: number,
  minimumReserveBytes = DEFAULT_MINIMUM_RESERVE_BYTES,
  reserveRatio = DEFAULT_RESERVE_RATIO,
): number {
  assertNonNegativeFinite(driveTotalBytes, "driveTotalBytes");
  assertNonNegativeFinite(minimumReserveBytes, "minimumReserveBytes");
  assertNonNegativeFinite(reserveRatio, "reserveRatio");
  return Math.ceil(
    Math.max(minimumReserveBytes, driveTotalBytes * reserveRatio),
  );
}

export function getPendingRenditionHeights(
  requiredHeights: readonly number[],
  existingStatuses: ReadonlyMap<number, RenditionValidationStatus>,
): number[] {
  return requiredHeights.filter(
    (qualityHeight) => existingStatuses.get(qualityHeight) !== "ready",
  );
}

function normalizeItem(item: PlannedMediaItem): PlannedMediaItem {
  return {
    ...item,
    jobs: [...item.jobs].sort(
      (left, right) =>
        left.qualityHeight - right.qualityHeight ||
        left.estimatedBytes - right.estimatedBytes,
    ),
  };
}

function sumItemBytes(item: PlannedMediaItem): number {
  return item.jobs.reduce(
    (total, job) =>
      total + assertNonNegativeFinite(job.estimatedBytes, "estimatedBytes"),
    0,
  );
}

export function buildStorageSchedule({
  driveTotalBytes,
  driveFreeBytes,
  reserveBytes = calculateReserveBytes(driveTotalBytes),
  safetyMarginRatio = DEFAULT_STORAGE_SAFETY_MARGIN,
  libraryOrder = ["Movies", "Series"],
  items,
}: StorageScheduleInput): StorageSchedule {
  assertNonNegativeFinite(driveTotalBytes, "driveTotalBytes");
  assertNonNegativeFinite(driveFreeBytes, "driveFreeBytes");
  assertNonNegativeFinite(reserveBytes, "reserveBytes");
  assertNonNegativeFinite(safetyMarginRatio, "safetyMarginRatio");

  const rankByLibrary = new Map(
    libraryOrder.map((library, index) => [library.toLowerCase(), index]),
  );
  const normalizedItems = items.map(normalizeItem).sort((left, right) => {
    const leftRank =
      rankByLibrary.get(left.library.toLowerCase()) ?? libraryOrder.length;
    const rightRank =
      rankByLibrary.get(right.library.toLowerCase()) ?? libraryOrder.length;
    return (
      leftRank - rightRank ||
      left.relativePath.localeCompare(right.relativePath, "en", {
        sensitivity: "base",
        numeric: true,
      }) ||
      left.mediaId.localeCompare(right.mediaId)
    );
  });
  const safelyUsableBytes = Math.max(0, driveFreeBytes - reserveBytes);
  const selected: PlannedMediaItem[] = [];
  const deferred: PlannedMediaItem[] = [];
  let selectedFinalBytes = 0;
  let selectedTemporaryPeakBytes = 0;

  for (const item of normalizedItems) {
    const itemBytes = sumItemBytes(item);
    const itemTemporaryPeak = item.jobs.reduce(
      (maximum, job) => Math.max(maximum, job.estimatedBytes),
      0,
    );
    const candidateFinalBytes = selectedFinalBytes + itemBytes;
    const candidateTemporaryPeak = Math.max(
      selectedTemporaryPeakBytes,
      itemTemporaryPeak,
    );
    const candidateConservativeFinal = Math.ceil(
      candidateFinalBytes * (1 + safetyMarginRatio),
    );
    const candidatePeakRequired =
      candidateConservativeFinal + candidateTemporaryPeak;

    if (candidatePeakRequired <= safelyUsableBytes) {
      selected.push(item);
      selectedFinalBytes = candidateFinalBytes;
      selectedTemporaryPeakBytes = candidateTemporaryPeak;
    } else {
      deferred.push(item);
    }
  }

  const conservativeFinalOutputBytes = Math.ceil(
    selectedFinalBytes * (1 + safetyMarginRatio),
  );
  const peakRequiredBytes =
    conservativeFinalOutputBytes + selectedTemporaryPeakBytes;

  return {
    policy: "complete-title-lowest-first",
    reserveBytes,
    safelyUsableBytes,
    selected,
    deferred,
    estimatedFinalOutputBytes: selectedFinalBytes,
    conservativeFinalOutputBytes,
    estimatedTemporaryPeakBytes: selectedTemporaryPeakBytes,
    peakRequiredBytes,
    expectedRemainingFreeBytes: Math.max(
      0,
      driveFreeBytes - conservativeFinalOutputBytes,
    ),
    completePlanFits: deferred.length === 0,
  };
}
