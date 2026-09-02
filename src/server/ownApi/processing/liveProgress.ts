/**
 * High-frequency progress, carried between two processes without a database.
 *
 * The encoder runs in the worker process and the page is served by the API
 * process, so nothing in memory can be shared between them. FFmpeg reports four
 * times a second and the page should move at that rate, but writing to Postgres
 * four times a second per job — for hours, per title — is write pressure paid
 * for nothing: none of it is worth surviving a restart, because the durable
 * progress is the checkpoints on disk.
 *
 * So the two are separated. This is the transient lane: one small file per job,
 * replaced by an atomic rename, holding only the latest sample. The durable
 * lane is the job record, written about once a second and on every state
 * change, and it is what a page sees before the first live sample arrives.
 *
 * The file lives in the system temporary directory rather than beside the
 * media. Four writes a second to an external drive is exactly the traffic this
 * design is trying to keep off it, and a sample that does not survive a reboot
 * loses nothing.
 */

import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ProcessingStage } from "./stages";

/** Where the build is, in terms an operator recognises. */
export type BuildPhase =
  | "planning"
  | "encoding"
  | "audio"
  | "subtitles"
  | "assembling"
  | "validating"
  | "publishing";

export interface LiveProgressSnapshot {
  processingJobId: string;
  /** Monotonic per job, so a page can discard a sample that arrived late. */
  revision: number;
  /** When the sample was taken, in epoch milliseconds. */
  timestampMs: number;
  stage: ProcessingStage;
  phase: BuildPhase;
  epochIndex: number | null;
  epochCount: number | null;
  epochStartSeconds: number | null;
  epochEndSeconds: number | null;
  /** How far through the running epoch, as a fraction. */
  epochFraction: number | null;
  completedEpochs: number;
  protectedSeconds: number;
  encodedSeconds: number;
  sourceDurationSeconds: number;
  fps?: number;
  speed?: number;
  /** Smoothed throughput the estimate is derived from, not FFmpeg's raw sample. */
  smoothedSpeed?: number;
  etaSeconds?: number;
  /** Bytes this attempt has written, checkpoints included. */
  writtenBytes?: number;
  encoder?: string;
  /** The rungs this build is producing. */
  qualityHeights?: number[];
}

export function liveProgressDirectory(): string {
  return (
    process.env.SEYIRLIK_LIVE_PROGRESS_DIR?.trim() ||
    path.join(tmpdir(), "seyirlik-live-progress")
  );
}

function fileFor(processingJobId: string): string {
  // The id comes from the database as a UUID, but it reaches this function
  // through several layers; refusing anything with a separator in it keeps a
  // malformed id from naming a path outside the directory.
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(processingJobId)) {
    throw new Error("A live-progress id must be a plain identifier.");
  }
  return path.join(liveProgressDirectory(), `${processingJobId}.json`);
}

/**
 * Publishes the latest sample.
 *
 * Written to a temporary name and renamed, so a reader never sees half a
 * document. Failures are swallowed: this is telemetry, and an encode must not
 * stop because a temporary directory is full.
 */
export async function writeLiveProgress(
  snapshot: LiveProgressSnapshot,
): Promise<void> {
  try {
    const target = fileFor(snapshot.processingJobId);
    await mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(snapshot), "utf8");
    await rename(temporary, target);
  } catch {
    // Telemetry only.
  }
}

export async function readLiveProgress(
  processingJobId: string,
): Promise<LiveProgressSnapshot | null> {
  try {
    const raw = await readFile(fileFor(processingJobId), "utf8");
    const parsed = JSON.parse(raw) as LiveProgressSnapshot;
    return parsed.processingJobId === processingJobId ? parsed : null;
  } catch {
    return null;
  }
}

export async function clearLiveProgress(
  processingJobId: string,
): Promise<void> {
  try {
    await rm(fileFor(processingJobId), { force: true });
  } catch {
    // Nothing to clear.
  }
}

/**
 * Removes samples for jobs that are no longer running.
 *
 * A worker killed mid-encode leaves its last sample behind, and a page that
 * found it would show a frozen speed and a stale epoch as though the encode
 * were still going. Called at startup, when the set of live jobs is known.
 */
export async function pruneLiveProgress(
  activeJobIds: readonly string[],
): Promise<number> {
  const keep = new Set(activeJobIds);
  let removed = 0;
  try {
    for (const entry of await readdir(liveProgressDirectory())) {
      if (!entry.endsWith(".json")) continue;
      const id = entry.slice(0, -".json".length);
      if (keep.has(id)) continue;
      await rm(path.join(liveProgressDirectory(), entry), { force: true });
      removed += 1;
    }
  } catch {
    // The directory has never been written to.
  }
  return removed;
}

/**
 * A sample old enough that whatever produced it has plainly stopped.
 *
 * The encoder reports four times a second, so anything older than a few seconds
 * means the worker died, was paused at the process level, or lost its storage.
 * The page must not keep animating a bar from it.
 */
export const LIVE_PROGRESS_STALE_MS = 6_000;

export function liveProgressIsFresh(
  snapshot: LiveProgressSnapshot,
  nowMs: number = Date.now(),
): boolean {
  return nowMs - snapshot.timestampMs <= LIVE_PROGRESS_STALE_MS;
}
