import { spawn } from "node:child_process";

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
  return new Promise((resolve, reject) => {
    const child = spawn(
      ffmpegPath,
      buildSubtitleExtractionArgs(inputPath, streamIndex),
      { windowsHide: true },
    );
    const chunks: Buffer[] = [];
    let byteLength = 0;
    let settled = false;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(Buffer.concat(chunks, byteLength));
    };

    const timeout = setTimeout(() => {
      child.kill();
      finish(new Error("Subtitle extraction timed out."));
    }, SUBTITLE_EXTRACTION_TIMEOUT_MS);
    timeout.unref();

    child.stdout.on("data", (chunk: Buffer) => {
      byteLength += chunk.length;
      if (byteLength > MAX_SUBTITLE_BYTES) {
        child.kill();
        finish(new Error("Extracted subtitle is too large."));
        return;
      }
      chunks.push(chunk);
    });
    // Drain stderr so FFmpeg cannot block, but discard it because it can
    // contain the private media path.
    child.stderr.resume();
    child.once("error", () =>
      finish(new Error("Subtitle extraction could not be started.")),
    );
    child.once("close", (code) => {
      if (code !== 0) {
        finish(new Error("Subtitle extraction failed."));
        return;
      }
      finish();
    });
  });
}
