import type { PlaybackQualityOption } from "../../lib/types";
import type { SwitchDiagnostics } from "./deckModel";

/**
 * Development record of a rendition handoff.
 *
 * The diagnostics shape carries quality ids, heights and timings only, so there
 * is no URL, signed token, cookie or filesystem path to redact before it is
 * printed. Silent in production builds.
 */
export function logQualitySwitchDiagnostics(
  diagnostics: SwitchDiagnostics,
): void {
  if (!import.meta.env.DEV) return;

  console.info("[Seyirlik Playback] Rendition handoff", diagnostics);
}

/** Seconds of media buffered ahead of the playhead, 0 when nothing is ready. */
export function bufferedSecondsAhead(video: HTMLVideoElement | null): number {
  if (!video) return 0;
  const { buffered, currentTime } = video;
  for (let index = buffered.length - 1; index >= 0; index -= 1) {
    if (
      buffered.start(index) <= currentTime &&
      buffered.end(index) > currentTime
    ) {
      return buffered.end(index) - currentTime;
    }
  }
  return 0;
}

export function measuredPlayerHeight(
  container: HTMLElement | null,
  video: HTMLVideoElement | null,
): number {
  const measured = container?.clientHeight || video?.clientHeight || 0;
  if (measured > 0) return measured;
  // Before first layout both are 0, and `?? ` does not catch that. Falling
  // through to 1px made Auto target the smallest rendition on every cold start.
  return typeof window === "undefined"
    ? 720
    : Math.round(window.innerHeight * 0.8);
}

export function getFileQualitySelectionContext(
  playerHeight: number,
  recentStallCount = 0,
) {
  const connection =
    typeof navigator === "undefined"
      ? undefined
      : (
          navigator as Navigator & {
            connection?: {
              saveData?: boolean;
              effectiveType?: string;
              downlink?: number;
            };
          }
        ).connection;
  return {
    playerHeight: Math.max(1, playerHeight),
    devicePixelRatio:
      typeof window === "undefined" ? 1 : window.devicePixelRatio,
    saveData: connection?.saveData,
    effectiveType: connection?.effectiveType,
    downlinkMbps: connection?.downlink,
    recentStallCount,
  };
}

export function sortQualityOptionsLowestFirst(
  options: readonly PlaybackQualityOption[],
): PlaybackQualityOption[] {
  return [...options].sort(
    (left, right) =>
      (left.maxHeight ?? Number.MAX_SAFE_INTEGER) -
        (right.maxHeight ?? Number.MAX_SAFE_INTEGER) ||
      (left.maxWidth ?? Number.MAX_SAFE_INTEGER) -
        (right.maxWidth ?? Number.MAX_SAFE_INTEGER),
  );
}

/** Match a manifest rung to the dimensions the decoder is actually emitting. */
export function findEffectiveAdaptiveRung<
  T extends { height: number; width?: number },
>(
  ordered: readonly T[],
  decodedWidth: number | null,
  reportedHeight: number | null,
): T | undefined {
  return (
    ordered.find(
      (quality) => decodedWidth !== null && quality.width === decodedWidth,
    ) ??
    ordered.find((quality) => quality.height === reportedHeight) ??
    (reportedHeight === null
      ? undefined
      : [...ordered].sort(
          (left, right) =>
            Math.abs(left.height - reportedHeight) -
            Math.abs(right.height - reportedHeight),
        )[0])
  );
}

/**
 * The link speed the browser will admit to, in Mbps.
 *
 * Safari and Firefox do not implement `navigator.connection` at all, so this
 * is absent more often than not and every caller has to treat "unknown" as an
 * ordinary case rather than an error.
 */
export function navigatorDownlinkMbps(): number | undefined {
  if (typeof navigator === "undefined") return undefined;
  const downlink = (
    navigator as Navigator & { connection?: { downlink?: number } }
  ).connection?.downlink;
  return typeof downlink === "number" && downlink > 0 ? downlink : undefined;
}

export function isHlsStartupSuccessEvent(eventName: string): boolean {
  const normalizedEventName = eventName.toLowerCase();

  return (
    normalizedEventName.includes("fragbuffered") ||
    normalizedEventName.includes("frag_buffered") ||
    normalizedEventName.includes("bufferappended") ||
    normalizedEventName.includes("buffer_appended")
  );
}

export function getSerializableHlsError(data: unknown) {
  if (!data || typeof data !== "object") {
    return data;
  }

  const errorData = data as {
    type?: unknown;
    details?: unknown;
    fatal?: unknown;
    reason?: unknown;
    response?: unknown;
    error?: unknown;
  };

  return {
    type: errorData.type,
    details: errorData.details,
    fatal: errorData.fatal,
    reason: errorData.reason,
    response: errorData.response,
    error:
      errorData.error instanceof Error
        ? {
            name: errorData.error.name,
            message: errorData.error.message,
          }
        : errorData.error
          ? String(errorData.error)
          : undefined,
  };
}
