import { spawn } from "node:child_process";

export interface FfmpegOutputLimits {
  /** Names the job in error messages, which must never carry a media path. */
  label: string;
  maxBytes: number;
  timeoutMs: number;
}

/**
 * Runs FFmpeg and returns everything it wrote to stdout.
 *
 * Stderr is drained so FFmpeg cannot block on a full pipe, and discarded
 * because it can contain the private media path; errors carry only the label
 * for the same reason.
 */
export function collectFfmpegOutput(
  ffmpegPath: string,
  args: readonly string[],
  limits: FfmpegOutputLimits,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, [...args], { windowsHide: true });
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
      finish(new Error(`${limits.label} timed out.`));
    }, limits.timeoutMs);
    timeout.unref();

    child.stdout.on("data", (chunk: Buffer) => {
      byteLength += chunk.length;
      if (byteLength > limits.maxBytes) {
        child.kill();
        finish(new Error(`${limits.label} output is too large.`));
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.resume();
    child.once("error", () =>
      finish(new Error(`${limits.label} could not be started.`)),
    );
    child.once("close", (code) => {
      if (code !== 0) {
        finish(new Error(`${limits.label} failed.`));
        return;
      }
      finish();
    });
  });
}
