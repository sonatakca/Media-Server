/**
 * What a file will be called once it is in the library, and where.
 *
 * The layout is the one the repository already uses, not a second one invented
 * here — `Title (Year)/src/Title (Year).mkv` for a film, and
 * `Series/Season 1/src/Series - S01E01 - Episode.mkv` for an episode. `src/` is
 * transparent to the scanner, so a source inside the bucket belongs to the
 * folder above it.
 *
 * The rest of this module is about names a filesystem will actually accept.
 * Windows refuses more than POSIX does, and refuses some of it in ways that
 * look like success — a trailing space is silently dropped, so `Dune ` and
 * `Dune` become the same file — which is why every name is normalised here
 * rather than being handed to the filesystem to see what happens.
 */
import { splitExtension } from "../scanner/nameParser";
import type { ImportFailureClass } from "./importState";

/** The bucket a title's originals live in. Mirrors the scanner's layout. */
export const SOURCE_BUCKET = "src";

/**
 * Everything Windows refuses in a path segment, plus the control range.
 *
 * `:` and `\` are here for a second reason beyond being illegal: they are how
 * a drive-relative path (`C:file`) or a UNC path (`\\server\share`) would be
 * smuggled in through what is supposed to be a single name.
 */
// eslint-disable-next-line no-control-regex -- removing them is the point
const ILLEGAL_SEGMENT_CHARACTERS = /[\u0000-\u001f\u007f/\\:*?"<>|]/g;

/**
 * Names Windows reserves for devices, whatever extension follows them.
 *
 * `CON.mkv` is not a file on Windows; it is the console. The check is against
 * the stem, because the reservation ignores the extension entirely.
 */
const RESERVED_DEVICE_NAMES =
  /^(?:con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])$/i;

/** How long one path segment may be. Comfortably inside every filesystem. */
const MAX_SEGMENT_LENGTH = 180;

/**
 * How long the whole library-relative path may be.
 *
 * Windows' classic limit is 260 characters for the *absolute* path. Node is
 * not bound by it — it passes long paths with the `\\?\` prefix, and on the
 * target host, with `LongPathsEnabled` set to `0`, it wrote a 297-character
 * path without complaint. Ordinary Win32 applications still obey the limit,
 * so a library file written past it is one Explorer, most players and most
 * backup tools cannot open.
 *
 * The ceiling here is therefore what everything *else* can read, not what this
 * process can write. Budgeting the relative part leaves room for a library
 * root without having to know where the library will be.
 */
const MAX_RELATIVE_LENGTH = 200;

export interface DestinationTarget {
  readonly kind: "movie" | "season" | "episode";
  /** The film's title, or the series' title. */
  readonly title: string;
  readonly year?: number;
  readonly season?: number;
  readonly episode?: number;
  readonly episodeTitle?: string;
}

export interface PlannedDestination {
  /** `/`-separated and relative to the library root, on every platform. */
  readonly relative: string;
  /** The identity the database holds a destination by. */
  readonly key: string;
}

export interface DestinationRefusal {
  readonly problem: ImportFailureClass;
  readonly detail: string;
}

export type DestinationOutcome = PlannedDestination | DestinationRefusal;

export function isRefusal(
  outcome: DestinationOutcome,
): outcome is DestinationRefusal {
  return "problem" in outcome;
}

/**
 * One path segment, made safe without being made unrecognisable.
 *
 * Illegal characters are removed rather than substituted, because a title with
 * `?` in it reads better without the character than with an underscore where
 * it was. Trailing dots and spaces go because Windows drops them silently,
 * which would otherwise make two different plans resolve to one file.
 */
export function safeSegment(value: string): string {
  const cleaned = value
    // Compose first: `é` written as `e` plus a combining accent and `é` as one
    // code point are the same name to a person and to most filesystems.
    .normalize("NFC")
    .replace(ILLEGAL_SEGMENT_CHARACTERS, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.\s]+$/, "")
    .slice(0, MAX_SEGMENT_LENGTH)
    .trim()
    .replace(/[.\s]+$/, "");

  if (!cleaned) return "";
  // A reserved device name is kept legible rather than dropped.
  const { stem } = splitExtension(cleaned);
  return RESERVED_DEVICE_NAMES.test(stem) ? `_${cleaned}` : cleaned;
}

/** The extension, lower-cased and stripped of anything a segment may not hold. */
function safeExtension(fileName: string): string {
  const { extension } = splitExtension(fileName);
  const cleaned = extension.replace(ILLEGAL_SEGMENT_CHARACTERS, "").trim();
  return cleaned ? `.${cleaned.toLowerCase()}` : "";
}

