/**
 * Kodi/Jellyfin-compatible NFO serialization.
 *
 * Pure: no filesystem, no database, no clock. The same document always produces
 * the same bytes, which is what lets the exporter tell "nothing changed" from
 * "this needs rewriting" by comparing bytes rather than by keeping a shadow
 * copy of every field in the catalogue.
 *
 * Everything here is deliberately conservative about absence. A field that is
 * unknown is omitted rather than emitted empty, because a consumer that reads
 * `<tagline></tagline>` cannot tell "no tagline" from "the tagline is blank",
 * and an empty element is how a good scrape gets overwritten with nothing.
 */

/**
 * The string that marks a file as ours.
 *
 * Written as an XML comment above the root element, where Kodi, Jellyfin and
 * every other consumer ignores it. Overwrite protection is a substring search
 * for exactly this text: a file that does not contain it was written by
 * something else and is never replaced without an explicit force.
 *
 * It carries no version, timestamp or hostname on purpose — anything varying
 * would break byte-identical output for unchanged metadata.
 */
export const NFO_MANAGED_MARKER = "Seyirlik nfo-export";

export const NFO_GENERATOR_COMMENT =
  `<!-- ${NFO_MANAGED_MARKER} v1. This file is managed by Seyirlik; ` +
  `local edits are replaced on the next export. -->`;

const XML_DECLARATION =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

export type NfoRootName = "movie" | "tvshow" | "season" | "episodedetails";

export interface NfoUniqueId {
  /** `tmdb`, `imdb`, `tvdb`, … */
  type: string;
  value: string;
  /** Exactly one identifier may be the default. */
  isDefault?: boolean;
}

export interface NfoActor {
  name: string;
  character?: string;
  /** Billing order; emitted as `<order>`. */
  order?: number;
  providerId?: string;
}

export interface NfoVideoStream {
  codec?: string;
  language?: string;
  width?: number;
  height?: number;
  aspect?: number;
  durationSeconds?: number;
  bitDepth?: number;
  /** `hdr10`, `dovi`, … as recorded by the probe. */
  hdrType?: string;
  isDefault: boolean;
  isForced: boolean;
}

export interface NfoAudioStream {
  codec?: string;
  language?: string;
  channels?: number;
  isDefault: boolean;
  isForced: boolean;
}

export interface NfoSubtitleStream {
  codec?: string;
  language?: string;
  isDefault: boolean;
  isForced: boolean;
}

export interface NfoStreamDetails {
  video: NfoVideoStream[];
  audio: NfoAudioStream[];
  subtitle: NfoSubtitleStream[];
}

/**
 * Everything a single .nfo file can say.
 *
 * One shape covers all four roots rather than four unions: the fields a root
 * does not use are simply left undefined, and the writer's fixed field order
 * skips them. That keeps "which element comes first" in one place instead of
 * four, which is what makes the output stable across kinds.
 */
export interface NfoDocument {
  root: NfoRootName;
  title?: string;
  originalTitle?: string;
  sortTitle?: string;
  /** Episodes only. */
  showTitle?: string;
  /** Episodes: the season they belong to. */
  season?: number;
  /** Episodes: the episode number. */
  episode?: number;
  /** Seasons only. */
  seasonNumber?: number;
  year?: number;
  /** `YYYY-MM-DD`. */
  premiered?: string;
  /** `YYYY-MM-DD`; episodes use `aired` rather than `premiered`. */
  aired?: string;
  /** `YYYY-MM-DD`; a series that has finished. */
  endDate?: string;
  /** Whole minutes. */
  runtime?: number;
  rating?: number;
  mpaa?: string;
  plot?: string;
  tagline?: string;
  genres?: string[];
  uniqueIds?: NfoUniqueId[];
  directors?: string[];
  writers?: string[];
  actors?: NfoActor[];
  streamDetails?: NfoStreamDetails;
}

interface XmlElement {
  name: string;
  attributes: Array<[string, string]>;
  text?: string;
  children: XmlElement[];
}

/**
 * Characters XML 1.0 cannot represent at all.
 *
 * Control characters and lone surrogates have no escape: a document containing
 * one is not merely ugly, it fails to parse. They are dropped rather than
 * replaced so that the same input keeps producing the same output.
 */
