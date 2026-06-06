import type { PlaybackSourceCandidate } from "../../lib/types";

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function getSpritePositionPercent(index: number, count: number): number {
  if (count <= 1) {
    return 0;
  }

  return (index / (count - 1)) * 100;
}

function getAspectRatioFromDimensions(
  width?: number,
  height?: number,
): number | null {
  if (
    typeof width !== "number" ||
    typeof height !== "number" ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return null;
  }

  return width / height;
}

function getAspectRatioFromText(aspectRatio?: string): number | null {
  const trimmedAspectRatio = aspectRatio?.trim();

  if (!trimmedAspectRatio) {
    return null;
  }

  const pairMatch = trimmedAspectRatio.match(
    /^(\d+(?:\.\d+)?)\s*[:/x]\s*(\d+(?:\.\d+)?)$/i,
  );

  if (pairMatch) {
    const width = Number(pairMatch[1]);
    const height = Number(pairMatch[2]);

    return getAspectRatioFromDimensions(width, height);
  }

  const numericAspectRatio = Number(trimmedAspectRatio);

  return Number.isFinite(numericAspectRatio) && numericAspectRatio > 0
    ? numericAspectRatio
    : null;
}

export function getVideoAspectRatioFromSource(
  source: PlaybackSourceCandidate,
): number | null {
  const videoStream = source.mediaSource.MediaStreams?.find(
    (stream) => stream.Type?.toLowerCase() === "video",
  );

  return (
    getAspectRatioFromText(videoStream?.AspectRatio) ??
    getAspectRatioFromDimensions(videoStream?.Width, videoStream?.Height)
  );
}

export function getVideoAspectRatioFromElement(
  video: HTMLVideoElement,
): number | null {
  return getAspectRatioFromDimensions(video.videoWidth, video.videoHeight);
}
