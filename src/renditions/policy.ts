import path from "node:path";

export const RENDITION_PROFILE_VERSION = "h264-aac-mp4-v2";

/**
 * Quality classes are decided by the display long edge, not by the stored frame
 * height. Real libraries are full of letterboxed cinematic masters — a 4K scope
 * feature is 3840x1604 and a 1080p scope feature is 1920x816 — so a
 * height-threshold ladder silently demotes them and caps a 4K source at 720p.
 * The long edge classifies every aspect ratio, including portrait video,
 * consistently.
 */
/**
 * Every rung a ladder may contain, largest first.
 *
 * The top of the ladder now reaches the source's own class: a title carries a
 * processed rendition at its native size as well as the smaller ones, so the
 * source file is one day removable without the best quality going with it.
 */
export const RENDITION_TARGETS = [
  { qualityHeight: 2160, longEdge: 3840 },
  { qualityHeight: 1080, longEdge: 1920 },
  { qualityHeight: 720, longEdge: 1280 },
  { qualityHeight: 480, longEdge: 854 },
  { qualityHeight: 360, longEdge: 640 },
  { qualityHeight: 240, longEdge: 426 },
  { qualityHeight: 144, longEdge: 256 },
] as const;

/**
 * Standard labels a source is reported as, largest first. A source is labelled
 * with a class once its long edge is within 5% of that class.
 */
const QUALITY_CLASSES = [
  { qualityHeight: 4320, longEdge: 7680 },
  { qualityHeight: 2160, longEdge: 3840 },
  { qualityHeight: 1440, longEdge: 2560 },
  { qualityHeight: 1080, longEdge: 1920 },
  { qualityHeight: 720, longEdge: 1280 },
  { qualityHeight: 480, longEdge: 854 },
  { qualityHeight: 360, longEdge: 640 },
  { qualityHeight: 240, longEdge: 426 },
] as const;

/**
 * How much larger than a target the source must be for that target to be a
 * *downscale*.
 *
 * Below this ratio the rung is not smaller than the source in any useful sense.
 * It is still generated — the ladder deliberately reaches the source's own
 * class so the title carries a processed copy at full quality — but it is
 * generated at the source's real dimensions rather than being stretched up to
 * the nominal class.
 */
const MINIMUM_DOWNSCALE_RATIO = 1.2;
const QUALITY_CLASS_TOLERANCE = 1.05;

const SUPPORTED_VIDEO_EXTENSIONS = new Set([
  ".3gp",
  ".avi",
  ".flv",
  ".m2ts",
  ".m4v",
  ".mkv",
  ".mov",
  ".mp4",
  ".mpeg",
  ".mpg",
  ".mts",
  ".ogm",
  ".ogv",
  ".ts",
  ".vob",
  ".webm",
  ".wmv",
]);

/**
 * Generated output, non-video libraries, and the conventional extras folders. Extras
 * are trailers and promotional clips that the quality picker never plays, so
 * generating a ladder for them only consumes space. `Specials` is deliberately
 * absent: it is a real season folder, not an extras folder.
 */
const EXCLUDED_DIRECTORY_NAMES = new Set([
  ".seyirlik",
  /*
   * A title's own generated media. Walking into these would offer the ladder
   * back to the packager as seven more sources to build ladders from.
   */
  "video",
  "audio",
  "subtitle",
  "content",
  "backdrops",
  "behind the scenes",
  "books",
  "clips",
  "deleted scenes",
  "extras",
  "featurettes",
  "interviews",
  "other",
  "renditions",
  "samples",
  "scenes",
  "shorts",
  "theme-music",
  "trailers",
  "work",
]);

/**
 * Sidecar derivatives written next to originals by external tooling: video-only
 * ladders, extracted audio, and abandoned temp output. They are not library
 * titles, and treating them as sources would generate renditions of renditions.
 */
const DERIVATIVE_FILE_PATTERNS = [
  /-\d{3,4}p-video(\.tmp)?\.[^.]+$/i,
  /-orig-video(\.tmp)?\.[^.]+$/i,
  /-audio(\.tmp)?\.[^.]+$/i,
  /\.tmp\.[^.]+$/i,
  /\.partial\.[^.]+$/i,
];

export function isDerivativeFileName(fileName: string): boolean {
  return DERIVATIVE_FILE_PATTERNS.some((pattern) => pattern.test(fileName));
}

export interface SourceDisplayDimensions {
  width: number;
  height: number;
  rotation?: number;
}

export interface RenditionDimensions {
  width: number;
  height: number;
}

export interface RenditionRequirement extends RenditionDimensions {
  /** Standard quality label (1080/720/480) this file is offered as. */
  qualityHeight: number;
}

function normalizedRotation(rotation: number | undefined): number {
  if (!Number.isFinite(rotation)) return 0;
  const normalized = ((Math.round(rotation ?? 0) % 360) + 360) % 360;
  return normalized === 90 || normalized === 270 ? normalized : 0;
}

