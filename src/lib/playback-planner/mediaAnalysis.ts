import { spawn } from "node:child_process";
import { extname } from "node:path";
import type {
  AudioStreamAnalysis,
  MediaAnalysis,
  SubtitleStreamAnalysis,
  VideoStreamAnalysis,
} from "./types";

interface FfprobeStream {
  index?: number;
  codec_type?: string;
  codec_name?: string;
  codec_long_name?: string;
  profile?: string;
  level?: number | string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  bit_rate?: string | number;
  bits_per_raw_sample?: string | number;
  pix_fmt?: string;
  color_range?: string;
  color_space?: string;
  color_transfer?: string;
  color_primaries?: string;
  channels?: number;
  channel_layout?: string;
  sample_rate?: string | number;
  tags?: Record<string, string | undefined>;
  disposition?: Record<string, number | undefined>;
  side_data_list?: Array<Record<string, unknown>>;
}

interface FfprobeChapter {
  id?: number;
  start_time?: string;
  end_time?: string;
  tags?: Record<string, string | undefined>;
}

interface FfprobeOutput {
  format?: {
    format_name?: string;
    duration?: string | number;
    bit_rate?: string | number;
  };
  streams?: FfprobeStream[];
  chapters?: FfprobeChapter[];
}

const DIRECT_PLAYABLE_EXTENSIONS = new Set(["mp4", "m4v", "mov", "webm"]);
const IMAGE_SUBTITLE_CODECS = new Set([
  "hdmv_pgs_subtitle",
  "dvd_subtitle",
  "xsub",
  "dvb_subtitle",
]);

function parseNumber(value: string | number | undefined): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseFrameRate(value: string | undefined): number | undefined {
  if (!value || value === "0/0") {
    return undefined;
  }

  const [rawNumerator, rawDenominator] = value.split("/");
  const numerator = Number(rawNumerator);
  const denominator = rawDenominator ? Number(rawDenominator) : 1;

  if (
    !Number.isFinite(numerator) ||
    !Number.isFinite(denominator) ||
    denominator === 0
  ) {
    return undefined;
  }

  const rate = numerator / denominator;
  return Number.isFinite(rate) && rate > 0 ? rate : undefined;
}

function parseBitDepth(stream: FfprobeStream): number | undefined {
  const explicitDepth = parseNumber(stream.bits_per_raw_sample);

  if (explicitDepth && explicitDepth > 0) {
    return explicitDepth;
  }

  const pixFmt = stream.pix_fmt?.toLowerCase();

  if (!pixFmt) {
    return undefined;
  }

  const matchedDepth = pixFmt.match(/(?:p|yuv\d+p)(10|12|14|16)le/);

  if (matchedDepth?.[1]) {
    return Number(matchedDepth[1]);
  }

  if (pixFmt.includes("10")) {
    return 10;
  }

  if (pixFmt.includes("12")) {
    return 12;
  }

  if (pixFmt.includes("16")) {
    return 16;
  }

  return 8;
}

function isHdrStream(stream: FfprobeStream): boolean {
  const transfer = stream.color_transfer?.toLowerCase();

  return (
    transfer === "smpte2084" ||
    transfer === "arib-std-b67" ||
    Boolean(stream.tags?.["DOVI configuration record"])
  );
}

function hasDolbyVision(stream: FfprobeStream): boolean {
  const serializedSideData = JSON.stringify(stream.side_data_list ?? [])
    .toLowerCase()
    .replace(/\s+/g, " ");

  return (
    serializedSideData.includes("dolby vision") ||
    serializedSideData.includes("dovi") ||
    Boolean(stream.tags?.["DOVI configuration record"])
  );
}

function normalizeCodecName(codecName: string | undefined): string {
  return (codecName ?? "unknown").toLowerCase();
}

function normalizeExtension(filePath: string): string | undefined {
  const extension = extname(filePath).replace(/^\./, "").toLowerCase();
  return extension || undefined;
}

