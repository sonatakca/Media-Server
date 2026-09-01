import {
  serializeNfo,
  type NfoActor,
  type NfoAudioStream,
  type NfoDocument,
  type NfoStreamDetails,
  type NfoSubtitleStream,
  type NfoUniqueId,
  type NfoVideoStream,
} from "./nfoSerializer";
import { resolveTitleRoot } from "../metadata/titleRoot";
import type {
  NfoFileRow,
  NfoGenreRow,
  NfoItemBundle,
  NfoPersonRow,
  NfoStreamRow,
} from "./nfoRepository";

/**
 * Turns catalogue rows into the exact files an export should produce.
 *
 * Pure, and separate from both the database and the writer, because the two
 * questions this answers — "what goes in the file" and "where does the file
 * go" — are the two that a person actually needs to check before letting
 * anything near their media volume. Both are testable here with plain objects.
 */

export type NfoSkipReason =
  | "unsupported-kind"
  | "no-title-root"
  | "no-primary-file"
  | "no-season-directory";

export interface NfoPlannedFile {
  /** POSIX, relative to whichever root the writer is configured for. */
  relativePath: string;
  xml: string;
}

export interface NfoPlan {
  itemId: string;
  kind: string;
  files: NfoPlannedFile[];
  /** Present when nothing could be planned; `files` is then empty. */
  skipped?: NfoSkipReason;
}

/** Kinds that own an .nfo. Books, collections and trailers do not. */
const EXPORTABLE_KINDS = new Set(["movie", "series", "season", "episode"]);

export function isExportableKind(kind: string): boolean {
  return EXPORTABLE_KINDS.has(kind);
}

function directoryOf(relativePath: string): string {
  const index = relativePath.lastIndexOf("/");
  return index === -1 ? "" : relativePath.slice(0, index);
}

