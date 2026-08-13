/**
 * Media-playlist parsing and master-playlist generation.
 *
 * The parser exists because two very different consumers need to agree about
 * what a packaged playlist claims: the validator, which checks those claims
 * against the bytes on disk, and the delivery route, which must never serve a
 * range the playlist did not describe. A single parser means a playlist cannot
 * be read permissively in one place and strictly in the other.
 *
 * The master generator exists because FFmpeg's own master is close but not
 * sufficient — it has no `FRAME-RATE`, no `VIDEO-RANGE`, and its `BANDWIDTH`
 * figures come from encoder hints rather than the bytes that were actually
 * written. The `CODECS` strings are the one thing it derives from the real
 * bitstream, so those are carried across verbatim.
 */

import { ADAPTIVE_AUDIO_GROUP } from "./encoding";
import type {
  AdaptiveAudioRenditionMetadata,
  AdaptiveVideoRenditionMetadata,
} from "./metadata";

export interface PlaylistByteRange {
  length: number;
  offset: number;
}

export interface PlaylistSegment {
  durationSeconds: number;
  uri: string;
  byteRange: PlaylistByteRange;
}

export interface ParsedMediaPlaylist {
  version: number;
  targetDuration: number;
  independentSegments: boolean;
  playlistType?: string;
  map: { uri: string; byteRange: PlaylistByteRange };
  segments: PlaylistSegment[];
  hasEndList: boolean;
  totalDurationSeconds: number;
}

function parseByteRange(
  value: string,
  previousEnd: number,
): PlaylistByteRange | null {
  const match = /^(\d+)(?:@(\d+))?$/.exec(value.trim());
  if (!match) return null;
  const length = Number(match[1]);
  const offset = match[2] === undefined ? previousEnd : Number(match[2]);
  if (
    !Number.isSafeInteger(length) ||
    length <= 0 ||
    !Number.isSafeInteger(offset) ||
    offset < 0
  ) {
    return null;
  }
  return { length, offset };
}

/**
 * Parses a VOD media playlist.
 *
 * Rejects anything it does not fully understand rather than skipping it. A tag
 * this does not know about in a packaged playlist means the packager and the
 * reader disagree about the format, and continuing would validate a package
 * whose real structure nothing has inspected.
 */
