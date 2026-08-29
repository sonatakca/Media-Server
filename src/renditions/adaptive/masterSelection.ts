/**
 * Server-side selection inside a generated adaptive master playlist.
 *
 * Chrome runs the package through hls.js, which exposes level and audio-track
 * APIs, so a manual quality lock or an audio change is a JavaScript call on a
 * live instance. Safari plays the same package with its native HLS engine,
 * which exposes neither: `video.audioTracks` is empty for an HLS rendition
 * group, and there is no level API at all.
 *
 * The manifest is the only control surface both engines honour. Rewriting it
 * per request lets Safari be given a playlist that advertises exactly the
 * rendition the viewer picked, instead of the click being dropped.
 *
 * The rewrite is textual and deliberately narrow: it filters `EXT-X-STREAM-INF`
 * pairs and re-stamps `DEFAULT`/`AUTOSELECT` on `EXT-X-MEDIA` audio rows.
 * Nothing else in the playlist is touched, and the media playlist URIs stay
 * relative so they still resolve against the master's own path.
 */

export interface AdaptiveMasterSelection {
  /** Advertise only this exact rendition height. */
  height?: number;
  /** Advertise every rendition at or below this height. */
  maxHeight?: number;
  /** Mark this source audio stream's rendition as the default one. */
  audioStreamIndex?: number;
}

const STREAM_INF = "#EXT-X-STREAM-INF:";
const MEDIA = "#EXT-X-MEDIA:";

function resolutionHeight(streamInfLine: string): number | undefined {
  const match = /RESOLUTION=(\d+)x(\d+)/.exec(streamInfLine);
  const height = match?.[2] ? Number(match[2]) : NaN;
  return Number.isFinite(height) && height > 0 ? height : undefined;
}

/**
 * A rendition's own class, which is what the client asks for.
 *
 * A 1080p rung encoded from a 2.39:1 source is 1920x802, so the advertised
 * `RESOLUTION` height is 802 and never equals the requested 1080. The rung
 * directory in the URI carries the class the ladder was built from, so that is
 * what a request is matched against, with the pixel height as the fallback for
 * a playlist whose URIs are shaped differently.
 */
function renditionHeight(
  streamInfLine: string,
  uriLine: string,
): number | undefined {
  const named = /(?:^|\/)(\d{2,4})p(?:60)?(?:(?:%20| )HDR)?(?:\.m3u8|\/)/i.exec(
    uriLine,
  );
  if (named?.[1]) return Number(named[1]);
  return resolutionHeight(streamInfLine);
}

function isAudioMedia(line: string): boolean {
  return line.startsWith(MEDIA) && /TYPE=AUDIO/.test(line);
}

function audioRenditionStreamIndex(line: string): number | undefined {
  const match =
    /X-SEYIRLIK-STREAM-INDEX=(\d{1,5})(?:,|$)/.exec(line) ??
    /URI="[^"]*\/track-(\d{1,5})\//.exec(line);
  const index = match?.[1] ? Number(match[1]) : NaN;
  return Number.isFinite(index) ? index : undefined;
}

function setAudioDefault(line: string, isDefault: boolean): string {
  return line
    .replace(/DEFAULT=(?:YES|NO)/, `DEFAULT=${isDefault ? "YES" : "NO"}`)
    .replace(/AUTOSELECT=(?:YES|NO)/, `AUTOSELECT=${isDefault ? "YES" : "NO"}`);
}

interface Variant {
  streamInf: string;
  uri: string;
  height: number | undefined;
}

/**
 * Heights the request is allowed to see, honouring an exact lock first.
 *
 * An exact height that the ladder does not carry resolves down to the nearest
 * rung below it rather than emptying the playlist, matching how the client
 * resolves a saved manual height against a different title. A request that
 * nothing satisfies keeps every rung: an empty master is unplayable, and a
 * silently unplayable stream is worse than an unhonoured cap.
 */
export function selectVariantHeights(
  available: readonly number[],
  selection: AdaptiveMasterSelection,
): number[] {
  const heights = [...new Set(available)].sort((left, right) => right - left);
  if (heights.length === 0) return [];

  if (selection.height !== undefined) {
    const exact = heights.find((height) => height === selection.height);
    if (exact !== undefined) return [exact];
    const below = heights.find((height) => height < selection.height!);
    if (below !== undefined) return [below];
    return [heights[heights.length - 1]!];
  }

  if (selection.maxHeight !== undefined) {
    const capped = heights.filter((height) => height <= selection.maxHeight!);
    if (capped.length > 0) return capped;
    return [heights[heights.length - 1]!];
  }

  return heights;
}

export function applyAdaptiveMasterSelection(
  playlist: string,
  selection: AdaptiveMasterSelection,
): string {
  if (
    selection.height === undefined &&
    selection.maxHeight === undefined &&
    selection.audioStreamIndex === undefined
  ) {
    return playlist;
  }

  const lines = playlist.split(/\r?\n/);
  const variants: Variant[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (!line.startsWith(STREAM_INF)) continue;
    let uriIndex = index + 1;
    while (uriIndex < lines.length && (lines[uriIndex] ?? "").trim() === "") {
      uriIndex += 1;
    }
    const uri = (lines[uriIndex] ?? "").trim();
    if (!uri || uri.startsWith("#")) continue;
    variants.push({ streamInf: line, uri, height: renditionHeight(line, uri) });
  }

  const allowed = new Set(
    selectVariantHeights(
      variants
        .map((variant) => variant.height)
        .filter((height): height is number => height !== undefined),
      selection,
    ),
  );

  const audioIndices = lines
    .filter(isAudioMedia)
    .map(audioRenditionStreamIndex)
    .filter((index): index is number => index !== undefined);
  // An audio request naming a rendition this package does not carry leaves the
  // package's own default in place rather than producing a playlist with no
  // default audio at all.
  const selectedAudio =
    selection.audioStreamIndex !== undefined &&
    audioIndices.includes(selection.audioStreamIndex)
      ? selection.audioStreamIndex
      : undefined;

  const output: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";

    if (isAudioMedia(line) && selectedAudio !== undefined) {
      output.push(
        setAudioDefault(
          line,
          audioRenditionStreamIndex(line) === selectedAudio,
        ),
      );
      continue;
    }

    if (line.startsWith(STREAM_INF)) {
      const variant = variants.find(
        (candidate) => candidate.streamInf === line && candidate.uri,
      );
      const keep = variant?.height === undefined || allowed.has(variant.height);
      if (keep) {
        output.push(line);
        continue;
      }
      // Skip the tag, any blank lines between it and its URI, and the URI.
      let skipIndex = index + 1;
      while (
        skipIndex < lines.length &&
        (lines[skipIndex] ?? "").trim() === ""
      ) {
        skipIndex += 1;
      }
      index = skipIndex;
      continue;
    }

    output.push(line);
  }

  return output.join("\n");
}

/** Parses the selection a playback URL is asking the master playlist for. */
export function parseAdaptiveMasterSelection(
  searchParams: URLSearchParams,
): AdaptiveMasterSelection {
  const read = (name: string): number | undefined => {
    const raw = searchParams.get(name);
    if (raw === null) return undefined;
    const value = Number(raw);
    return Number.isInteger(value) && value > 0 && value <= 100_000
      ? value
      : undefined;
  };

  return {
    ...(read("height") !== undefined ? { height: read("height")! } : {}),
    ...(read("maxHeight") !== undefined
      ? { maxHeight: read("maxHeight")! }
      : {}),
    ...(read("audioStreamIndex") !== undefined
      ? { audioStreamIndex: read("audioStreamIndex")! }
      : {}),
  };
}
