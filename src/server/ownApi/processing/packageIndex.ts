import { RENDITION_TARGETS } from "../../../renditions/policy";
import { ADAPTIVE_PROFILE_VERSION } from "../../../renditions/adaptive/profile";
import {
  readTitlePackageManifest,
  type TitlePackageManifest,
} from "../../../renditions/adaptive/publishTitle";
import {
  resolveTitleRoot,
  titleRootLayoutForKind,
} from "../../../renditions/adaptive/titleRoot";

/**
 * What the media volume already holds, read on a clock rather than on request.
 *
 * The processing page polls once a second while anything is running. Answering
 * "which rungs does this title already have" means opening a package manifest,
 * which is a read of the media HDD — for one movie that is nothing, and for a
 * library with The Sopranos in it that is eighty-six reads a second aimed at a
 * spinning disk this system's whole storage-safety design exists to protect.
 *
 * So the page is never what touches the volume. Entries are read at most once
 * per `ttlMs`, in the background, a bounded number at a time, and the overview
 * serves whatever the index currently holds. A title the index has not reached
 * yet reports `unknown` — which the page shows as "still looking", never as
 * "nothing on disk", because those are very different answers.
 */

export type ProcessingPackageState =
  /** The index has not read this title yet. Not a claim about the disk. */
  | "unknown"
  | "none"
  | "partial"
  | "complete"
  /** A package built from other bytes, or by a profile this one cannot read. */
  | "stale";

export interface ProcessingPackageSummary {
  present: boolean;
  /** True when the package was built from these bytes under this profile. */
  current: boolean;
  sourceMatches: boolean;
  profileMatches: boolean;
  rungs: number[];
  /** True when it holds every standard rung at or below its own best one. */
  complete: boolean;
  hdr: string;
  audioTracks: number;
  subtitleTracks: number;
  totalBytes: number;
}

export interface PackageIndexEntry {
  state: ProcessingPackageState;
  summary: ProcessingPackageSummary | null;
  readAt: number;
}

export interface PackageIndexTarget {
  mediaFileId: string;
  /** Absolute path of the canonical source. */
  sourcePath: string;
  /** Catalogue kind, which decides where this title's package lives. */
  kind: string;
  /** The source's fingerprint, or null when the source is gone. */
  fingerprint: string | null;
}

export interface PackageIndexOptions {
  /** How long an entry is trusted before it is read again. */
  ttlMs?: number;
  /** Simultaneous manifest reads. Kept small; this is a spinning disk. */
  concurrency?: number;
  /** Injected so the index can be exercised without a filesystem. */
  readManifest?: (titleRoot: string) => Promise<TitlePackageManifest | null>;
  resolveRoot?: (target: PackageIndexTarget) => Promise<string>;
  now?: () => number;
}

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_CONCURRENCY = 4;

export const UNKNOWN_PACKAGE: PackageIndexEntry = {
  state: "unknown",
  summary: null,
  readAt: 0,
};

/**
 * Reads one manifest into the shape the page needs.
 *
 * Exported because the single-title preview answers the same question about
 * one title synchronously, and the two must not drift: an episode row and the
 * card it expands into have to agree about what is on disk.
 */
export function summarisePackage(
  manifest: TitlePackageManifest | null,
  fingerprint: string | null,
): ProcessingPackageSummary | null {
  if (!manifest) return null;
  const sourceMatches =
    fingerprint !== null && manifest.sourceFingerprint === fingerprint;
  const profileMatches = manifest.profileVersion === ADAPTIVE_PROFILE_VERSION;
  const rungs = manifest.video
    .map((rendition) => rendition.qualityHeight)
    .sort((left, right) => right - left);
  /*
   * Judged from the package alone, exactly as the single-title preview judges
   * it: the source that would normally decide which rungs a title should have
   * can be gone by the time anyone asks, so the package's own best rung stands
   * in for it.
   */
  const complete = RENDITION_TARGETS.map((target) => target.qualityHeight)
    .filter((height) => height <= (rungs[0] ?? 0))
    .every((height) => rungs.includes(height));

  return {
    present: true,
    current: sourceMatches && profileMatches,
    sourceMatches,
    profileMatches,
    rungs,
    complete,
    hdr:
      manifest.video.find((rendition) => rendition.hdr !== "sdr")?.hdr ?? "sdr",
    audioTracks: manifest.audio.length,
    subtitleTracks: manifest.subtitle.length,
    totalBytes: manifest.storage.totalBytes,
  };
}