export function parseMediaPlaylist(text: string): ParsedMediaPlaylist {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "#EXTM3U") {
    throw new Error("Media playlist does not start with #EXTM3U.");
  }

  let version = 0;
  let targetDuration = 0;
  let independentSegments = false;
  let playlistType: string | undefined;
  let map: ParsedMediaPlaylist["map"] | undefined;
  let hasEndList = false;
  const segments: PlaylistSegment[] = [];

  let pendingDuration: number | undefined;
  let pendingRange: PlaylistByteRange | undefined;
  let previousEnd = 0;

  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line === "") continue;

    if (!line.startsWith("#")) {
      if (pendingDuration === undefined) {
        throw new Error(`Segment URI at line ${index + 1} has no #EXTINF.`);
      }
      if (!pendingRange) {
        throw new Error(
          `Segment URI at line ${index + 1} has no #EXT-X-BYTERANGE; single-file packaging requires one.`,
        );
      }
      segments.push({
        durationSeconds: pendingDuration,
        uri: line,
        byteRange: pendingRange,
      });
      previousEnd = pendingRange.offset + pendingRange.length;
      pendingDuration = undefined;
      pendingRange = undefined;
      continue;
    }

    const separator = line.indexOf(":");
    const tag = separator === -1 ? line : line.slice(0, separator);
    const value = separator === -1 ? "" : line.slice(separator + 1);

    switch (tag) {
      case "#EXT-X-VERSION":
        version = Number(value);
        if (!Number.isInteger(version) || version < 1) {
          throw new Error("#EXT-X-VERSION is not a positive integer.");
        }
        break;
      case "#EXT-X-TARGETDURATION":
        targetDuration = Number(value);
        if (!Number.isFinite(targetDuration) || targetDuration <= 0) {
          throw new Error("#EXT-X-TARGETDURATION is not a positive number.");
        }
        break;
      case "#EXT-X-INDEPENDENT-SEGMENTS":
        independentSegments = true;
        break;
      case "#EXT-X-PLAYLIST-TYPE":
        playlistType = value.trim();
        break;
      case "#EXT-X-MEDIA-SEQUENCE":
      case "#EXT-X-DISCONTINUITY-SEQUENCE":
        break;
      case "#EXT-X-MAP": {
        const uriMatch = /URI="([^"]+)"/.exec(value);
        const rangeMatch = /BYTERANGE="?([^",]+)"?/.exec(value);
        if (!uriMatch || !rangeMatch) {
          throw new Error("#EXT-X-MAP must carry both URI and BYTERANGE.");
        }
        const range = parseByteRange(rangeMatch[1], 0);
        if (!range) throw new Error("#EXT-X-MAP BYTERANGE is malformed.");
        map = { uri: uriMatch[1], byteRange: range };
        previousEnd = range.offset + range.length;
        break;
      }
      case "#EXTINF": {
        const duration = Number(value.split(",")[0]);
        if (!Number.isFinite(duration) || duration <= 0) {
          throw new Error(
            `#EXTINF at line ${index + 1} is not a positive duration.`,
          );
        }
        pendingDuration = duration;
        break;
      }
      case "#EXT-X-BYTERANGE": {
        const range = parseByteRange(value, previousEnd);
        if (!range) {
          throw new Error(
            `#EXT-X-BYTERANGE at line ${index + 1} is malformed.`,
          );
        }
        pendingRange = range;
        break;
      }
      case "#EXT-X-ENDLIST":
        hasEndList = true;
        break;
      case "#EXT-X-DISCONTINUITY":
        throw new Error(
          "A packaged adaptive playlist must not contain #EXT-X-DISCONTINUITY.",
        );
      default:
        throw new Error(`Unsupported playlist tag ${tag}.`);
    }
  }

  if (!map) throw new Error("Media playlist has no #EXT-X-MAP initialization.");
  if (segments.length === 0) throw new Error("Media playlist has no segments.");
  if (!hasEndList)
    throw new Error("Media playlist is not terminated by #EXT-X-ENDLIST.");

  return {
    version,
    targetDuration,
    independentSegments,
    ...(playlistType === undefined ? {} : { playlistType }),
    map,
    segments,
    hasEndList,
    totalDurationSeconds: segments.reduce(
      (total, segment) => total + segment.durationSeconds,
      0,
    ),
  };
}

/**
 * Codec strings FFmpeg derived from the real bitstream, keyed by the rendition
 * directory name it wrote them against.
 */
export function parseCodecsFromGeneratedMaster(
  text: string,
): Map<string, string> {
  const byPath = new Map<string, string>();
  const lines = text.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line.startsWith("#EXT-X-STREAM-INF:")) continue;
    const codecs = /CODECS="([^"]+)"/.exec(line)?.[1];
    let uri: string | undefined;
    for (let next = index + 1; next < lines.length; next += 1) {
      const candidate = lines[next].trim();
      if (candidate === "") continue;
      if (candidate.startsWith("#")) break;
      uri = candidate;
      break;
    }
    if (codecs && uri) byPath.set(uri, codecs);
  }

  return byPath;
}

