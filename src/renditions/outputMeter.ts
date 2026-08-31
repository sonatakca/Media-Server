import { stat } from "node:fs/promises";

/**
 * How many bytes the job running right now has actually written.
 *
 * FFmpeg reports `total_size` on its progress stream, and for most outputs
 * that would answer this directly — but not for this one. The HLS muxer writes
 * through child muxers and reports `total_size=N/A`, which is why every job in
 * the database recorded zero bytes written even after finishing. So the bytes
 * are measured from the files instead.
 *
 * The measurement is deliberately narrow. It stats an explicit list of the
 * media files *this run* is producing — one per rendition being encoded — and
 * never walks the package tree. An incremental job adding 1440p therefore
 * counts the 1440p media file and nothing else: the 2160p, 1080p and audio
 * files it is reusing are not its output and must not be reported as such.
 *
 * Playlists and the master are excluded. They are a few kilobytes against
 * gigabytes of media, they are rewritten rather than appended, and including
 * them would make the figure jitter for no visible benefit.
 */

/** Smallest gap between filesystem measurements, however often progress ticks. */
export const OUTPUT_MEASURE_INTERVAL_MS = 1_000;

export interface OutputMeter {
  /** The most recent measurement, or undefined before the first one lands. */
  latest(): number | undefined;
  /**
   * Starts a measurement if enough time has passed. Returns immediately: the
   * encoder's progress stream must never wait on the filesystem.
   */
  sample(): void;
  /** Measures now, ignoring the throttle. For the final figure. */
  measure(): Promise<number>;
}

export function createOutputMeter(
  files: readonly string[],
  options: {
    intervalMs?: number;
    now?: () => number;
    sizeOf?: (file: string) => Promise<number>;
  } = {},
): OutputMeter {
  const intervalMs = options.intervalMs ?? OUTPUT_MEASURE_INTERVAL_MS;
  const now = options.now ?? Date.now;
  const sizeOf =
    options.sizeOf ??
    (async (file: string) => {
      const stats = await stat(file).catch(() => undefined);
      return stats?.isFile() ? stats.size : 0;
    });

  let latest: number | undefined;
  let lastAt = Number.NEGATIVE_INFINITY;
  let inFlight = false;

  const measure = async (): Promise<number> => {
    let total = 0;
    for (const file of files) total += await sizeOf(file);
    latest = total;
    return total;
  };

  return {
    latest: () => latest,
    sample: () => {
      // A file that does not exist yet is zero bytes, not an error: the encoder
      // has not reached it. Nothing here may throw into the progress stream.
      if (inFlight || now() - lastAt < intervalMs) return;
      inFlight = true;
      lastAt = now();
      void measure()
        .catch(() => undefined)
        .finally(() => {
          inFlight = false;
        });
    },
    measure,
  };
}
