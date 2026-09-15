import { collectFfmpegOutput } from "./ffmpegOutput";

const MAX_SUBTITLE_BYTES = 32 * 1024 * 1024;
const SUBTITLE_EXTRACTION_TIMEOUT_MS = 60_000;

export function buildSubtitleExtractionArgs(
  inputPath: string,
  streamIndex: number,
): string[] {
  return [
    "-v",
    "error",
    "-nostdin",
    "-i",
    inputPath,
    "-map",
    `0:${streamIndex}`,
    "-c:s",
    "webvtt",
    "-f",
    "webvtt",
    "pipe:1",
  ];
}

/** Extracts one text subtitle without ever exposing its filesystem path. */
export function extractSubtitleAsWebVtt(
  inputPath: string,
  streamIndex: number,
  ffmpegPath = "ffmpeg",
): Promise<Buffer> {
  return collectFfmpegOutput(
    ffmpegPath,
    buildSubtitleExtractionArgs(inputPath, streamIndex),
    {
      label: "Subtitle extraction",
      maxBytes: MAX_SUBTITLE_BYTES,
      timeoutMs: SUBTITLE_EXTRACTION_TIMEOUT_MS,
    },
  );
}
