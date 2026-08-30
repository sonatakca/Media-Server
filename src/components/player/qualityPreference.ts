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

/** A rung, by the things any mode needs to reason about. */
interface RungLike {
  height: number;
  bitrate?: number;
}

/**
 * How much of the measured link a rung may claim.
 *
 * A stream that exactly fills the pipe has nothing left for the variance in
 * its own bitrate, so it stalls on the first busy scene. Two thirds leaves room
 * for a peak without giving away a whole rung.
 */
const BANDWIDTH_SAFETY_FRACTION = 2 / 3;

/** Each consecutive stall costs this much of the bandwidth budget. */
const STALL_PENALTY = 0.6;

/**
 * The opening bid when nothing has measured the link yet.
 *
 * Safari and Firefox expose no `navigator.connection`, and the engine has no
 * throughput estimate until it has pulled fragments, so without a ceiling the
 * anchor would open at the top rung on the strength of screen size alone.
 */
const UNMEASURED_ANCHOR_CEILING = 1080;

export interface ModeSelectionContext {
  /** Measured link throughput in bits/second, if anything has measured it. */
  bandwidthBps?: number;
  displayHeight?: number;
  devicePixelRatio?: number;
  saveData?: boolean;
  effectiveType?: string;
  recentStallCount?: number;
}

function ascendingRungs<T extends RungLike>(qualities: readonly T[]): T[] {
  return [...qualities].sort((left, right) => left.height - right.height);
}

/**
 * The rung the measured connection and the display jointly justify.
 *
 * This is the single anchor every mode is expressed against, so all three
 * agree about what the link can currently do instead of each deciding
 * separately from its own hardcoded budget.
 */
export function selectAnchorRung<T extends RungLike>(
  qualities: readonly T[],
  context: ModeSelectionContext = {},
): T | undefined {
  const ascending = ascendingRungs(qualities);
  if (ascending.length === 0) return undefined;

  // A stated preference, not a measurement, so it is honoured absolutely.
  if (
    context.saveData === true ||
    ["slow-2g", "2g"].includes(context.effectiveType ?? "")
  ) {
    return ascending[0];
  }

  /*
   * The smallest rung that still covers the display, not the largest that fits
   * inside it: a 600px-tall player is better served by a 720p rung scaled down
   * than by a 480p one scaled up.
   */
  const displayTarget =
    context.displayHeight && context.displayHeight > 0
      ? displayTargetHeight(context.displayHeight, context.devicePixelRatio)
      : Number.POSITIVE_INFINITY;
  const covering =
    ascending.find((quality) => quality.height >= displayTarget) ??
    ascending.at(-1)!;
  let eligible = ascending.slice(0, ascending.indexOf(covering) + 1);

  /*
   * Caps that exist for safety rather than for the screen, applied as true
   * ceilings.
   *
   * These must not be folded into the display target above: that target is
   * rounded *up* to the rung that covers it, so a ladder with no rung at the
   * cap would step straight over it — a ladder of 480/720/2160 answered 2160p
   * for an unmeasured link, which is precisely what the ceiling exists to
   * prevent.
   */
  const ceilings: number[] = [];
  if (context.effectiveType === "3g") ceilings.push(720);
  if (context.bandwidthBps === undefined) {
    ceilings.push(UNMEASURED_ANCHOR_CEILING);
  }
  if (ceilings.length > 0) {
    const cap = Math.min(...ceilings);
    const capped = eligible.filter((quality) => quality.height <= cap);
    // Every rung is above the cap, so the cheapest is the closest to honouring it.
    eligible = capped.length > 0 ? capped : [eligible[0]!];
  }

  if (context.bandwidthBps === undefined) return eligible.at(-1);

  const budgetBps =
    context.bandwidthBps *
    BANDWIDTH_SAFETY_FRACTION *
    STALL_PENALTY ** (context.recentStallCount ?? 0);

  // A rung with no measured bitrate is judged on height alone rather than
  // excluded, since an unknown cost is not evidence of an unaffordable one.
  const affordable = eligible.filter(
    (quality) => !quality.bitrate || quality.bitrate <= budgetBps,
  );
  return affordable.at(-1) ?? eligible[0];
}