function isDirectPlayableContainer(
  formatName: string,
  extension: string | undefined,
): boolean {
  if (extension && DIRECT_PLAYABLE_EXTENSIONS.has(extension)) {
    return true;
  }

  const normalizedFormat = formatName.toLowerCase();

  if (normalizedFormat.includes("matroska") && extension !== "webm") {
    return false;
  }

  return (
    normalizedFormat.includes("mp4") ||
    normalizedFormat.includes("mov") ||
    normalizedFormat.includes("webm")
  );
}

function mapVideoStream(stream: FfprobeStream): VideoStreamAnalysis {
  const codecName = normalizeCodecName(stream.codec_name);

  return {
    index: stream.index ?? 0,
    codecName,
    codecLongName: stream.codec_long_name,
    profile: stream.profile,
    level: stream.level,
    width: stream.width ?? 0,
    height: stream.height ?? 0,
    framerate:
      parseFrameRate(stream.avg_frame_rate) ??
      parseFrameRate(stream.r_frame_rate),
    bitrate: parseNumber(stream.bit_rate),
    pixFmt: stream.pix_fmt,
    bitDepth: parseBitDepth(stream),
    colorRange: stream.color_range,
    colorSpace: stream.color_space,
    colorTransfer: stream.color_transfer,
    colorPrimaries: stream.color_primaries,
    isHdr: isHdrStream(stream),
    hasDolbyVision: hasDolbyVision(stream),
  };
}

function mapAudioStream(stream: FfprobeStream): AudioStreamAnalysis {
  return {
    index: stream.index ?? 0,
    codecName: normalizeCodecName(stream.codec_name),
    codecLongName: stream.codec_long_name,
    channels: stream.channels,
    channelLayout: stream.channel_layout,
    bitrate: parseNumber(stream.bit_rate),
    sampleRate: parseNumber(stream.sample_rate),
    language: stream.tags?.language,
    title: stream.tags?.title,
    isDefault: stream.disposition?.default === 1,
  };
}

function mapSubtitleStream(stream: FfprobeStream): SubtitleStreamAnalysis {
  const codecName = normalizeCodecName(stream.codec_name);

  return {
    index: stream.index ?? 0,
    codecName,
    language: stream.tags?.language,
    title: stream.tags?.title,
    isDefault: stream.disposition?.default === 1,
    isForced: stream.disposition?.forced === 1,
    isImageBased: IMAGE_SUBTITLE_CODECS.has(codecName),
  };
}

function runFfprobe(filePath: string): Promise<FfprobeOutput> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffprobe", [
      "-v",
      "error",
      "-show_format",
      "-show_streams",
      "-show_chapters",
      "-print_format",
      "json",
      filePath,
    ]);
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `ffprobe failed with exit code ${code ?? "unknown"}: ${stderr}`,
          ),
        );
        return;
      }

      try {
        resolve(JSON.parse(stdout) as FfprobeOutput);
      } catch (error) {
        reject(error);
      }
    });
  });
}

export async function analyseMediaFile(
  filePath: string,
  mediaId: string,
): Promise<MediaAnalysis> {
  const ffprobe = await runFfprobe(filePath);
  const streams = ffprobe.streams ?? [];
  const formatName = ffprobe.format?.format_name ?? "unknown";
  const extension = normalizeExtension(filePath);
  const durationSeconds = parseNumber(ffprobe.format?.duration) ?? 0;
  const overallBitrate = parseNumber(ffprobe.format?.bit_rate);

  return {
    mediaId,
    filePath,
    container: {
      formatName,
      extension,
      isBrowserDirectPlayableContainer: isDirectPlayableContainer(
        formatName,
        extension,
      ),
    },
    durationSeconds,
    overallBitrate,
    videoStreams: streams
      .filter((stream) => stream.codec_type === "video")
      .map(mapVideoStream),
    audioStreams: streams
      .filter((stream) => stream.codec_type === "audio")
      .map(mapAudioStream),
    subtitleStreams: streams
      .filter((stream) => stream.codec_type === "subtitle")
      .map(mapSubtitleStream),
    chapters: (ffprobe.chapters ?? []).map((chapter) => ({
      id: chapter.id,
      startSeconds: parseNumber(chapter.start_time) ?? 0,
      endSeconds: parseNumber(chapter.end_time) ?? 0,
      title: chapter.tags?.title,
    })),
    analysedAt: new Date().toISOString(),
  };
}