function stemOf(relativePath: string): string {
  const name = relativePath.slice(relativePath.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? name : name.slice(0, dot);
}

function joinRelative(directory: string, name: string): string {
  return directory ? `${directory}/${name}` : name;
}

/** `YYYY-MM-DD` in UTC, or undefined for an absent or unusable date. */
function isoDate(value: Date | null | undefined): string | undefined {
  if (!value) return undefined;
  const time = value.getTime();
  if (!Number.isFinite(time)) return undefined;
  return new Date(time).toISOString().slice(0, 10);
}

function runtimeMinutes(runtimeMs: string | null): number | undefined {
  if (runtimeMs === null) return undefined;
  const milliseconds = Number(runtimeMs);
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return undefined;
  const minutes = Math.round(milliseconds / 60_000);
  return minutes > 0 ? minutes : undefined;
}

/**
 * Provider identifiers in a fixed order, TMDB first and marked default.
 *
 * `provider_ids` is a jsonb object, and object key order out of the driver is
 * not something to build byte-identical output on, so the known providers are
 * listed explicitly and anything else is appended alphabetically.
 */
function uniqueIds(providerIds: Record<string, string>): NfoUniqueId[] {
  const known = ["tmdb", "imdb", "tvdb"];
  const ids: NfoUniqueId[] = [];

  for (const type of known) {
    const value = providerIds[type];
    if (typeof value === "string" && value.trim().length > 0) {
      ids.push({
        type,
        value: value.trim(),
        ...(type === "tmdb" ? { isDefault: true } : {}),
      });
    }
  }

  for (const type of Object.keys(providerIds).sort()) {
    if (known.includes(type)) continue;
    const value = providerIds[type];
    if (typeof value === "string" && value.trim().length > 0) {
      ids.push({ type, value: value.trim() });
    }
  }

  // Nothing else can be the default when TMDB is absent: Kodi treats the first
  // identifier as primary anyway, and claiming a default for a provider we did
  // not match on would be an invention.
  return ids;
}

function sortedPeople(people: NfoPersonRow[], role: string): NfoPersonRow[] {
  return people
    .filter((person) => person.role === role)
    .sort(
      (left, right) =>
        left.sortOrder - right.sortOrder || left.name.localeCompare(right.name),
    );
}

function actors(people: NfoPersonRow[]): NfoActor[] {
  return sortedPeople(people, "actor").map((person, index) => ({
    name: person.name,
    ...(person.characterName ? { character: person.characterName } : {}),
    order: index,
    ...(person.providerIds.tmdb ? { providerId: person.providerIds.tmdb } : {}),
  }));
}

function genreNames(genres: NfoGenreRow[]): string[] {
  return genres
    .slice()
    .sort(
      (left, right) =>
        left.sortOrder - right.sortOrder || left.name.localeCompare(right.name),
    )
    .map((genre) => genre.name);
}

function optionalNumber(value: number | null): number | undefined {
  return value === null || !Number.isFinite(value) ? undefined : value;
}

function optionalText(value: string | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Technical detail for one media file.
 *
 * Ordered by stream index so a re-export of an unchanged file produces the same
 * bytes, and external subtitle tracks are included: they are part of what a
 * player will find beside the video, and leaving them out would understate the
 * languages the title actually has.
 */
function streamDetails(
  file: NfoFileRow,
  streams: NfoStreamRow[],
): NfoStreamDetails | undefined {
  const ordered = streams
    .filter((stream) => stream.mediaFileId === file.id)
    .sort((left, right) => left.streamIndex - right.streamIndex);
  if (ordered.length === 0) return undefined;

  const durationSeconds =
    file.durationMs === null
      ? undefined
      : Math.round(Number(file.durationMs) / 1_000) || undefined;

  const video: NfoVideoStream[] = [];
  const audio: NfoAudioStream[] = [];
  const subtitle: NfoSubtitleStream[] = [];

  for (const stream of ordered) {
    if (stream.kind === "video") {
      const width = optionalNumber(stream.width);
      const height = optionalNumber(stream.height);
      video.push({
        ...(optionalText(stream.codec)
          ? { codec: stream.codec as string }
          : {}),
        ...(optionalText(stream.language)
          ? { language: stream.language as string }
          : {}),
        ...(width === undefined ? {} : { width }),
        ...(height === undefined ? {} : { height }),
        ...(width && height ? { aspect: width / height } : {}),
        ...(durationSeconds === undefined ? {} : { durationSeconds }),
        ...(optionalNumber(stream.bitDepth) === undefined
          ? {}
          : { bitDepth: stream.bitDepth as number }),
        ...(optionalText(stream.videoRange) &&
        stream.videoRange?.toLowerCase() !== "sdr"
          ? { hdrType: (stream.videoRange as string).toLowerCase() }
          : {}),
        isDefault: stream.isDefault,
        isForced: stream.isForced,
      });
      continue;
    }
    if (stream.kind === "audio") {
      audio.push({
        ...(optionalText(stream.codec)
          ? { codec: stream.codec as string }
          : {}),
        ...(optionalText(stream.language)
          ? { language: stream.language as string }
          : {}),
        ...(optionalNumber(stream.channels) === undefined
          ? {}
          : { channels: stream.channels as number }),
        isDefault: stream.isDefault,
        isForced: stream.isForced,
      });
      continue;
    }
    if (stream.kind === "subtitle") {
      subtitle.push({
        ...(optionalText(stream.codec)
          ? { codec: stream.codec as string }
          : {}),
        ...(optionalText(stream.language)
          ? { language: stream.language as string }
          : {}),
        isDefault: stream.isDefault,
        isForced: stream.isForced,
      });
    }
  }

  if (video.length === 0 && audio.length === 0 && subtitle.length === 0) {
    return undefined;
  }
  return { video, audio, subtitle };
}

/** The shared body every root shares, before the per-kind fields. */
function baseDocument(bundle: NfoItemBundle): Omit<NfoDocument, "root"> {
  const { item } = bundle;
  const premiered = isoDate(item.premiereDate);
  const runtime = runtimeMinutes(item.runtimeMs);
  const ids = uniqueIds(item.providerIds);
  const genres = genreNames(bundle.genres);
  const directors = sortedPeople(bundle.people, "director").map(
    (person) => person.name,
  );
  const writers = sortedPeople(bundle.people, "writer").map(
    (person) => person.name,
  );
  const cast = actors(bundle.people);

  return {
    title: item.title,
    ...(item.originalTitle ? { originalTitle: item.originalTitle } : {}),
    ...(item.sortTitle && item.sortTitle !== item.title
      ? { sortTitle: item.sortTitle }
      : {}),
    ...(item.productionYear === null ? {} : { year: item.productionYear }),
    ...(premiered ? { premiered } : {}),
    ...(runtime === undefined ? {} : { runtime }),
    ...(item.officialRating ? { mpaa: item.officialRating } : {}),
    ...(item.communityRating === null ? {} : { rating: item.communityRating }),
    ...(item.tagline ? { tagline: item.tagline } : {}),
    ...(item.overview ? { plot: item.overview } : {}),
    ...(genres.length > 0 ? { genres } : {}),
    ...(ids.length > 0 ? { uniqueIds: ids } : {}),
    ...(directors.length > 0 ? { directors } : {}),
    ...(writers.length > 0 ? { writers } : {}),
    ...(cast.length > 0 ? { actors: cast } : {}),
  };
}

/**
 * The video files an item owns, largest first, deduplicated by path.
 *
 * The scanner records an alternate cut as a second file on the same item, which
 * is what makes a multi-version layout visible here at all.
 */
function videoFiles(bundle: NfoItemBundle): NfoFileRow[] {
  return bundle.files
    .slice()
    .sort(
      (left, right) =>
        Number(right.isPrimary) - Number(left.isPrimary) ||
        left.relativePath.localeCompare(right.relativePath),
    );
}

function movieFiles(bundle: NfoItemBundle, streams: NfoStreamRow[]): NfoPlan {
  const files = videoFiles(bundle);
  // Order matters: with no file there is also no path to read the folder from,
  // and "the file is gone" is the cause worth reporting.
  if (files.length === 0) {
    return {
      itemId: bundle.item.id,
      kind: bundle.item.kind,
      files: [],
      skipped: "no-primary-file",
    };
  }

  const titleRoot = resolveTitleRoot({
    kind: bundle.item.kind,
    sourceKey: bundle.item.sourceKey,
    primaryRelativePath: files[0]?.relativePath ?? null,
  });
  if (!titleRoot) {
    return {
      itemId: bundle.item.id,
      kind: bundle.item.kind,
      files: [],
      skipped: "no-title-root",
    };
  }

  const base = baseDocument(bundle);
  const planned: NfoPlannedFile[] = [];
  const seen = new Set<string>();

  const push = (relativePath: string, file: NfoFileRow): void => {
    if (seen.has(relativePath)) return;
    seen.add(relativePath);
    const details = streamDetails(file, streams);
    planned.push({
      relativePath,
      xml: serializeNfo({
        root: "movie",
        ...base,
        ...(details ? { streamDetails: details } : {}),
      }),
    });
  };

  // The folder-level file, which is what Kodi and Jellyfin look for first. Its
  // technical detail describes the primary version.
  push(joinRelative(titleRoot, "movie.nfo"), files[0] as NfoFileRow);

  /*
   * A second cut is not a duplicate of the first, and one movie.nfo cannot
   * describe both: their resolutions, codecs and audio layouts are exactly what
   * differs. Each additional version therefore gets a file named after it, which
   * is also the layout Kodi documents for several versions in one folder.
   */
  if (files.length > 1) {
    for (const file of files) {
      push(
        joinRelative(
          directoryOf(file.relativePath),
          `${stemOf(file.relativePath)}.nfo`,
        ),
        file,
      );
    }
  }

  return { itemId: bundle.item.id, kind: bundle.item.kind, files: planned };
}

function seriesFiles(bundle: NfoItemBundle): NfoPlan {
  const titleRoot = resolveTitleRoot({
    kind: bundle.item.kind,
    sourceKey: bundle.item.sourceKey,
    primaryRelativePath: bundle.files[0]?.relativePath ?? null,
    descendantRelativePath: bundle.descendantRelativePath ?? null,
  });
  if (!titleRoot) {
    return {
      itemId: bundle.item.id,
      kind: bundle.item.kind,
      files: [],
      skipped: "no-title-root",
    };
  }

  const { item } = bundle;
  return {
    itemId: item.id,
    kind: item.kind,
    files: [
      {
        relativePath: joinRelative(titleRoot, "tvshow.nfo"),
        xml: serializeNfo({
          root: "tvshow",
          ...baseDocument(bundle),
          ...(isoDate(item.endDate) ? { endDate: isoDate(item.endDate) } : {}),
        }),
      },
    ],
  };
}

/**
 * Where a season's own file belongs.
 *
 * A season has no path of its own — its `source_key` is derived from the series
 * key and a number, not from a folder — so the directory can only come from the
 * episodes inside it. When the episodes sit directly in the series folder there
 * is no season folder to write into, and a `season.nfo` there would claim to
 * describe whichever season happened to be exported last. That case is skipped
 * rather than guessed.
 */
function seasonDirectory(bundle: NfoItemBundle): string | undefined {
  const directories = new Set(bundle.seasonEpisodeDirectories ?? []);
  if (directories.size !== 1) return undefined;
  const [directory] = [...directories];
  if (!directory) return undefined;

  const seriesRoot = bundle.seriesTitleRoot;
  if (seriesRoot && directory.toLowerCase() === seriesRoot.toLowerCase()) {
    return undefined;
  }
  return directory;
}

function seasonFiles(bundle: NfoItemBundle): NfoPlan {
  const directory = seasonDirectory(bundle);
  if (directory === undefined) {
    return {
      itemId: bundle.item.id,
      kind: bundle.item.kind,
      files: [],
      skipped: "no-season-directory",
    };
  }

  const { item } = bundle;
  const base = baseDocument(bundle);
  return {
    itemId: item.id,
    kind: item.kind,
    files: [
      {
        relativePath: joinRelative(directory, "season.nfo"),
        xml: serializeNfo({
          root: "season",
          ...base,
          ...(item.indexNumber === null
            ? {}
            : { seasonNumber: item.indexNumber }),
        }),
      },
    ],
  };
}

function episodeFiles(bundle: NfoItemBundle, streams: NfoStreamRow[]): NfoPlan {
  const files = videoFiles(bundle);
  if (files.length === 0) {
    return {
      itemId: bundle.item.id,
      kind: bundle.item.kind,
      files: [],
      skipped: "no-primary-file",
    };
  }

  const { item } = bundle;
  const base = baseDocument(bundle);
  const aired = isoDate(item.premiereDate);
  const planned: NfoPlannedFile[] = [];
  const seen = new Set<string>();

  /*
   * An episode's file is named after its video, so an alternate cut already has
   * a distinct name and each version simply gets its own sidecar. There is no
   * folder-level equivalent of movie.nfo here.
   */
  for (const file of files) {
    const relativePath = joinRelative(
      directoryOf(file.relativePath),
      `${stemOf(file.relativePath)}.nfo`,
    );
    if (seen.has(relativePath)) continue;
    seen.add(relativePath);

    const details = streamDetails(file, streams);
    planned.push({
      relativePath,
      xml: serializeNfo({
        root: "episodedetails",
        ...base,
        // An episode dates from when it aired; `premiered` belongs to the show.
        premiered: undefined,
        ...(aired ? { aired } : {}),
        ...(bundle.seriesTitle ? { showTitle: bundle.seriesTitle } : {}),
        ...(item.parentIndexNumber === null
          ? {}
          : { season: item.parentIndexNumber }),
        ...(item.indexNumber === null ? {} : { episode: item.indexNumber }),
        ...(details ? { streamDetails: details } : {}),
      }),
    });
  }

  return { itemId: item.id, kind: item.kind, files: planned };
}

/** Everything one catalogue item should produce. */
export function planNfoFiles(bundle: NfoItemBundle): NfoPlan {
  const { item } = bundle;
  switch (item.kind) {
    case "movie":
      return movieFiles(bundle, bundle.streams);
    case "series":
      return seriesFiles(bundle);
    case "season":
      return seasonFiles(bundle);
    case "episode":
      return episodeFiles(bundle, bundle.streams);
    default:
      return {
        itemId: item.id,
        kind: item.kind,
        files: [],
        skipped: "unsupported-kind",
      };
  }
}
