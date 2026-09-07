import { TITLE_SOURCE_DIRECTORY } from "../../../renditions/adaptive/layout";
import type { ScanDirectoryEntry } from "./libraryScan";
import type { OrganizeMove, OrganizerReadFileSystem } from "./organizeLibrary";
import {
  isIgnoredEntry,
  isSubtitleFile,
  parseEpisodeName,
  parseSubtitleSuffix,
  splitExtension,
} from "./nameParser";

/**
 * Giving a source file the name the rest of the library already uses.
 *
 * This is the *other half* of `organizeLibrary.ts`, kept apart from it on
 * purpose. Organising changes which folder a file lives in; renaming changes
 * only its basename, inside the folder it is already in. Running them as one
 * operation would make either button do the other's work, and a person who
 * asked for a tidy filename would find their folders rearranged.
 *
 * The two shapes here are the ones the repository already documents — the
 * movie folder that names its own source, and the episode line the organiser's
 * own example is written in:
 *
 * ```
 * Gladiator (2000)/src/Gladiator (2000).mkv
 * Season 1/src/House of the Dragon - S01E01 - The Heirs of the Dragon.mp4
 * ```
 *
 * Nothing else is invented. Where the catalogue does not already know the
 * facts a canonical name is built from, the file is skipped and reported
 * rather than guessed at, and the same is true of every case where renaming
 * would change what the scanner reads the file as.
 *
 * Three properties make this safe to point at somebody's media volume:
 *
 * 1. **No identity changes.** A rename is only planned when the item's source
 *    key does not contain the basename — a movie whose folder is its identity,
 *    an episode identified by its season and episode number. The proposed name
 *    is then re-parsed and must yield the same numbers it started with.
 * 2. **Nothing is overwritten.** Destinations are checked case-insensitively
 *    against the directory and against the plan itself, and the executor
 *    refuses again at the filesystem.
 * 3. **Extensions and sidecar suffixes survive verbatim.** `.tr.forced.srt`
 *    stays `.tr.forced.srt`; only the stem in front of it changes.
 */

export type RenameSkipReason =
  /** The basename is part of the item's source key; renaming would re-identify it. */
  | "identity-derived-from-name"
  /** Alternate cuts: which file is which edition is not a fact we hold. */
  | "multiple-files"
  /** Unmatched or partially identified — a canonical name cannot be derived. */
  | "insufficient-facts"
  /** The proposed name no longer parses to the season and episode it came from. */
  | "reparse-mismatch"
  /** Differs only in case; not safely expressible on a case-insensitive volume. */
  | "case-only"
  | "destination-occupied"
  | "unreadable";

export interface RenameSkip {
  relativePath: string;
  reason: RenameSkipReason;
}

export interface RenamePlan {
  moves: OrganizeMove[];
  /** Always empty: a rename never creates a directory. Kept so the plan can be
   * handed straight to `applyOrganizationPlan`. */
  directories: string[];
  skipped: RenameSkip[];
}

/**
 * One title, as the catalogue already knows it.
 *
 * Every field is a persisted fact. Nothing here is re-derived from the
 * filename being replaced, because a name that is about to be corrected is the
 * one source that must not be trusted.
 */
export interface RenameCandidate {
  itemId: string;
  /** The scanner's identity for the item; what the safety check is made of. */
  sourceKey: string;
  kind: "movie" | "episode";
  title: string;
  seriesTitle: string | null;
  seasonNumber: number | null;
  indexNumber: number | null;
  /** The canonical playable file, relative to the media root. */
  relativePath: string;
  /** Playable files the catalogue holds for this item, this one included. */
  fileCount: number;
}

export interface PlanLibraryRenameOptions {
  fileSystem: OrganizerReadFileSystem;
  candidates: RenameCandidate[];
}

/** The parser's placeholder for an episode whose own name is unknown. */
const PLACEHOLDER_EPISODE_TITLE = /^episode\s+\d+$/i;