function escapeAttribute(value: string): string {
  // Quoted-string attribute values may contain neither a double quote nor a
  // line break. Titles come from source metadata, so they are untrusted input
  // to a format that has no escape sequence for either.
  return value
    .replace(/[\r\n"]/g, " ")
    .trim()
    .slice(0, 120);
}

function videoRangeFor(rendition: AdaptiveVideoRenditionMetadata): string {
  if (rendition.hdr === "hdr10") return "PQ";
  if (rendition.hdr === "hlg") return "HLG";
  return "SDR";
}

export interface MasterPlaylistInput {
  videoRenditions: AdaptiveVideoRenditionMetadata[];
  audioRenditions: AdaptiveAudioRenditionMetadata[];
  /** RFC 6381 video codec string per rendition id, from the real bitstream. */
  videoCodecStrings: Map<string, string>;
  audioCodecStrings: Map<string, string>;
}

/**
 * Builds the master playlist that ships.
 *
 * Bandwidth figures are measured: `BANDWIDTH` is the peak segment rate and
 * `AVERAGE-BANDWIDTH` the mean across the rendition, both with the default
 * audio rendition folded in, because a variant's advertised bandwidth is what a
 * player has to fetch to play it — and that includes the audio it is paired
 * with. Advertising the video rate alone makes every rung look cheaper than it
 * is and is exactly how an ABR ladder settles one rung too high and stalls.
 */
export function buildMasterPlaylist({
  videoRenditions,
  audioRenditions,
  videoCodecStrings,
  audioCodecStrings,
}: MasterPlaylistInput): string {
  if (videoRenditions.length === 0) {
    throw new Error("A master playlist needs at least one video rendition.");
  }
  if (audioRenditions.length === 0) {
    throw new Error("A master playlist needs at least one audio rendition.");
  }

  const defaultAudio =
    audioRenditions.find((rendition) => rendition.isDefault) ??
    audioRenditions[0];
  const defaultAudioCodec = audioCodecStrings.get(defaultAudio.id);
  if (!defaultAudioCodec) {
    throw new Error(
      `No codec string was measured for audio rendition ${defaultAudio.id}.`,
    );
  }

  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:7",
    "#EXT-X-INDEPENDENT-SEGMENTS",
    "",
  ];

  for (const audio of audioRenditions) {
    const attributes = [
      "TYPE=AUDIO",
      `GROUP-ID="${ADAPTIVE_AUDIO_GROUP}"`,
      `NAME="${escapeAttribute(audio.title ?? audio.language ?? audio.id)}"`,
      ...(audio.language
        ? [`LANGUAGE="${escapeAttribute(audio.language)}"`]
        : []),
      `DEFAULT=${audio.isDefault ? "YES" : "NO"}`,
      `AUTOSELECT=${audio.isDefault ? "YES" : "NO"}`,
      ...(audio.isForced ? ["FORCED=YES"] : []),
      `CHANNELS="${audio.channels}"`,
      `URI="${audio.playlistPath}"`,
    ];
    lines.push(`#EXT-X-MEDIA:${attributes.join(",")}`);
  }

  lines.push("");

  const ordered = [...videoRenditions].sort(
    (left, right) => left.averageBitrate - right.averageBitrate,
  );

  for (const video of ordered) {
    const videoCodec = videoCodecStrings.get(video.id);
    if (!videoCodec) {
      throw new Error(
        `No codec string was measured for video rendition ${video.id}.`,
      );
    }
    const attributes = [
      `BANDWIDTH=${Math.round(video.peakBitrate + defaultAudio.averageBitrate)}`,
      `AVERAGE-BANDWIDTH=${Math.round(
        video.averageBitrate + defaultAudio.averageBitrate,
      )}`,
      `RESOLUTION=${video.width}x${video.height}`,
      `FRAME-RATE=${video.frameRate.toFixed(3)}`,
      `CODECS="${videoCodec},${defaultAudioCodec}"`,
      `VIDEO-RANGE=${videoRangeFor(video)}`,
      `AUDIO="${ADAPTIVE_AUDIO_GROUP}"`,
    ];
    lines.push(`#EXT-X-STREAM-INF:${attributes.join(",")}`);
    lines.push(video.playlistPath);
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export interface ParsedMasterVariant {
  uri: string;
  bandwidth: number;
  averageBandwidth?: number;
  resolution?: { width: number; height: number };
  frameRate?: number;
  codecs: string;
  videoRange?: string;
  audioGroup?: string;
}

export interface ParsedMasterPlaylist {
  independentSegments: boolean;
  variants: ParsedMasterVariant[];
  audioRenditions: Array<{
    groupId: string;
    name: string;
    language?: string;
    isDefault: boolean;
    uri: string;
  }>;
}

function attributeValue(attributes: string, key: string): string | undefined {
  const quoted = new RegExp(`(?:^|,)${key}="([^"]*)"`).exec(attributes);
  if (quoted) return quoted[1];
  const bare = new RegExp(`(?:^|,)${key}=([^,]*)`).exec(attributes);
  return bare?.[1];
}

export function parseMasterPlaylist(text: string): ParsedMasterPlaylist {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "#EXTM3U") {
    throw new Error("Master playlist does not start with #EXTM3U.");
  }

  let independentSegments = false;
  const variants: ParsedMasterVariant[] = [];
  const audioRenditions: ParsedMasterPlaylist["audioRenditions"] = [];

  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line === "") continue;

    if (line === "#EXT-X-INDEPENDENT-SEGMENTS") {
      independentSegments = true;
      continue;
    }

    if (line.startsWith("#EXT-X-MEDIA:")) {
      const attributes = line.slice("#EXT-X-MEDIA:".length);
      if (attributeValue(attributes, "TYPE") !== "AUDIO") continue;
      const groupId = attributeValue(attributes, "GROUP-ID");
      const uri = attributeValue(attributes, "URI");
      if (!groupId || !uri) {
        throw new Error("#EXT-X-MEDIA is missing GROUP-ID or URI.");
      }
      const language = attributeValue(attributes, "LANGUAGE");
      audioRenditions.push({
        groupId,
        name: attributeValue(attributes, "NAME") ?? "",
        ...(language ? { language } : {}),
        isDefault: attributeValue(attributes, "DEFAULT") === "YES",
        uri,
      });
      continue;
    }

    if (line.startsWith("#EXT-X-STREAM-INF:")) {
      const attributes = line.slice("#EXT-X-STREAM-INF:".length);
      let uri: string | undefined;
      for (let next = index + 1; next < lines.length; next += 1) {
        const candidate = lines[next].trim();
        if (candidate === "") continue;
        if (candidate.startsWith("#")) break;
        uri = candidate;
        break;
      }
      if (!uri) throw new Error("#EXT-X-STREAM-INF has no variant URI.");

      const bandwidth = Number(attributeValue(attributes, "BANDWIDTH"));
      const codecs = attributeValue(attributes, "CODECS");
      if (!Number.isFinite(bandwidth) || bandwidth <= 0 || !codecs) {
        throw new Error(
          "#EXT-X-STREAM-INF needs a positive BANDWIDTH and CODECS.",
        );
      }
      const resolution = attributeValue(attributes, "RESOLUTION");
      const resolutionMatch = resolution
        ? /^(\d+)x(\d+)$/.exec(resolution)
        : null;
      const averageBandwidth = Number(
        attributeValue(attributes, "AVERAGE-BANDWIDTH"),
      );
      const frameRate = Number(attributeValue(attributes, "FRAME-RATE"));
      const videoRange = attributeValue(attributes, "VIDEO-RANGE");
      const audioGroup = attributeValue(attributes, "AUDIO");

      variants.push({
        uri,
        bandwidth,
        ...(Number.isFinite(averageBandwidth) && averageBandwidth > 0
          ? { averageBandwidth }
          : {}),
        ...(resolutionMatch
          ? {
              resolution: {
                width: Number(resolutionMatch[1]),
                height: Number(resolutionMatch[2]),
              },
            }
          : {}),
        ...(Number.isFinite(frameRate) && frameRate > 0 ? { frameRate } : {}),
        codecs,
        ...(videoRange ? { videoRange } : {}),
        ...(audioGroup ? { audioGroup } : {}),
      });
    }
  }

  if (variants.length === 0) {
    throw new Error("Master playlist contains no variants.");
  }

  return { independentSegments, variants, audioRenditions };
}
