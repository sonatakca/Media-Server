/**
 * What subtitles a video file already has.
 *
 * Two sources answer this, and they are deliberately kept apart rather than
 * merged behind one function:
 *
 *  - **The catalogue** already records both kinds. `media_streams` carries
 *    `is_external` and `external_relative_path`, so a scan that has run knows
 *    about the `.srt` beside the film as well as the track inside it. That is
 *    the fast answer and the one every read path should use.
 *  - **The disk** is the truth. A subtitle somebody dropped in by hand since the
 *    last scan exists whatever the catalogue thinks, and a search that ignored
 *    it would download a translation the library already has.
 *
 * Both produce the same `SubtitleTrack`, so a caller can reconcile them without
 * knowing which came from where. Nothing here writes, probes, or opens a media
 * file: the embedded facts come from a scan that already happened, and the
 * external ones from a directory listing.
 */

import path from "node:path";
import type { readdir } from "node:fs/promises";
import { isTextSubtitleCodec } from "../../../renditions/probe";
import {
  discoverSidecarSubtitles,
  type SidecarSubtitle,
} from "../../../renditions/adaptive/sidecarSubtitles";
import { normalizeLanguage } from "../../../renditions/processing/languages";
import {
  formatFromExtension,
  wantIsSatisfiedBy,
  type SubtitleFormat,
  type SubtitleTrack,
  type SubtitleWant,
} from "./subtitleState";

/** The part of a catalogue stream row this needs. Deliberately structural, so
 * a caller can pass a row from anywhere that records the same facts. */
export interface SubtitleStreamFacts {
  readonly streamIndex: number;
  readonly kind: string;
  readonly codec: string | null;
  readonly language: string | null;
  readonly title: string | null;
  readonly isForced: boolean;
  readonly isExternal: boolean;
  readonly externalRelativePath: string | null;
}

/**
 * Codecs that name a text format precisely enough to call it one.
 *
 * `mov_text` is the MP4 timed-text codec and is SRT in all but name, which is
 * what the packager already turns it into. Anything absent here is left `null`
 * rather than guessed: an embedded track's "format" is a property of the
 * container's codec, not of a file, and inventing one would put a value in a
 * field that later decides a filename.
 */
const CODEC_FORMATS: ReadonlyMap<string, SubtitleFormat> = new Map([
  ["subrip", "srt"],
  ["srt", "srt"],
  ["mov_text", "srt"],
  ["webvtt", "vtt"],
  ["ass", "ass"],
  ["ssa", "ssa"],
]);

/**
 * Whether a track's own title says it is for viewers who cannot hear.
 *
 * The catalogue has no column for this — `media_streams` records `is_forced`
 * and nothing equivalent — so the only evidence an embedded track carries is
 * the free text a muxer wrote. It is matched on word boundaries because `cc`
 * appears inside ordinary words and `sdh` does not appear by accident.
 */
const HEARING_IMPAIRED_TITLE =
  /(^|[^a-z])(sdh|hi|cc|hearing[ -]?impaired|closed[ -]?caption(s|ed)?)([^a-z]|$)/i;

export function titleSuggestsHearingImpaired(title: string | null): boolean {
  if (!title) return false;
  return HEARING_IMPAIRED_TITLE.test(title);
}

/**
 * A library-relative POSIX path, from an absolute one.
 *
 * `path.relative` answers in the host's separator, and on Windows that is `\`.
 * A library-relative path is POSIX everywhere by contract — it is what the
 * catalogue stores and what a macOS deployment wrote — so the conversion is
 * explicit here rather than left to whichever host happens to run the scan.
 * Returns `null` when the file is not under the root at all, which is a
 * containment answer as much as a formatting one.
 */
export function libraryRelativePosix(
  libraryRoot: string,
  absolute: string,
): string | null {
  const relative = path.relative(
    path.resolve(libraryRoot),
    path.resolve(absolute),
  );
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }
  return relative.split(path.sep).join("/");
}

/* ------------------------------------------------- from the catalogue */

export interface TrackFromStreamOptions {
  /**
   * Library-relative POSIX paths this system installed. Everything else is
   * something it found, and the difference decides whether it may be replaced.
   */
  readonly managedPaths?: ReadonlySet<string>;
}

/**
 * One catalogue stream row as a subtitle track, or `null` if it is not one.
 *
 * Image-based tracks are returned rather than dropped. They are real subtitles
 * a viewer may already be watching, and a search that could not see them would
 * decide a film had no Turkish track when it has a Turkish PGS one. What they
 * are not is a *download* target, and `format` being `null` is how that reads
 * downstream.
 */
