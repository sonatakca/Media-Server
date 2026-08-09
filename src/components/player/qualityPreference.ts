import {
  isQualityPreferenceMode,
  type AvailableQualityFile,
  type QualityPreferenceMode,
} from "../../renditions/contracts";

export interface QualityPreference {
  mode: QualityPreferenceMode;
  preferredHeight?: number;
  preferredQualityId?: string;
  preferOriginal?: boolean;
}

export interface FileQualitySelectionContext {
  playerHeight: number;
  devicePixelRatio?: number;
  saveData?: boolean;
  effectiveType?: string;
  downlinkMbps?: number;
  recentStallCount?: number;
}

const STORAGE_PREFIX = "seyirlik:quality-preference:";

function defaultStorage(): Storage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function storageKey(userId: string): string {
  return `${STORAGE_PREFIX}${encodeURIComponent(userId || "anonymous")}`;
}

function parsePreference(value: unknown): QualityPreference | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const candidate = value as {
    mode?: unknown;
    preferredHeight?: unknown;
    preferredQualityId?: unknown;
    preferOriginal?: unknown;
  };
  if (!isQualityPreferenceMode(candidate.mode)) return undefined;
  const preferredHeight = candidate.preferredHeight;
  if (
    preferredHeight !== undefined &&
    (!Number.isInteger(preferredHeight) ||
      (preferredHeight as number) <= 0 ||
      (preferredHeight as number) > 4320)
  ) {
    return undefined;
  }
  if (
    candidate.preferredQualityId !== undefined &&
    (typeof candidate.preferredQualityId !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(candidate.preferredQualityId))
  ) {
    return undefined;
  }
  return {
    mode: candidate.mode,
    ...(typeof preferredHeight === "number" ? { preferredHeight } : {}),
    ...(typeof candidate.preferredQualityId === "string"
      ? { preferredQualityId: candidate.preferredQualityId }
      : {}),
    ...(candidate.preferOriginal === true ? { preferOriginal: true } : {}),
  };
}

export function loadQualityPreference(
  userId: string,
  storage = defaultStorage(),
): QualityPreference {
  if (!storage) return { mode: "auto" };
  try {
    const raw = storage.getItem(storageKey(userId));
    if (!raw) return { mode: "auto" };
    return parsePreference(JSON.parse(raw)) ?? { mode: "auto" };
  } catch {
    return { mode: "auto" };
  }
}

export function saveQualityPreference(
  preference: QualityPreference,
  userId: string,
  storage = defaultStorage(),
): void {
  const validated = parsePreference(preference);
  if (!storage || !validated) return;
  try {
    storage.setItem(storageKey(userId), JSON.stringify(validated));
  } catch {
    // Playback remains functional when storage is unavailable or full.
  }
}

export function resolveManualHeight(
  intendedHeight: number,
  availableHeights: readonly number[],
): number | undefined {
  const heights = Array.from(
    new Set(
      availableHeights.filter(
        (height) => Number.isInteger(height) && height > 0,
      ),
    ),
  ).sort((left, right) => right - left);
  if (heights.length === 0) return undefined;
  return (
    heights.find((height) => height <= intendedHeight) ??
    heights[heights.length - 1]
  );
}

function sortedQualities(
  qualities: readonly AvailableQualityFile[],
): AvailableQualityFile[] {
  return [...qualities].sort(
    (left, right) =>
      left.height - right.height ||
      left.width - right.width ||
      Number(left.kind === "original") - Number(right.kind === "original"),
  );
}

export function isQualityAudioCompatible(
  quality: AvailableQualityFile,
  selectedAudioStreamIndex: number | undefined,
): boolean {
  return (
    quality.kind === "original" ||
    selectedAudioStreamIndex === undefined ||
    quality.sourceAudioStreamIndex === selectedAudioStreamIndex
  );
}

export function selectLowDataQuality(
  qualities: readonly AvailableQualityFile[],
): AvailableQualityFile | undefined {
  return sortedQualities(qualities)[0];
}

export function selectHigherResolutionQuality(
  qualities: readonly AvailableQualityFile[],
): AvailableQualityFile | undefined {
  return sortedQualities(qualities).at(-1);
}

export function selectManualQuality(
  qualities: readonly AvailableQualityFile[],
  preference: QualityPreference,
): AvailableQualityFile | undefined {
  if (preference.preferredQualityId) {
    const exact = qualities.find(
      (quality) => quality.id === preference.preferredQualityId,
    );
    if (exact) return exact;
  }
  if (preference.preferOriginal) {
    const original = qualities.find((quality) => quality.kind === "original");
    if (original) return original;
  }
  // A different title rarely carries the exact same generated file, so the saved
  // height is resolved down to the nearest available quality instead of being
  // discarded. `resolveManualHeight` never resolves upwards.
  if (preference.preferredHeight) {
    const resolvedHeight = resolveManualHeight(
      preference.preferredHeight,
      qualities.map((quality) => quality.height),
    );
    return qualities.find((quality) => quality.height === resolvedHeight);
  }
  return undefined;
}

/** Resolution the display can actually make use of, with a sane pixel-ratio cap. */
export function displayTargetHeight(
  playerHeight: number,
  devicePixelRatio: number | undefined,
): number {
  const pixelRatio = Math.min(Math.max(devicePixelRatio ?? 1, 1), 2);
  return Math.max(1, playerHeight) * pixelRatio;
}

export function selectAutoQuality(
  qualities: readonly AvailableQualityFile[],
  context: FileQualitySelectionContext,
): AvailableQualityFile | undefined {
  const sorted = sortedQualities(qualities);
  if (sorted.length === 0) return undefined;
  const constrainedConnection =
    context.saveData === true ||
    ["slow-2g", "2g"].includes(context.effectiveType ?? "") ||
    (context.downlinkMbps !== undefined && context.downlinkMbps < 2.5) ||
    (context.recentStallCount ?? 0) >= 2;
  if (constrainedConnection) return sorted[0];

  let targetHeight = displayTargetHeight(
    context.playerHeight,
    context.devicePixelRatio,
  );
  if (
    context.effectiveType === "3g" ||
    (context.downlinkMbps !== undefined && context.downlinkMbps < 6)
  ) {
    targetHeight = Math.min(targetHeight, 720);
  } else if (context.downlinkMbps === undefined) {
    // Safari and Firefox do not implement `navigator.connection`, so the old
    // 720p cap here left Auto permanently stuck at 720p on those browsers.
    // 1080p is a safe opening bid; measured buffer health moves it from there.
    targetHeight = Math.min(targetHeight, 1080);
  } else if (context.downlinkMbps < 12) {
    targetHeight = Math.min(targetHeight, 1080);
  }

  return (
    sorted.find((quality) => quality.height >= targetHeight) ?? sorted.at(-1)
  );
}

export function shouldSwitchFileQuality({
  currentHeight,
  candidateHeight,
  now,
  lastSwitchAt,
  recentStallCount = 0,
  cooldownMs = 30_000,
}: {
  currentHeight: number;
  candidateHeight: number;
  now: number;
  lastSwitchAt: number;
  recentStallCount?: number;
  cooldownMs?: number;
}): boolean {
  if (currentHeight === candidateHeight) return false;
  const isStallDowngrade =
    recentStallCount >= 2 && candidateHeight < currentHeight;
  if (!isStallDowngrade && now - lastSwitchAt < cooldownMs) return false;
  const ratio =
    Math.max(currentHeight, candidateHeight) /
    Math.max(1, Math.min(currentHeight, candidateHeight));
  return ratio >= 1.3;
}