/** Characters a filename may not carry on the platforms this server runs on. */
// eslint-disable-next-line no-control-regex
const ILLEGAL_FILENAME_CHARACTERS = /[\u0000-\u001f\u007f/\\:*?"<>|]/g;

function directoryOf(relativePath: string): string {
  const cut = relativePath.lastIndexOf("/");
  return cut <= 0 ? "" : relativePath.slice(0, cut);
}

function joinRelative(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

/**
 * The folder that owns the title, which is the one the scanner keys a movie by.
 *
 * `src/` is transparent to the scanner, so a source inside the bucket belongs
 * to the folder above it.
 */
function titleDirectoryOf(relativePath: string): string {
  const directory = directoryOf(relativePath);
  const last = directory.split("/").pop()?.toLowerCase();
  return last === TITLE_SOURCE_DIRECTORY ? directoryOf(directory) : directory;
}

/** Trims a proposed stem to something a filesystem will accept, or nothing. */
function sanitizeStem(value: string): string {
  return value
    .replace(ILLEGAL_FILENAME_CHARACTERS, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.\s]+$/, "")
    .slice(0, 180)
    .trim();
}

function episodeCodeFor(season: number, episode: number): string {
  return `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
}

/**
 * Whether renaming this file would change what the scanner reads it as.
 *
 * A movie loose in a container folder is keyed by `<folder>/<stem>`, so its
 * basename *is* its identity and a rename would retire the catalogue row and
 * create a new one — losing the probe, the processing history and every queued
 * job attached to it. An episode with no parsed number is keyed by its path
 * for the same reason.
 */
function identityDependsOnName(candidate: RenameCandidate): boolean {
  const path = candidate.relativePath.toLowerCase();
  if (candidate.kind === "movie") {
    const { stem } = splitExtension(
      candidate.relativePath.split("/").pop() ?? "",
    );
    const containerKey = `movie:${joinRelative(
      titleDirectoryOf(candidate.relativePath),
      stem,
    ).toLowerCase()}`;
    return candidate.sourceKey.toLowerCase() === containerKey;
  }
  if (candidate.indexNumber === null || candidate.seasonNumber === null) {
    return true;
  }
  return candidate.sourceKey.toLowerCase().endsWith(`:${path}`);
}

/** The canonical stem for one title, or null when the facts do not supply one. */
export function canonicalStemFor(candidate: RenameCandidate): string | null {
  if (candidate.kind === "movie") {
    // The folder already carries the agreed `Title (Year)` shape; the source
    // takes its name rather than a second, independently-derived one.
    const folder = titleDirectoryOf(candidate.relativePath).split("/").pop();
    const stem = sanitizeStem(folder ?? "");
    return stem || null;
  }

  const series = sanitizeStem(candidate.seriesTitle ?? "");
  if (
    !series ||
    candidate.seasonNumber === null ||
    candidate.indexNumber === null
  ) {
    return null;
  }

  const code = episodeCodeFor(candidate.seasonNumber, candidate.indexNumber);
  const episodeTitle = sanitizeStem(candidate.title ?? "");
  const useTitle =
    episodeTitle.length > 0 && !PLACEHOLDER_EPISODE_TITLE.test(episodeTitle);
  const stem = sanitizeStem(
    useTitle ? `${series} - ${code} - ${episodeTitle}` : `${series} - ${code}`,
  );
  return stem || null;
}

/**
 * Confirms the proposed name still says what the old one did.
 *
 * The identity check above is an argument; this is the measurement. Re-parsing
 * the name the scanner would read means a rename can only be planned when the
 * scanner will place the file exactly where it already is.
 */
function reparsesToSameEpisode(
  candidate: RenameCandidate,
  stem: string,
): boolean {
  if (candidate.kind !== "episode") return true;
  const parsed = parseEpisodeName(stem, {
    ...(candidate.seasonNumber === null
      ? {}
      : { folderSeasonNumber: candidate.seasonNumber }),
  });
  return (
    parsed.episodeNumber === candidate.indexNumber &&
    (parsed.seasonNumber ?? null) === candidate.seasonNumber &&
    parsed.endEpisodeNumber === undefined
  );
}

class RenamePlanBuilder {
  readonly moves: OrganizeMove[] = [];
  readonly skipped: RenameSkip[] = [];
  /** Destinations this plan already claims, so two files cannot collide. */
  private readonly claimed = new Set<string>();
  private readonly listings = new Map<string, ScanDirectoryEntry[] | null>();

  constructor(private readonly fs: OrganizerReadFileSystem) {}

  /** A directory's entries, read once and cached for the whole pass. */
  async entriesIn(directory: string): Promise<ScanDirectoryEntry[] | null> {
    if (this.listings.has(directory)) {
      return this.listings.get(directory) ?? null;
    }
    const entries = await this.fs.readDirectory(directory).catch(() => null);
    this.listings.set(directory, entries);
    return entries;
  }

  async rename(
    directory: string,
    fromName: string,
    toName: string,
    reason: OrganizeMove["reason"],
  ): Promise<void> {
    if (fromName === toName) return;
    const from = joinRelative(directory, fromName);
    const to = joinRelative(directory, toName);

    if (fromName.toLowerCase() === toName.toLowerCase()) {
      // A case-only rename is a two-step dance on a case-insensitive volume
      // and this planner will not do it in one atomic move, so it is reported
      // rather than attempted.
      this.skipped.push({ relativePath: from, reason: "case-only" });
      return;
    }

    const entries = await this.entriesIn(directory);
    if (entries === null) {
      this.skipped.push({ relativePath: from, reason: "unreadable" });
      return;
    }
    const taken = new Set(entries.map((entry) => entry.name.toLowerCase()));
    if (taken.has(toName.toLowerCase()) || this.claimed.has(to.toLowerCase())) {
      this.skipped.push({ relativePath: from, reason: "destination-occupied" });
      return;
    }

    this.claimed.add(to.toLowerCase());
    this.moves.push({ from, to, reason });
  }
}

/**
 * What renaming these titles' sources would do, without doing any of it.
 *
 * Planning is separated from applying for the same reason the organiser
 * separates them: the list of names a media volume is about to be given is the
 * thing worth reading first, and it is what the `plan` configuration mode
 * exists to show.
 */
export async function planLibraryRename({
  fileSystem,
  candidates,
}: PlanLibraryRenameOptions): Promise<RenamePlan> {
  const plan = new RenamePlanBuilder(fileSystem);

  for (const candidate of candidates) {
    const name = candidate.relativePath.split("/").pop();
    if (!name) continue;
    const directory = directoryOf(candidate.relativePath);
    const { stem, extension } = splitExtension(name);

    if (candidate.fileCount > 1) {
      // Two cuts of one title share a catalogue row. Which of them is the
      // extended edition is not a fact we hold, and a canonical name would
      // erase the marker that says so.
      plan.skipped.push({
        relativePath: candidate.relativePath,
        reason: "multiple-files",
      });
      continue;
    }
    if (identityDependsOnName(candidate)) {
      plan.skipped.push({
        relativePath: candidate.relativePath,
        reason: "identity-derived-from-name",
      });
      continue;
    }

    const canonical = canonicalStemFor(candidate);
    if (canonical === null) {
      plan.skipped.push({
        relativePath: candidate.relativePath,
        reason: "insufficient-facts",
      });
      continue;
    }
    if (canonical === stem) continue;
    if (!reparsesToSameEpisode(candidate, canonical)) {
      plan.skipped.push({
        relativePath: candidate.relativePath,
        reason: "reparse-mismatch",
      });
      continue;
    }

    await plan.rename(
      directory,
      name,
      extension ? `${canonical}.${extension}` : canonical,
      "rename",
    );

    // The subtitles that belong to this source follow its stem, keeping the
    // language, forced and default suffixes exactly as they were.
    for (const entry of (await plan.entriesIn(directory)) ?? []) {
      if (entry.isDirectory || isIgnoredEntry(entry.name)) continue;
      if (!isSubtitleFile(entry.name)) continue;
      const sidecar = splitExtension(entry.name);
      const parsed = parseSubtitleSuffix(sidecar.stem);
      if (parsed.baseStem.toLowerCase() !== stem.toLowerCase()) continue;
      const suffix = sidecar.stem.slice(parsed.baseStem.length);
      await plan.rename(
        directory,
        entry.name,
        `${canonical}${suffix}.${sidecar.extension}`,
        "sidecar",
      );
    }
  }

  return {
    moves: [...plan.moves].sort(
      (left, right) =>
        left.to.localeCompare(right.to) || left.from.localeCompare(right.from),
    ),
    directories: [],
    skipped: plan.skipped,
  };
}
