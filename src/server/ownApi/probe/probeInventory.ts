import type { MediaAnalysis } from "../../../lib/playback-planner/types";

/**
 * Translation from an ffprobe analysis into the normalized rows the catalogue
 * stores.
 *
 * Keeping this pure matters: the playback planner and the browser both make
 * decisions from these fields, so the mapping is the part worth pinning down
 * with tests rather than the process plumbing around it.
 */

export interface PersistedStream {
  streamIndex: number;
  kind: "video" | "audio" | "subtitle";
  codec: string | null;
  profile: string | null;
  level: number | null;
  language: string | null;
  title: string | null;
  isDefault: boolean;
  isForced: boolean;
  isTextSubtitle: boolean;
  channels: number | null;
  sampleRate: number | null;
  bitrateBps: number | null;
  width: number | null;
  height: number | null;
  pixelFormat: string | null;
  frameRate: number | null;
  videoRange: string | null;
  colorTransfer: string | null;
  colorPrimaries: string | null;
  colorSpace: string | null;
  bitDepth: number | null;
}

export interface PersistedChapter {
  chapterIndex: number;
  startMs: number;
  name: string | null;
}

export interface PersistedProbe {
  durationMs: number | null;
  bitrateBps: number | null;
  container: string | null;
  streams: PersistedStream[];
  chapters: PersistedChapter[];
}

function toLevel(level: number | string | undefined): number | null {
  if (level === undefined) return null;
  const numeric = typeof level === "number" ? level : Number(level);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : null;
}

function toInteger(value: number | undefined): number | null {
  return value === undefined || !Number.isFinite(value)
    ? null
    : Math.trunc(value);
}

/**
 * The player needs to know whether HDR tone-mapping is required before it picks
 * a delivery mode, so the range is derived once here rather than re-inferred
 * from colour primaries at every call site.
 */
function toVideoRange(stream: {
  isHdr?: boolean;
  hasDolbyVision?: boolean;
}): string | null {
  if (stream.hasDolbyVision) return "DOVI";
  if (stream.isHdr) return "HDR";
  return "SDR";
}

export function toPersistedProbe(analysis: MediaAnalysis): PersistedProbe {
  const streams: PersistedStream[] = [];

  for (const video of analysis.videoStreams) {
    streams.push({
      streamIndex: video.index,
      kind: "video",
      codec: video.codecName || null,
      profile: video.profile ?? null,
      level: toLevel(video.level),
      language: null,
      title: null,
      isDefault: false,
      isForced: false,
      isTextSubtitle: false,
      channels: null,
      sampleRate: null,
      bitrateBps: toInteger(video.bitrate),
      width: toInteger(video.width),
      height: toInteger(video.height),
      pixelFormat: video.pixFmt ?? null,
      frameRate:
        video.framerate === undefined || !Number.isFinite(video.framerate)
          ? null
          : video.framerate,
      videoRange: toVideoRange(video),
      colorTransfer: video.colorTransfer ?? null,
      colorPrimaries: video.colorPrimaries ?? null,
      colorSpace: video.colorSpace ?? null,
      bitDepth: toInteger(video.bitDepth),
    });
  }

  for (const audio of analysis.audioStreams) {
    streams.push({
      streamIndex: audio.index,
      kind: "audio",
      codec: audio.codecName || null,
      profile: null,
      level: null,
      language: audio.language ?? null,
      title: audio.title ?? null,
      isDefault: audio.isDefault === true,
      isForced: false,
      isTextSubtitle: false,
      channels: toInteger(audio.channels),
      sampleRate: toInteger(audio.sampleRate),
      bitrateBps: toInteger(audio.bitrate),
      width: null,
      height: null,
      pixelFormat: null,
      frameRate: null,
      videoRange: null,
      colorTransfer: null,
      colorPrimaries: null,
      colorSpace: null,
      bitDepth: null,
    });
  }

  for (const subtitle of analysis.subtitleStreams) {
    streams.push({
      streamIndex: subtitle.index,
      kind: "subtitle",
      codec: subtitle.codecName || null,
      profile: null,
      level: null,
      language: subtitle.language ?? null,
      title: subtitle.title ?? null,
      isDefault: subtitle.isDefault === true,
      isForced: subtitle.isForced === true,
      // Image-based subtitles (PGS, VOBSUB) cannot be converted to WebVTT and
      // must be burned in, so the distinction is stored rather than recomputed.
      isTextSubtitle: !subtitle.isImageBased,
      channels: null,
      sampleRate: null,
      bitrateBps: null,
      width: null,
      height: null,
      pixelFormat: null,
      frameRate: null,
      videoRange: null,
      colorTransfer: null,
      colorPrimaries: null,
      colorSpace: null,
      bitDepth: null,
    });
  }

  const chapters: PersistedChapter[] = (analysis.chapters ?? [])
    .map((chapter, index) => ({
      chapterIndex: index,
      startMs: Math.max(0, Math.round(chapter.startSeconds * 1_000)),
      name: chapter.title?.trim() ? chapter.title.trim() : null,
    }))
    .sort((left, right) => left.startMs - right.startMs)
    .map((chapter, index) => ({ ...chapter, chapterIndex: index }));

  const durationMs =
    Number.isFinite(analysis.durationSeconds) && analysis.durationSeconds > 0
      ? Math.round(analysis.durationSeconds * 1_000)
      : null;

  return {
    durationMs,
    bitrateBps: toInteger(analysis.overallBitrate),
    container:
      analysis.container.extension ?? analysis.container.formatName ?? null,
    streams: streams.sort(
      (left, right) => left.streamIndex - right.streamIndex,
    ),
    chapters,
  };
}
