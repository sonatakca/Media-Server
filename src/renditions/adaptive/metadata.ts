/**
 * The adaptive package manifest and its strict reader.
 *
 * Parsing is deliberately unforgiving. Everything downstream — the validator,
 * the delivery route, the planner — treats a parsed manifest as the authority
 * on which bytes exist and where, so a field that is merely *probably* right is
 * worse than a rejection: the server resolves asset paths through this file and
 * nothing else, and a permissive reader would turn a corrupt manifest into a
 * path the request handler is willing to open.
 */

import path from "node:path";
import {
  ADAPTIVE_AUDIO_DIRECTORY,
  ADAPTIVE_MEDIA_FILE,
  ADAPTIVE_METADATA_SCHEMA_VERSION,
  ADAPTIVE_PLAYLIST_FILE,
  ADAPTIVE_POINTER_SCHEMA_VERSION,
  ADAPTIVE_VIDEO_DIRECTORY,
  isSafeRenditionId,
} from "./profile";

export type AdaptiveHdrState = "sdr" | "hdr10" | "hlg";

export interface AdaptiveVideoRenditionMetadata {
  /** Stable id, e.g. `720p`. Appears in playlists, URLs and diagnostics. */
  id: string;
  qualityHeight: number;
  width: number;
  height: number;
  codec: "h264" | "hevc";
  /** RFC 6381 codec string, e.g. `avc1.640028`, used verbatim in the master. */
  codecString: string;
  profile?: string;
  level?: string;
  pixelFormat: string;
  hdr: AdaptiveHdrState;
  colorPrimaries?: string;
  colorTransfer?: string;
  colorSpace?: string;
  frameRate: number;
  /** Measured from packaged bytes and duration, not from the configured cap. */
  averageBitrate: number;
  peakBitrate: number;
  durationSeconds: number;
  playlistPath: string;
  mediaPath: string;
  fileSizeBytes: number;
  keyframeCount: number;
  keyframeIntervalSeconds: {
    target: number;
    minimum: number;
    maximum: number;
    mean: number;
  };
  segmentCount: number;
}

export interface AdaptiveAudioRenditionMetadata {
  /** Stable id, e.g. `track-1`. */
  id: string;
  sourceStreamIndex: number;
  language?: string;
  title?: string;
  isDefault: boolean;
  isForced: boolean;
  codec: "aac";
  codecString: string;
  channels: number;
  sampleRate: number;
  averageBitrate: number;
  durationSeconds: number;
  playlistPath: string;
  mediaPath: string;
  fileSizeBytes: number;
  /** True when the source AAC was carried through without re-encoding. */
  streamCopied: boolean;
}

export interface AdaptivePackageMetadata {
  schemaVersion: number;
  profileVersion: string;
  mediaId: string;
  sourceFingerprint: string;
  createdAt: string;
  sourceDurationSeconds: number;
  source: {
    width: number;
    height: number;
    qualityHeight: number;
    codec: string;
    frameRate?: number;
    isHdr: boolean;
    isVariableFrameRate: boolean;
    rotation: number;
  };
  segmentTargetSeconds: number;
  /** Duration the video switching set actually covers, measured after packaging. */
  switchingSetDurationSeconds: number;
  masterPlaylistPath: string;
  videoRenditions: AdaptiveVideoRenditionMetadata[];
  audioRenditions: AdaptiveAudioRenditionMetadata[];
  validation: {
    validatedAt: string;
    alignmentToleranceSeconds: number;
    audioDurationToleranceSeconds: number;
    checks: string[];
  };
  storage: {
    videoBytes: number;
    audioBytes: number;
    totalBytes: number;
  };
  /**
   * Alternate audio tracks the encode deliberately left out, if any. Present so
   * an operator can tell "this title has one language" from "this run only
   * packaged the default track".
   */
  deferredAudioStreamIndexes?: number[];
}

export interface AdaptivePointer {
  schemaVersion: number;
  versionDirectory: string;
  sourceFingerprint: string;
  profileVersion: string;
}

