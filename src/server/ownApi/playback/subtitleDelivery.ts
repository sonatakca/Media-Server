import path from "node:path";
import { isPathInsideRoot } from "../../pathSecurity";
import type {
  MediaFileRow,
  MediaStreamRow,
} from "../catalogue/catalogueRepository";
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

/**
 * Where one text subtitle of `file` is read from: the file itself, or the
 * sidecar the stream came from. Null when the index names no text subtitle of
 * that file, or when its path would leave the media root.
 */
export function resolveTextSubtitleInput(
  file: Pick<MediaFileRow, "relativePath">,
  streams: readonly MediaStreamRow[],
  streamIndex: number,
  mediaRoot: string,
): { inputPath: string; inputStreamIndex: number } | null {
  const stream = streams.find(
    (candidate) =>
      candidate.kind === "subtitle" &&
      candidate.streamIndex === streamIndex &&
      candidate.isTextSubtitle,
  );
  if (!stream) return null;
  const relativeInputPath = stream.isExternal
    ? stream.externalRelativePath
    : file.relativePath;
  if (!relativeInputPath) return null;
  const inputPath = path.resolve(mediaRoot, ...relativeInputPath.split("/"));
  if (!isPathInsideRoot(mediaRoot, inputPath)) return null;
  return {
    inputPath,
    inputStreamIndex: stream.isExternal ? 0 : stream.streamIndex,
  };
}