const INVALID_XML_CHARACTERS =
  // The tab/newline/carriage-return escapes below are exactly the control
  // characters XML does allow; the class exists to strip the rest.
  // eslint-disable-next-line no-control-regex
  /[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu;

/**
 * Escapes the five predefined entities and normalises line endings.
 *
 * Apostrophe and quote are escaped in text as well as in attributes. It is not
 * required there, but it means one function serves both positions and no caller
 * can pick the wrong one.
 */
export function escapeXml(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(INVALID_XML_CHARACTERS, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function element(
  name: string,
  text: string,
  attributes: Array<[string, string]> = [],
): XmlElement {
  return { name, attributes, text, children: [] };
}

function container(name: string, children: XmlElement[]): XmlElement {
  return { name, attributes: [], children };
}

function render(node: XmlElement, depth: number, lines: string[]): void {
  const indent = "  ".repeat(depth);
  const attributes = node.attributes
    .map(([key, value]) => ` ${key}="${escapeXml(value)}"`)
    .join("");

  if (node.children.length > 0) {
    lines.push(`${indent}<${node.name}${attributes}>`);
    for (const child of node.children) render(child, depth + 1, lines);
    lines.push(`${indent}</${node.name}>`);
    return;
  }

  lines.push(
    `${indent}<${node.name}${attributes}>${escapeXml(node.text ?? "")}</${node.name}>`,
  );
}

/** Trims and drops anything that is only whitespace, so blanks never emit. */
function text(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function optional(
  name: string,
  value: string | null | undefined,
): XmlElement[] {
  const cleaned = text(value);
  return cleaned === undefined ? [] : [element(name, cleaned)];
}

function optionalInteger(
  name: string,
  value: number | null | undefined,
): XmlElement[] {
  if (typeof value !== "number" || !Number.isFinite(value)) return [];
  return [element(name, String(Math.trunc(value)))];
}

/**
 * A rating is rendered at one decimal place.
 *
 * `real` columns round-trip differently depending on how they are read, and
 * `7.8000001` versus `7.8` would make an unchanged title look rewritten on
 * every export.
 */
function optionalRating(
  name: string,
  value: number | null | undefined,
): XmlElement[] {
  if (typeof value !== "number" || !Number.isFinite(value)) return [];
  return [element(name, value.toFixed(1))];
}

function optionalDecimal(
  name: string,
  value: number | null | undefined,
  digits: number,
): XmlElement[] {
  if (typeof value !== "number" || !Number.isFinite(value)) return [];
  return [element(name, value.toFixed(digits))];
}

function booleanElement(name: string, value: boolean): XmlElement {
  return element(name, value ? "true" : "false");
}

function uniqueIdElements(ids: NfoUniqueId[] | undefined): XmlElement[] {
  if (!ids || ids.length === 0) return [];

  const nodes: XmlElement[] = [];
  for (const id of ids) {
    const type = text(id.type);
    const value = text(id.value);
    if (!type || !value) continue;
    nodes.push(
      element(
        "uniqueid",
        value,
        id.isDefault
          ? [
              ["type", type],
              ["default", "true"],
            ]
          : [["type", type]],
      ),
    );
  }
  return nodes;
}

/**
 * The pre-`uniqueid` identifier elements.
 *
 * Jellyfin reads `<tmdbid>`, `<imdbid>` and `<tvdbid>`; Kodi reads `<uniqueid>`.
 * Both are written because the whole point of the export is that either program
 * can pick the library up, and neither element costs anything to emit.
 */
function legacyIdElements(ids: NfoUniqueId[] | undefined): XmlElement[] {
  if (!ids) return [];
  const nodes: XmlElement[] = [];
  for (const legacy of ["tmdb", "imdb", "tvdb"] as const) {
    const match = ids.find((id) => id.type === legacy);
    const value = match ? text(match.value) : undefined;
    if (value) nodes.push(element(`${legacy}id`, value));
  }
  return nodes;
}

function actorElements(actors: NfoActor[] | undefined): XmlElement[] {
  if (!actors) return [];

  const nodes: XmlElement[] = [];
  for (const actor of actors) {
    const name = text(actor.name);
    if (!name) continue;
    nodes.push(
      container("actor", [
        element("name", name),
        ...optional("role", actor.character),
        ...optionalInteger("order", actor.order),
        ...(text(actor.providerId)
          ? [
              element("tmdbid", text(actor.providerId) as string),
              element("uniqueid", text(actor.providerId) as string, [
                ["type", "tmdb"],
              ]),
            ]
          : []),
      ]),
    );
  }
  return nodes;
}

function videoElement(stream: NfoVideoStream): XmlElement {
  return container("video", [
    ...optional("codec", stream.codec),
    ...optionalDecimal("aspect", stream.aspect, 3),
    ...optionalInteger("width", stream.width),
    ...optionalInteger("height", stream.height),
    ...optionalInteger("durationinseconds", stream.durationSeconds),
    ...optional("language", stream.language),
    ...optionalInteger("bitdepth", stream.bitDepth),
    ...optional("hdrtype", stream.hdrType),
    booleanElement("default", stream.isDefault),
    booleanElement("forced", stream.isForced),
  ]);
}

function audioElement(stream: NfoAudioStream): XmlElement {
  return container("audio", [
    ...optional("codec", stream.codec),
    ...optional("language", stream.language),
    ...optionalInteger("channels", stream.channels),
    booleanElement("default", stream.isDefault),
    booleanElement("forced", stream.isForced),
  ]);
}

function subtitleElement(stream: NfoSubtitleStream): XmlElement {
  return container("subtitle", [
    ...optional("codec", stream.codec),
    ...optional("language", stream.language),
    booleanElement("default", stream.isDefault),
    booleanElement("forced", stream.isForced),
  ]);
}

function fileInfoElements(details: NfoStreamDetails | undefined): XmlElement[] {
  if (!details) return [];
  const streams = [
    ...details.video.map(videoElement),
    ...details.audio.map(audioElement),
    ...details.subtitle.map(subtitleElement),
  ];
  if (streams.length === 0) return [];
  return [container("fileinfo", [container("streamdetails", streams)])];
}

/**
 * The one place element order is decided.
 *
 * A fixed sequence, filtered by what the document actually has, is what makes
 * the output deterministic: two exports of the same catalogue row cannot
 * disagree about ordering, so byte comparison is a sound "did anything change"
 * test.
 */
function documentElements(document: NfoDocument): XmlElement[] {
  return [
    ...optional("title", document.title),
    ...optional("originaltitle", document.originalTitle),
    ...optional("sorttitle", document.sortTitle),
    ...optional("showtitle", document.showTitle),
    ...optionalInteger("season", document.season),
    ...optionalInteger("episode", document.episode),
    ...optionalInteger("seasonnumber", document.seasonNumber),
    ...optionalInteger("year", document.year),
    ...optional("premiered", document.premiered),
    ...optional("aired", document.aired),
    ...optional("enddate", document.endDate),
    ...optionalInteger("runtime", document.runtime),
    ...optional("mpaa", document.mpaa),
    ...optionalRating("rating", document.rating),
    ...optional("tagline", document.tagline),
    ...optional("plot", document.plot),
    ...(document.genres ?? [])
      .map((genre) => text(genre))
      .filter((genre): genre is string => genre !== undefined)
      .map((genre) => element("genre", genre)),
    ...uniqueIdElements(document.uniqueIds),
    ...legacyIdElements(document.uniqueIds),
    ...(document.directors ?? [])
      .map((name) => text(name))
      .filter((name): name is string => name !== undefined)
      .map((name) => element("director", name)),
    ...(document.writers ?? [])
      .map((name) => text(name))
      .filter((name): name is string => name !== undefined)
      // Kodi's element for a writer is `credits`; Jellyfin reads it too.
      .map((name) => element("credits", name)),
    ...actorElements(document.actors),
    ...fileInfoElements(document.streamDetails),
  ];
}

/**
 * Renders a document to the exact bytes that belong on disk.
 *
 * Always ends with a newline, so the file is well-formed for line-based tools
 * and a diff does not show a phantom last-line change.
 */
export function serializeNfo(document: NfoDocument): string {
  const lines = [XML_DECLARATION, NFO_GENERATOR_COMMENT];
  render(container(document.root, documentElements(document)), 0, lines);
  return `${lines.join("\n")}\n`;
}

/** Whether these bytes were written by this exporter. */
export function isManagedNfo(contents: string): boolean {
  return contents.includes(NFO_MANAGED_MARKER);
}