const VERSION_DIRECTORY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,191}$/;
const CODEC_STRING_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const LANGUAGE_PATTERN = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function fail(message: string): never {
  throw new Error(`Adaptive package metadata is invalid: ${message}`);
}

function positiveNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    fail(`${field} must be a positive finite number.`);
  }
  return value;
}

function nonNegativeNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    fail(`${field} must be a non-negative finite number.`);
  }
  return value;
}

function positiveInteger(value: unknown, field: string): number {
  const parsed = positiveNumber(value, field);
  if (!Number.isSafeInteger(parsed)) fail(`${field} must be a safe integer.`);
  return parsed;
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${field} must be a non-empty string.`);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > 512) {
    fail(`${field} must be a string of at most 512 characters.`);
  }
  return value;
}

function fingerprint(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/i.test(value)) {
    fail(`${field} must be a 64-character hex digest.`);
  }
  return value;
}

function isoTimestamp(value: unknown, field: string): string {
  const text = nonEmptyString(value, field);
  if (Number.isNaN(Date.parse(text)))
    fail(`${field} must be an ISO timestamp.`);
  return text;
}

/**
 * A relative POSIX path that cannot leave the version directory.
 *
 * Checked structurally rather than by resolving against a root: this runs
 * during parsing, before any root is known, and the server must never be handed
 * a path it then has to remember to sanitise a second time. `..`, absolute
 * paths, Windows drive letters, backslashes and NUL are all rejected outright,
 * and the expected shape is pinned per asset kind by the callers below.
 */
function safeRelativePath(value: unknown, field: string): string {
  const text = nonEmptyString(value, field);
  if (
    text.length > 256 ||
    text.includes("\0") ||
    text.includes("\\") ||
    text.startsWith("/") ||
    /^[A-Za-z]:/.test(text) ||
    text.split("/").some((segment) => segment === "" || segment === "..") ||
    path.posix.normalize(text) !== text
  ) {
    fail(`${field} must be a relative path inside the package.`);
  }
  return text;
}

function parseKeyframeInterval(
  value: unknown,
): AdaptiveVideoRenditionMetadata["keyframeIntervalSeconds"] {
  if (!isRecord(value)) fail("keyframeIntervalSeconds must be an object.");
  return {
    target: positiveNumber(value.target, "keyframeIntervalSeconds.target"),
    minimum: positiveNumber(value.minimum, "keyframeIntervalSeconds.minimum"),
    maximum: positiveNumber(value.maximum, "keyframeIntervalSeconds.maximum"),
    mean: positiveNumber(value.mean, "keyframeIntervalSeconds.mean"),
  };
}

function parseVideoRendition(value: unknown): AdaptiveVideoRenditionMetadata {
  if (!isRecord(value)) fail("A video rendition entry must be an object.");
  const id = value.id;
  if (!isSafeRenditionId(id)) fail("Video rendition id is not a safe id.");

  const codec = value.codec;
  if (codec !== "h264" && codec !== "hevc") {
    fail("Video rendition codec must be h264 or hevc.");
  }
  const hdr = value.hdr;
  if (hdr !== "sdr" && hdr !== "hdr10" && hdr !== "hlg") {
    fail("Video rendition hdr must be sdr, hdr10 or hlg.");
  }
  const codecString = nonEmptyString(value.codecString, "codecString");
  if (!CODEC_STRING_PATTERN.test(codecString)) {
    fail("codecString contains characters that are unsafe in a playlist.");
  }

  const playlistPath = safeRelativePath(value.playlistPath, "playlistPath");
  const mediaPath = safeRelativePath(value.mediaPath, "mediaPath");
  if (
    playlistPath !==
    `${ADAPTIVE_VIDEO_DIRECTORY}/${id}/${ADAPTIVE_PLAYLIST_FILE}`
  ) {
    fail(`Video rendition ${id} playlist is not at its canonical location.`);
  }
  if (
    mediaPath !== `${ADAPTIVE_VIDEO_DIRECTORY}/${id}/${ADAPTIVE_MEDIA_FILE}`
  ) {
    fail(`Video rendition ${id} media file is not at its canonical location.`);
  }

  return {
    id,
    qualityHeight: positiveInteger(value.qualityHeight, "qualityHeight"),
    width: positiveInteger(value.width, "width"),
    height: positiveInteger(value.height, "height"),
    codec,
    codecString,
    ...(optionalString(value.profile, "profile") === undefined
      ? {}
      : { profile: value.profile as string }),
    ...(optionalString(value.level, "level") === undefined
      ? {}
      : { level: value.level as string }),
    pixelFormat: nonEmptyString(value.pixelFormat, "pixelFormat"),
    hdr,
    ...(optionalString(value.colorPrimaries, "colorPrimaries") === undefined
      ? {}
      : { colorPrimaries: value.colorPrimaries as string }),
    ...(optionalString(value.colorTransfer, "colorTransfer") === undefined
      ? {}
      : { colorTransfer: value.colorTransfer as string }),
    ...(optionalString(value.colorSpace, "colorSpace") === undefined
      ? {}
      : { colorSpace: value.colorSpace as string }),
    frameRate: positiveNumber(value.frameRate, "frameRate"),
    averageBitrate: positiveNumber(value.averageBitrate, "averageBitrate"),
    peakBitrate: positiveNumber(value.peakBitrate, "peakBitrate"),
    durationSeconds: positiveNumber(value.durationSeconds, "durationSeconds"),
    playlistPath,
    mediaPath,
    fileSizeBytes: positiveInteger(value.fileSizeBytes, "fileSizeBytes"),
    keyframeCount: positiveInteger(value.keyframeCount, "keyframeCount"),
    keyframeIntervalSeconds: parseKeyframeInterval(
      value.keyframeIntervalSeconds,
    ),
    segmentCount: positiveInteger(value.segmentCount, "segmentCount"),
  };
}

function parseAudioRendition(value: unknown): AdaptiveAudioRenditionMetadata {
  if (!isRecord(value)) fail("An audio rendition entry must be an object.");
  const id = value.id;
  if (!isSafeRenditionId(id)) fail("Audio rendition id is not a safe id.");
  if (value.codec !== "aac") fail("Audio rendition codec must be aac.");

  const codecString = nonEmptyString(value.codecString, "codecString");
  if (!CODEC_STRING_PATTERN.test(codecString)) {
    fail(
      "Audio codecString contains characters that are unsafe in a playlist.",
    );
  }
  const language = optionalString(value.language, "language");
  if (language !== undefined && !LANGUAGE_PATTERN.test(language)) {
    fail("Audio rendition language is not a language tag.");
  }
  const sourceStreamIndex = nonNegativeNumber(
    value.sourceStreamIndex,
    "sourceStreamIndex",
  );
  if (!Number.isSafeInteger(sourceStreamIndex)) {
    fail("sourceStreamIndex must be an integer.");
  }
  if (id !== `track-${sourceStreamIndex}`) {
    fail("Audio rendition id does not match its source stream index.");
  }

  const playlistPath = safeRelativePath(value.playlistPath, "playlistPath");
  const mediaPath = safeRelativePath(value.mediaPath, "mediaPath");
  if (
    playlistPath !==
    `${ADAPTIVE_AUDIO_DIRECTORY}/${id}/${ADAPTIVE_PLAYLIST_FILE}`
  ) {
    fail(`Audio rendition ${id} playlist is not at its canonical location.`);
  }
  if (
    mediaPath !== `${ADAPTIVE_AUDIO_DIRECTORY}/${id}/${ADAPTIVE_MEDIA_FILE}`
  ) {
    fail(`Audio rendition ${id} media file is not at its canonical location.`);
  }
  if (typeof value.isDefault !== "boolean")
    fail("isDefault must be a boolean.");
  if (typeof value.isForced !== "boolean") fail("isForced must be a boolean.");
  if (typeof value.streamCopied !== "boolean") {
    fail("streamCopied must be a boolean.");
  }

  return {
    id,
    sourceStreamIndex,
    ...(language === undefined ? {} : { language }),
    ...(optionalString(value.title, "title") === undefined
      ? {}
      : { title: value.title as string }),
    isDefault: value.isDefault,
    isForced: value.isForced,
    codec: "aac",
    codecString,
    channels: positiveInteger(value.channels, "channels"),
    sampleRate: positiveInteger(value.sampleRate, "sampleRate"),
    averageBitrate: positiveNumber(value.averageBitrate, "averageBitrate"),
    durationSeconds: positiveNumber(value.durationSeconds, "durationSeconds"),
    playlistPath,
    mediaPath,
    fileSizeBytes: positiveInteger(value.fileSizeBytes, "fileSizeBytes"),
    streamCopied: value.streamCopied,
  };
}

export function parseAdaptiveMetadata(
  value: unknown,
  expected?: {
    mediaId?: string;
    sourceFingerprint?: string;
    profileVersion?: string;
  },
): AdaptivePackageMetadata {
  if (!isRecord(value)) fail("The manifest must be an object.");
  if (value.schemaVersion !== ADAPTIVE_METADATA_SCHEMA_VERSION) {
    fail(
      `schemaVersion must be ${ADAPTIVE_METADATA_SCHEMA_VERSION}, not ${String(value.schemaVersion)}.`,
    );
  }
  if (!isRecord(value.source)) fail("source must be an object.");
  if (!isRecord(value.validation)) fail("validation must be an object.");
  if (!isRecord(value.storage)) fail("storage must be an object.");
  if (
    !Array.isArray(value.videoRenditions) ||
    value.videoRenditions.length === 0
  ) {
    fail("videoRenditions must be a non-empty array.");
  }
  if (
    !Array.isArray(value.audioRenditions) ||
    value.audioRenditions.length === 0
  ) {
    fail("audioRenditions must be a non-empty array.");
  }
  if (!Array.isArray(value.validation.checks)) {
    fail("validation.checks must be an array.");
  }

  const videoRenditions = value.videoRenditions.map(parseVideoRendition);
  const audioRenditions = value.audioRenditions.map(parseAudioRendition);

  if (
    new Set(videoRenditions.map((entry) => entry.id)).size !==
    videoRenditions.length
  ) {
    fail("videoRenditions contains duplicate ids.");
  }
  if (
    new Set(audioRenditions.map((entry) => entry.id)).size !==
    audioRenditions.length
  ) {
    fail("audioRenditions contains duplicate ids.");
  }
  if (audioRenditions.filter((entry) => entry.isDefault).length !== 1) {
    fail("Exactly one audio rendition must be marked default.");
  }

  const rotationValue = value.source.rotation;
  if (
    typeof rotationValue !== "number" ||
    ![0, 90, 180, 270].includes(rotationValue)
  ) {
    fail("source.rotation must be 0, 90, 180 or 270.");
  }
  if (typeof value.source.isHdr !== "boolean") {
    fail("source.isHdr must be a boolean.");
  }
  if (typeof value.source.isVariableFrameRate !== "boolean") {
    fail("source.isVariableFrameRate must be a boolean.");
  }

  const metadata: AdaptivePackageMetadata = {
    schemaVersion: ADAPTIVE_METADATA_SCHEMA_VERSION,
    profileVersion: nonEmptyString(value.profileVersion, "profileVersion"),
    mediaId: nonEmptyString(value.mediaId, "mediaId"),
    sourceFingerprint: fingerprint(
      value.sourceFingerprint,
      "sourceFingerprint",
    ),
    createdAt: isoTimestamp(value.createdAt, "createdAt"),
    sourceDurationSeconds: positiveNumber(
      value.sourceDurationSeconds,
      "sourceDurationSeconds",
    ),
    source: {
      width: positiveInteger(value.source.width, "source.width"),
      height: positiveInteger(value.source.height, "source.height"),
      qualityHeight: positiveInteger(
        value.source.qualityHeight,
        "source.qualityHeight",
      ),
      codec: nonEmptyString(value.source.codec, "source.codec"),
      ...(value.source.frameRate === undefined
        ? {}
        : {
            frameRate: positiveNumber(
              value.source.frameRate,
              "source.frameRate",
            ),
          }),
      isHdr: value.source.isHdr,
      isVariableFrameRate: value.source.isVariableFrameRate,
      rotation: rotationValue,
    },
    segmentTargetSeconds: positiveNumber(
      value.segmentTargetSeconds,
      "segmentTargetSeconds",
    ),
    switchingSetDurationSeconds: positiveNumber(
      value.switchingSetDurationSeconds,
      "switchingSetDurationSeconds",
    ),
    masterPlaylistPath: safeRelativePath(
      value.masterPlaylistPath,
      "masterPlaylistPath",
    ),
    videoRenditions,
    audioRenditions,
    validation: {
      validatedAt: isoTimestamp(
        value.validation.validatedAt,
        "validation.validatedAt",
      ),
      alignmentToleranceSeconds: positiveNumber(
        value.validation.alignmentToleranceSeconds,
        "validation.alignmentToleranceSeconds",
      ),
      audioDurationToleranceSeconds: positiveNumber(
        value.validation.audioDurationToleranceSeconds,
        "validation.audioDurationToleranceSeconds",
      ),
      checks: value.validation.checks.map((check, index) =>
        nonEmptyString(check, `validation.checks[${index}]`),
      ),
    },
    storage: {
      videoBytes: positiveInteger(
        value.storage.videoBytes,
        "storage.videoBytes",
      ),
      audioBytes: positiveInteger(
        value.storage.audioBytes,
        "storage.audioBytes",
      ),
      totalBytes: positiveInteger(
        value.storage.totalBytes,
        "storage.totalBytes",
      ),
    },
    ...(value.deferredAudioStreamIndexes === undefined
      ? {}
      : {
          deferredAudioStreamIndexes: (() => {
            if (!Array.isArray(value.deferredAudioStreamIndexes)) {
              fail("deferredAudioStreamIndexes must be an array.");
            }
            return value.deferredAudioStreamIndexes.map((entry, index) => {
              const parsed = nonNegativeNumber(
                entry,
                `deferredAudioStreamIndexes[${index}]`,
              );
              if (!Number.isSafeInteger(parsed)) {
                fail(
                  `deferredAudioStreamIndexes[${index}] must be an integer.`,
                );
              }
              return parsed;
            });
          })(),
        }),
  };

  const measuredTotal =
    metadata.storage.videoBytes + metadata.storage.audioBytes;
  if (measuredTotal !== metadata.storage.totalBytes) {
    fail("storage.totalBytes does not equal videoBytes plus audioBytes.");
  }
  if (expected?.mediaId && metadata.mediaId !== expected.mediaId) {
    fail("mediaId does not match the requested media.");
  }
  if (
    expected?.sourceFingerprint &&
    metadata.sourceFingerprint !== expected.sourceFingerprint
  ) {
    fail("sourceFingerprint does not match the current source.");
  }
  if (
    expected?.profileVersion &&
    metadata.profileVersion !== expected.profileVersion
  ) {
    fail("profileVersion does not match the expected profile.");
  }
  return metadata;
}

export function parseAdaptivePointer(value: unknown): AdaptivePointer {
  if (!isRecord(value)) throw new Error("Adaptive pointer is invalid.");
  if (
    value.schemaVersion !== ADAPTIVE_POINTER_SCHEMA_VERSION ||
    typeof value.versionDirectory !== "string" ||
    !VERSION_DIRECTORY_PATTERN.test(value.versionDirectory) ||
    value.versionDirectory.includes("..") ||
    typeof value.sourceFingerprint !== "string" ||
    !/^[0-9a-f]{64}$/i.test(value.sourceFingerprint) ||
    typeof value.profileVersion !== "string" ||
    !value.profileVersion
  ) {
    throw new Error("Adaptive pointer is invalid.");
  }
  return {
    schemaVersion: ADAPTIVE_POINTER_SCHEMA_VERSION,
    versionDirectory: value.versionDirectory,
    sourceFingerprint: value.sourceFingerprint,
    profileVersion: value.profileVersion,
  };
}