export function trackFromStream(
  stream: SubtitleStreamFacts,
  options: TrackFromStreamOptions = {},
): SubtitleTrack | null {
  if (stream.kind !== "subtitle") return null;

  const relativePath = stream.isExternal
    ? (stream.externalRelativePath ?? null)
    : null;

  const format = stream.isExternal
    ? relativePath
      ? formatFromExtension(path.posix.extname(relativePath))
      : null
    : isTextSubtitleCodec(stream.codec ?? "")
      ? (CODEC_FORMATS.get((stream.codec ?? "").trim().toLowerCase()) ?? null)
      : null;

  return {
    origin: stream.isExternal ? "external" : "embedded",
    language: normalizeLanguage(stream.language ?? undefined),
    format,
    relativePath,
    streamIndex: stream.isExternal ? null : stream.streamIndex,
    forced: stream.isForced,
    hearingImpaired: titleSuggestsHearingImpaired(stream.title),
    managed: relativePath
      ? (options.managedPaths?.has(relativePath) ?? false)
      : false,
  };
}

export function tracksFromStreams(
  streams: readonly SubtitleStreamFacts[],
  options: TrackFromStreamOptions = {},
): SubtitleTrack[] {
  return streams
    .map((stream) => trackFromStream(stream, options))
    .filter((track): track is SubtitleTrack => track !== null);
}

/* ------------------------------------------------------- from the disk */

export interface DiskDetectionOptions extends TrackFromStreamOptions {
  readonly readDirectory?: typeof readdir;
}

/**
 * The external tracks actually sitting beside a source right now.
 *
 * Delegates the hard part — which files in this directory belong to *this*
 * video — to the discovery the packager already uses, so a season folder holding
 * ten episodes and ten `.tr.srt` files gives each episode its own translation
 * rather than all ten. Reimplementing that rule here would be a second source
 * of truth for it, and the two would drift.
 *
 * `sourceAbsolutePath` must be inside `libraryRoot`; a sidecar that resolves
 * outside is dropped rather than reported, because a path that escapes the
 * root it was authorised against is not a subtitle this system will act on.
 */
export async function detectSubtitlesOnDisk(
  sourceAbsolutePath: string,
  libraryRoot: string,
  options: DiskDetectionOptions = {},
): Promise<SubtitleTrack[]> {
  const sidecars: SidecarSubtitle[] = await discoverSidecarSubtitles(
    sourceAbsolutePath,
    options.readDirectory ? { readDirectory: options.readDirectory } : {},
  );

  const tracks: SubtitleTrack[] = [];
  for (const sidecar of sidecars) {
    const relativePath = libraryRelativePosix(libraryRoot, sidecar.filePath);
    if (relativePath === null) continue;
    tracks.push({
      origin: "external",
      language: sidecar.language,
      format: formatFromExtension(path.extname(sidecar.fileName)),
      relativePath,
      streamIndex: null,
      forced: sidecar.isForced,
      hearingImpaired: sidecar.isHearingImpaired,
      managed: options.managedPaths?.has(relativePath) ?? false,
    });
  }
  return tracks;
}

/* ------------------------------------------------------- reconciliation */

/**
 * The two views of one file, combined without double-counting.
 *
 * An external track is identified by its path, so a `.srt` the catalogue knows
 * about and the same `.srt` on disk are one track — and the disk's reading of
 * it wins, because it was taken now. An embedded track only ever comes from the
 * catalogue, since reading it again would mean opening the media.
 */
export function reconcileTracks(
  fromCatalogue: readonly SubtitleTrack[],
  fromDisk: readonly SubtitleTrack[],
): SubtitleTrack[] {
  const byPath = new Map<string, SubtitleTrack>();
  const embedded: SubtitleTrack[] = [];

  for (const track of fromCatalogue) {
    if (track.origin === "embedded") embedded.push(track);
    else if (track.relativePath) byPath.set(track.relativePath, track);
  }
  for (const track of fromDisk) {
    if (track.relativePath) byPath.set(track.relativePath, track);
  }
  return [...embedded, ...byPath.values()];
}

/**
 * The wants nothing on this file answers yet.
 *
 * Order is preserved, because it is the order somebody wrote their languages
 * in and that is the order they should be searched for.
 */
export function missingWants(
  wants: readonly SubtitleWant[],
  tracks: readonly SubtitleTrack[],
): SubtitleWant[] {
  return wants.filter(
    (want) => !tracks.some((track) => wantIsSatisfiedBy(want, track)),
  );
}