function episodeCode(season: number, episode: number): string {
  return `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
}

/**
 * The stem every file of this title shares.
 *
 * One function for the film and the episode because the subtitle beside a
 * media file has to agree with it exactly; deriving the two separately is how
 * they come to disagree.
 */
export function canonicalStem(target: DestinationTarget): string {
  const title = safeSegment(target.title);
  if (!title) return "";

  if (target.kind === "movie") {
    return target.year ? safeSegment(`${title} (${target.year})`) : title;
  }

  if (target.season === undefined) return "";
  if (target.episode === undefined) {
    // A whole season with no episode number of its own has no file stem.
    return "";
  }

  const code = episodeCode(target.season, target.episode);
  const episodeTitle = safeSegment(target.episodeTitle ?? "");
  return safeSegment(
    episodeTitle
      ? `${title} - ${code} - ${episodeTitle}`
      : `${title} - ${code}`,
  );
}

/** The folder that owns the title, relative to the library root. */
export function titleDirectory(target: DestinationTarget): string {
  const title = safeSegment(target.title);
  if (!title) return "";
  if (target.kind === "movie") {
    return target.year ? safeSegment(`${title} (${target.year})`) : title;
  }
  if (target.season === undefined) return "";
  return `${title}/${safeSegment(`Season ${target.season}`)}`;
}

function refuse(detail: string): DestinationRefusal {
  return { problem: "name-unrepresentable", detail };
}

function within(relative: string): DestinationOutcome | undefined {
  if (relative.length > MAX_RELATIVE_LENGTH) {
    return refuse(
      `The destination path is ${relative.length} characters, past the ${MAX_RELATIVE_LENGTH} an import will write.`,
    );
  }
  return undefined;
}

/**
 * Where the feature file goes.
 *
 * The extension comes from the source and everything else from the target, so
 * a badly named download cannot name a library file.
 */
export function planMediaDestination(
  target: DestinationTarget,
  sourceFileName: string,
): DestinationOutcome {
  const directory = titleDirectory(target);
  const stem = canonicalStem(target);
  if (!directory || !stem) {
    return refuse("The target does not supply a name for the library.");
  }
  const extension = safeExtension(sourceFileName);
  if (!extension) {
    return refuse("The source file has no usable extension.");
  }

  const relative = `${directory}/${SOURCE_BUCKET}/${stem}${extension}`;
  return within(relative) ?? { relative, key: "" };
}

/**
 * The language-ish part of a subtitle's name, if it has one.
 *
 * Two shapes are handled because both are common: `Movie.tr.forced.srt` from a
 * subtitle manager, and `2_English.srt` from inside a release's `Subs` folder.
 * Nothing is invented — a subtitle whose name says nothing gets no suffix, and
 * two that say the same thing collide, which the caller is told about rather
 * than silently renamed around.
 */
export function subtitleSuffix(sourceFileName: string): string {
  const { stem } = splitExtension(sourceFileName);
  const dotted = /\.([A-Za-z]{2,3}(?:\.(?:forced|default|sdh|cc|hi))*)$/i.exec(
    stem,
  );
  if (dotted) return dotted[1]!.toLowerCase();

  // `2_English`, `3_Turkish`: the ordinal is the release's, not a fact.
  const numbered = /^\d+[_-]\s*([A-Za-z][A-Za-z ]{1,30})$/.exec(stem.trim());
  if (numbered) return safeSegment(numbered[1]!.trim()).toLowerCase();

  return "";
}

/**
 * Where a subtitle goes: beside its media, sharing its stem.
 *
 * Sharing the stem is what makes a player find it, so the stem is taken from
 * the media plan rather than derived again.
 */
export function planSubtitleDestination(
  target: DestinationTarget,
  sourceFileName: string,
): DestinationOutcome {
  const directory = titleDirectory(target);
  const stem = canonicalStem(target);
  if (!directory || !stem) {
    return refuse("The target does not supply a name for the library.");
  }
  const extension = safeExtension(sourceFileName);
  if (!extension) {
    return refuse("The subtitle has no usable extension.");
  }

  const suffix = subtitleSuffix(sourceFileName);
  const named = suffix ? `${stem}.${suffix}` : stem;
  const relative = `${directory}/${SOURCE_BUCKET}/${named}${extension}`;
  return within(relative) ?? { relative, key: "" };
}

/**
 * The identity a destination is held by, across every import.
 *
 * Case-folded because the library lives on a case-insensitive filesystem,
 * where `Dune.mkv` and `DUNE.MKV` are one file; separators normalised so the
 * same destination reads the same whichever host planned it. The library root
 * is part of the key, because two libraries may legitimately hold the same
 * relative path.
 */
export function destinationKey(libraryRoot: string, relative: string): string {
  const normalised = `${libraryRoot.replace(/[\\/]+$/, "")}/${relative}`
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .normalize("NFC");
  return normalised.toLocaleLowerCase("en-US");
}

/** Fills in the key a planned destination is stored under. */
export function withKey(
  libraryRoot: string,
  outcome: DestinationOutcome,
): DestinationOutcome {
  if (isRefusal(outcome)) return outcome;
  return {
    relative: outcome.relative,
    key: destinationKey(libraryRoot, outcome.relative),
  };
}