export function getDisplayDimensions({
  width,
  height,
  rotation,
}: SourceDisplayDimensions): RenditionDimensions {
  const safeWidth = Math.max(0, Math.round(width));
  const safeHeight = Math.max(0, Math.round(height));
  const rotated = normalizedRotation(rotation) !== 0;

  return rotated
    ? { width: safeHeight, height: safeWidth }
    : { width: safeWidth, height: safeHeight };
}

function nearestEven(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2);
}

/**
 * Scales the source down so its long edge matches `targetLongEdge`, preserving
 * the aspect ratio exactly. The source is never upscaled and never cropped, so
 * letterboxed and portrait masters keep their shape.
 */
export function computeRenditionDimensions(
  sourceWidth: number,
  sourceHeight: number,
  targetLongEdge: number,
): RenditionDimensions {
  if (
    !Number.isFinite(sourceWidth) ||
    !Number.isFinite(sourceHeight) ||
    !Number.isFinite(targetLongEdge) ||
    sourceWidth <= 0 ||
    sourceHeight <= 0 ||
    targetLongEdge <= 0
  ) {
    throw new Error("Source and target dimensions must be positive numbers.");
  }

  const scale = Math.min(
    1,
    targetLongEdge / Math.max(sourceWidth, sourceHeight),
  );
  return {
    width: nearestEven(sourceWidth * scale),
    height: nearestEven(sourceHeight * scale),
  };
}

/** Reports the standard quality label a probed source should be offered as. */
export function classifyQualityHeight(source: SourceDisplayDimensions): number {
  const display = getDisplayDimensions(source);
  const longEdge = Math.max(display.width, display.height);
  const matched = QUALITY_CLASSES.find(
    (quality) => quality.longEdge <= longEdge * QUALITY_CLASS_TOLERANCE,
  );
  return (
    matched?.qualityHeight ??
    QUALITY_CLASSES[QUALITY_CLASSES.length - 1].qualityHeight
  );
}

export function buildRenditionRequirements(
  source: SourceDisplayDimensions,
): RenditionRequirement[] {
  const display = getDisplayDimensions(source);
  if (display.width <= 0 || display.height <= 0) return [];

  const sourceLongEdge = Math.max(display.width, display.height);
  const seen = new Set<string>();
  const requirements: RenditionRequirement[] = [];

  /*
   * The ladder starts at the source's own class, encoded at the source's real
   * dimensions rather than stretched up to the nominal class — a 2.39:1 4K
   * master is 3840x1604 and stays that shape. This rung is what lets the source
   * file eventually be removed: without it the best copy of a title would only
   * ever exist as the original.
   */
  const sourceClass = classifyQualityHeight(source);
  const sourceDimensions = computeRenditionDimensions(
    display.width,
    display.height,
    sourceLongEdge,
  );
  seen.add(`${sourceDimensions.width}x${sourceDimensions.height}`);
  requirements.push({ ...sourceDimensions, qualityHeight: sourceClass });

  for (const target of RENDITION_TARGETS) {
    if (target.qualityHeight >= sourceClass) continue;
    if (sourceLongEdge < target.longEdge * MINIMUM_DOWNSCALE_RATIO) continue;
    const dimensions = computeRenditionDimensions(
      display.width,
      display.height,
      target.longEdge,
    );
    const key = `${dimensions.width}x${dimensions.height}`;
    if (seen.has(key)) continue;
    seen.add(key);
    requirements.push({ ...dimensions, qualityHeight: target.qualityHeight });
  }

  return requirements;
}

function pathImplementationFor(filePath: string, rootPath: string) {
  return path.win32.isAbsolute(filePath) || path.win32.isAbsolute(rootPath)
    ? path.win32
    : path;
}

export function isEligibleVideoPath(
  filePath: string,
  mediaRoot: string,
): boolean {
  const pathImpl = pathImplementationFor(filePath, mediaRoot);
  const relativePath = pathImpl.relative(
    pathImpl.resolve(mediaRoot),
    pathImpl.resolve(filePath),
  );

  if (
    !relativePath ||
    relativePath === ".." ||
    relativePath.startsWith(`..${pathImpl.sep}`) ||
    pathImpl.isAbsolute(relativePath)
  ) {
    return false;
  }

  const segments = relativePath.split(/[\\/]/).filter(Boolean);
  if (
    segments.some((segment) => {
      const normalized = segment.toLowerCase();
      return (
        normalized.startsWith(".") || EXCLUDED_DIRECTORY_NAMES.has(normalized)
      );
    })
  ) {
    return false;
  }

  const fileName = pathImpl.basename(filePath);
  if (isDerivativeFileName(fileName)) return false;

  return SUPPORTED_VIDEO_EXTENSIONS.has(
    pathImpl.extname(filePath).toLowerCase(),
  );
}

export function isExcludedDirectoryName(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  return normalized.startsWith(".") || EXCLUDED_DIRECTORY_NAMES.has(normalized);
}