export function packageStateOf(
  summary: ProcessingPackageSummary | null,
): ProcessingPackageState {
  if (!summary) return "none";
  if (!summary.profileMatches) return "stale";
  /*
   * A package whose source has been replaced is stale even if it is otherwise
   * whole: its bytes describe a file that is no longer there. A package whose
   * source is simply *gone* is not stale — `sourceMatches` is false in both
   * cases, so completeness decides between them, which is what keeps a
   * finished title with a deleted source reading as finished.
   */
  return summary.complete ? "complete" : "partial";
}

export interface PackageIndex {
  /** What is known right now. Never waits, never touches the volume. */
  get(mediaFileId: string): PackageIndexEntry;
  /**
   * Declares the set of titles worth knowing about and starts a refresh of
   * whatever in it is missing or stale. Returns immediately.
   */
  track(targets: readonly PackageIndexTarget[]): void;
  /** Reads one title now, bypassing the clock. For a job that just published. */
  refresh(target: PackageIndexTarget): Promise<PackageIndexEntry>;
  /** Forgets a title, so the next read is a fresh one. */
  invalidate(mediaFileId: string): void;
  /** Waits for the current background sweep. Tests only. */
  settle(): Promise<void>;
}

export function createPackageIndex(
  options: PackageIndexOptions = {},
): PackageIndex {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
  const now = options.now ?? (() => Date.now());
  const readManifest = options.readManifest ?? readTitlePackageManifest;
  const resolveRoot =
    options.resolveRoot ??
    ((target: PackageIndexTarget) =>
      resolveTitleRoot(target.sourcePath, titleRootLayoutForKind(target.kind)));

  const entries = new Map<string, PackageIndexEntry>();
  const pending = new Map<string, PackageIndexTarget>();
  const inFlight = new Set<string>();
  let sweep: Promise<void> | null = null;

  async function read(target: PackageIndexTarget): Promise<PackageIndexEntry> {
    let summary: ProcessingPackageSummary | null = null;
    try {
      const titleRoot = await resolveRoot(target);
      summary = summarisePackage(
        await readManifest(titleRoot),
        target.fingerprint,
      );
    } catch {
      /*
       * An unreadable volume is not evidence that a title has no package, and
       * recording "none" for it would tell an operator their library had been
       * emptied. The entry is left as it was, to be read again next sweep.
       */
      return entries.get(target.mediaFileId) ?? UNKNOWN_PACKAGE;
    }
    const entry: PackageIndexEntry = {
      state: packageStateOf(summary),
      summary,
      readAt: now(),
    };
    entries.set(target.mediaFileId, entry);
    return entry;
  }

  async function drain(): Promise<void> {
    while (pending.size > 0) {
      const batch = [...pending.values()].slice(0, concurrency);
      for (const target of batch) {
        pending.delete(target.mediaFileId);
        inFlight.add(target.mediaFileId);
      }
      await Promise.all(
        batch.map(async (target) => {
          try {
            await read(target);
          } finally {
            inFlight.delete(target.mediaFileId);
          }
        }),
      );
    }
  }

  function schedule(): void {
    if (sweep || pending.size === 0) return;
    sweep = drain().finally(() => {
      sweep = null;
      // Anything enqueued while the sweep ran gets its own pass.
      if (pending.size > 0) schedule();
    });
  }

  return {
    get: (mediaFileId) => entries.get(mediaFileId) ?? UNKNOWN_PACKAGE,

    track: (targets) => {
      const cutoff = now() - ttlMs;
      for (const target of targets) {
        if (inFlight.has(target.mediaFileId)) continue;
        const entry = entries.get(target.mediaFileId);
        if (entry && entry.readAt > cutoff) continue;
        pending.set(target.mediaFileId, target);
      }
      schedule();
    },

    refresh: async (target) => {
      pending.delete(target.mediaFileId);
      return read(target);
    },

    invalidate: (mediaFileId) => {
      entries.delete(mediaFileId);
      pending.delete(mediaFileId);
    },

    settle: async () => {
      while (sweep) await sweep;
    },
  };
}
