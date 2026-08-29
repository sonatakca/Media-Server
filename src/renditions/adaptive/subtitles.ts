import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";

const MAX_WEBVTT_BYTES = 32 * 1024 * 1024;

export function buildWebVttExtractionArgs(
  inputPath: string,
  streamIndex: number,
  outputPath: string,
): string[] {
  return [
    "-v",
    "error",
    "-nostdin",
    "-y",
    "-i",
    inputPath,
    "-map",
    `0:${streamIndex}`,
    "-c:s",
    "webvtt",
    "-f",
    "webvtt",
    outputPath,
  ];
}

export async function extractWebVttFile({
  ffmpegPath,
  inputPath,
  streamIndex,
  outputPath,
  signal,
}: {
  ffmpegPath: string;
  inputPath: string;
  streamIndex: number;
  outputPath: string;
  signal?: AbortSignal;
}): Promise<{ fileSizeBytes: number; contents: string }> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      ffmpegPath,
      buildWebVttExtractionArgs(inputPath, streamIndex, outputPath),
      { shell: false, windowsHide: true },
    );
    let stderr = "";
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve();
    };
    const abort = () => {
      child.kill("SIGTERM");
      finish(new Error("Subtitle extraction was cancelled."));
    };
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.resume();
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-4096);
    });
    child.once("error", finish);
    child.once("close", (code) => {
      if (code !== 0) {
        finish(
          new Error(
            `WebVTT extraction for stream ${streamIndex} failed: ${stderr.trim() || `FFmpeg exited ${code}`}`,
          ),
        );
      } else finish();
    });
  });

  const file = await stat(outputPath);
  if (!file.isFile() || file.size <= 0 || file.size > MAX_WEBVTT_BYTES) {
    throw new Error(
      `WebVTT extraction for stream ${streamIndex} produced an invalid file size.`,
    );
  }
  const contents = await readFile(outputPath, "utf8");
  if (!/^WEBVTT(?:\s|$)/.test(contents)) {
    throw new Error(
      `WebVTT extraction for stream ${streamIndex} did not produce WebVTT.`,
    );
  }
  return { fileSizeBytes: file.size, contents };
}

export function buildWebVttMediaPlaylist(
  durationSeconds: number,
  subtitleFileName: string,
): string {
  const target = Math.max(1, Math.ceil(durationSeconds));
  return [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    `#EXT-X-TARGETDURATION:${target}`,
    "#EXT-X-MEDIA-SEQUENCE:0",
    "#EXT-X-PLAYLIST-TYPE:VOD",
    `#EXTINF:${durationSeconds.toFixed(6)},`,
    subtitleFileName,
    "#EXT-X-ENDLIST",
    "",
  ].join("\n");
}

export function parseWebVttMediaPlaylist(text: string): {
  durationSeconds: number;
  uri: string;
} {
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  if (lines[0] !== "#EXTM3U" || !lines.includes("#EXT-X-ENDLIST")) {
    throw new Error("WebVTT media playlist is not a complete HLS playlist.");
  }
  const extinfIndex = lines.findIndex((line) => line.startsWith("#EXTINF:"));
  const durationSeconds = Number(
    lines[extinfIndex]?.slice("#EXTINF:".length).split(",")[0],
  );
  const uri = lines[extinfIndex + 1];
  if (
    extinfIndex < 0 ||
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0 ||
    !uri ||
    uri.startsWith("#")
  ) {
    throw new Error("WebVTT media playlist has no valid subtitle segment.");
  }
  return { durationSeconds, uri };
}