/**
 * The three modes, as one step down, the anchor, and one step up.
 *
 * Every mode used to carry its own hardcoded budget, so they disagreed about
 * the same connection: Low Data spent a flat 750 kbps whatever the link could
 * do, and Higher Resolution answered from screen size alone while ignoring
 * bandwidth entirely. Anchoring all three to one measured decision makes the
 * menu mean something a viewer can predict — the rung the connection actually
 * justifies, with a safer and a sharper neighbour on either side of it.
 *
 * The step is ordinal on purpose. A rung is the unit the ladder is built in,
 * so "one better" and "one safer" survive any bitrate the encoder happens to
 * produce, where a share-of-bitrate rule flips on rounding.
 */
export function selectModeRungs<T extends RungLike>(
  qualities: readonly T[],
  context: ModeSelectionContext = {},
): { anchor: T | undefined; lowData: T | undefined; higher: T | undefined } {
  const ascending = ascendingRungs(qualities);
  const anchor = selectAnchorRung(ascending, context);
  if (!anchor) {
    return { anchor: undefined, lowData: undefined, higher: undefined };
  }
  const index = ascending.indexOf(anchor);
  return {
    anchor,
    // At an end of the ladder there is no neighbour, and the honest answer is
    // the anchor itself rather than a rung that does not exist.
    lowData: ascending[Math.max(0, index - 1)] ?? anchor,
    higher: ascending[Math.min(ascending.length - 1, index + 1)] ?? anchor,
  };
}

export function selectLowDataRung<T extends RungLike>(
  qualities: readonly T[],
  context: ModeSelectionContext = {},
): T | undefined {
  return selectModeRungs(qualities, context).lowData;
}

export function selectHigherResolutionRung<T extends RungLike>(
  qualities: readonly T[],
  context: ModeSelectionContext = {},
): T | undefined {
  return selectModeRungs(qualities, context).higher;
}

export function selectLowDataQuality(
  qualities: readonly AvailableQualityFile[],
): AvailableQualityFile | undefined {
  return selectLowDataRung(qualities);
}

export function selectHigherResolutionQuality(
  qualities: readonly AvailableQualityFile[],
  displayHeight?: number,
  devicePixelRatio?: number,
): AvailableQualityFile | undefined {
  return selectHigherResolutionRung(qualities, {
    ...(displayHeight === undefined ? {} : { displayHeight }),
    ...(devicePixelRatio === undefined ? {} : { devicePixelRatio }),
  });
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

/** The rung Auto should be on, from the shared anchor. */
export function selectAutoQuality(
  qualities: readonly AvailableQualityFile[],
  context: FileQualitySelectionContext,
): AvailableQualityFile | undefined {
  /*
   * The complete-file path still describes its connection with
   * `navigator.connection`, so its Mbps hint is converted to the bits/second
   * the shared anchor speaks. Both paths then answer from one rule, which is
   * the point: Auto must not mean two different things depending on whether a
   * title happens to be packaged adaptively.
   */
  return selectAnchorRung(sortedQualities(qualities), {
    displayHeight: context.playerHeight,
    ...(context.devicePixelRatio === undefined
      ? {}
      : { devicePixelRatio: context.devicePixelRatio }),
    ...(context.saveData === undefined ? {} : { saveData: context.saveData }),
    ...(context.effectiveType === undefined
      ? {}
      : { effectiveType: context.effectiveType }),
    ...(context.downlinkMbps === undefined
      ? {}
      : { bandwidthBps: context.downlinkMbps * 1_000_000 }),
    ...(context.recentStallCount === undefined
      ? {}
      : { recentStallCount: context.recentStallCount }),
  });
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
