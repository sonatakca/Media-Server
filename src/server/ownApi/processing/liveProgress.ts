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
import type {
  AssemblyPhaseProgress,
  AudioPhaseProgress,
  PublishPhaseProgress,
  VerificationPhaseProgress,
} from "../../../renditions/adaptive/phaseProgress";
import type { SourceDamageRecord } from "../../../renditions/adaptive/epochs/salvage";

/**
 * What the encoder currently believes about the source it is reading.
 *
 * The states are a diagnosis in progress, and they are separate on purpose: a
 * page that says "source read problem" the instant media time stops would be
 * wrong most of the time — an encoder can be busy for six seconds — and one
 * that says nothing at all leaves a viewer watching a speed figure fall for
 * minutes while FFmpeg is blocked on a platter that will never answer.
 *
 *  - `waiting`     media time has stopped and nothing is known yet.
 *  - `aborting`    it has stopped for too long; the encoder is being killed.
 *  - `suspected`   a read failed; the volume is being re-checked.
 *  - `confirmed`   the read budget is spent and the volume is healthy.
 *  - `replacing`   synthetic media of the planned length is being produced.
 *  - `replaced`    the interval has been substituted and the build moved on.
 */
export type SourceIoState =
  | "waiting"
  | "aborting"
  | "suspected"
  | "confirmed"
  | "replacing"
  | "replaced";

export interface SourceIoStatus {
  state: SourceIoState;
  epochIndex: number | null;
  /** The source interval in question, so the page can name the minutes. */
  startSeconds: number | null;
  endSeconds: number | null;
  /** Reads attempted so far, and the budget. */
  attempt?: number;
  maxAttempts?: number;
  /** When media time last advanced, so the page can say how long it has been. */
  advancedAtMs?: number;
  /** Media seconds the encoder had produced when it stopped producing. */
  lastMediaSeconds?: number;
  /** Where the build carries on from, once an interval has been replaced. */
  resumeSeconds?: number;
}

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
  /**
   * When this sample was published, in epoch milliseconds.
   *
   * Refreshed by the heartbeat as well as by real progress, so it answers only
   * "is the worker still there" — the reader uses it to decide whether to trust
   * the sample at all, never to decide whether work is advancing.
   */
  timestampMs: number;
  /**
   * When the values in this sample were last actually measured.
   *
   * Differs from `timestampMs` whenever the worker is inside an operation that
   * reports nothing until it returns: a probe of a ten-gigabyte rendition, a
   * cross-volume publish. The panel stays alive on the strength of the first;
   * the rate and remaining time are withdrawn on the strength of the second,
   * because those describe something happening now. Absent on samples written
   * before this field existed, where the two were always the same.
   */
  confirmedAtMs?: number;
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
  /**
   * Cumulative progress across the whole job, in [0,1).
   *
   * The one number the top bar is drawn from. Monotonic within an attempt and
   * deliberately never 1: completion is a fact about the job row, not about a
   * sample. The page shows it as a bar and never as a percentage, because its
   * phase boundaries are an estimate even though everything inside each phase
   * is measured.
   */
  globalProgress?: number;
  /** How far through the current phase, measured by that phase's own work. */
  phaseFraction?: number;
  /**
   * The current phase's own detail. Exactly one is present at a time — the one
   * belonging to `phase` — and it is absent entirely during video, whose
   * detail is the epoch fields above.
   */
  audio?: AudioPhaseProgress;
  assembly?: AssemblyPhaseProgress;
  verification?: VerificationPhaseProgress;
  publish?: PublishPhaseProgress;
  /**
   * A line per finished phase, kept so the page can show what is already done
   * without holding a log. Summaries only: no samples, no history.
   */
  completedPhases?: CompletedPhaseSummary[];
  /**
   * The source-read diagnosis, present only while there is one to make.
   *
   * Its absence is the ordinary case and means the encoder is reading normally.
   */
  sourceIo?: SourceIoStatus;
  /**
   * Intervals already replaced in this attempt.
   *
   * Carried live so the page can name them while the job is still running,
   * rather than only once the row is written at the end.
   */
  sourceDamage?: SourceDamageRecord[];
}

/** What a finished phase leaves behind on the page. */
export interface CompletedPhaseSummary {
  phase: BuildPhase;
  /** Wall seconds the phase took. */
  elapsedSeconds: number;
  /** Bytes it produced or moved, when that is the meaningful figure. */
  bytes?: number;
  /** Items it handled: epochs, tracks, renditions, checks. */
  count?: number;
  /** True when the phase was satisfied by existing work rather than redone. */
  reused?: boolean;
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
