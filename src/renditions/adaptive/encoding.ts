/**
 * FFmpeg argument construction for an aligned adaptive package.
 *
 * One command produces the whole package: the source is decoded once, split
 * into every video rendition, and muxed alongside the shared audio renditions
 * into single-file byte-range CMAF. Two properties fall out of doing it in one
 * pass rather than one pass per rendition, and both are load-bearing:
 *
 *  - Every video rendition sees identical presentation timestamps, so
 *    `-force_key_frames` lands on the same instants in all of them and the
 *    segment boundaries match to the frame.
 *  - Audio is muxed once and referenced by every video variant, so a three-rung
 *    ladder stores one copy of the audio instead of three.
 *
 * The master playlist FFmpeg writes here is *not* the one that ships. It is
 * harvested for its RFC 6381 `CODECS` strings — which are derived from the real
 * bitstream and are the one part of a master playlist that cannot be guessed
 * safely — and then rewritten with measured bandwidth and the signalling the
 * muxer does not emit.
 */

import {
  buildGopArgs,
  SEGMENT_TARGET_SECONDS,
  type GopEncoderFamily,
} from "../../lib/playback-planner/gopPolicy";
import {
  codecFamilyForEncoder,
  getEncodingPolicy,
  type RenditionHdrSignal,
  type RenditionVideoEncoder,
} from "../encoding";
import {
  ADAPTIVE_AUDIO_DIRECTORY,
  ADAPTIVE_MASTER_PLAYLIST,
  ADAPTIVE_MEDIA_FILE,
  ADAPTIVE_PLAYLIST_FILE,
  ADAPTIVE_VIDEO_DIRECTORY,
  audioRenditionId,
  videoRenditionId,
} from "./profile";

/** Group id the master playlist ties every video variant to. */
export const ADAPTIVE_AUDIO_GROUP = "aud";

export interface AdaptiveVideoOutput {
  /** Standard class (480/720/1080) that selects the rate policy. */
  qualityHeight: number;
  /** Encoded pixel dimensions, preserving the source aspect ratio. */
  width: number;
  height: number;
}

export type AdaptiveAudioAction = "copy" | "transcode";

export interface AdaptiveAudioOutput {
  sourceStreamIndex: number;
  action: AdaptiveAudioAction;
  /** Ignored when the action is `copy`. */
  bitrate: number;
  language?: string;
  title?: string;
  isDefault: boolean;
  isForced: boolean;
}

export interface AdaptivePackageEncodingInput {
  inputPath: string;
  outputRoot: string;
  videoOutputs: AdaptiveVideoOutput[];
  audioOutputs: AdaptiveAudioOutput[];
  encoder?: RenditionVideoEncoder;
  /** Present when the source HDR grade is being carried through. */
  hdr?: RenditionHdrSignal;
  /** Probed source frame rate; drives GOP length. */
  frameRate?: number;
  segmentSeconds?: number;
  preset?: string;
}

function levelFor(qualityHeight: number, family: "h264" | "hevc"): string {
  if (family === "hevc") return qualityHeight >= 1080 ? "4.1" : "4";
  return qualityHeight >= 1080 ? "4.1" : qualityHeight >= 720 ? "3.1" : "3.0";
}

function pixelFormatFor(
  encoder: RenditionVideoEncoder,
  hdr: RenditionHdrSignal | undefined,
): string {
  if (hdr) return encoder === "hevc_qsv" ? "p010le" : "yuv420p10le";
  return encoder === "h264_qsv" || encoder === "hevc_qsv" ? "nv12" : "yuv420p";
}

/**
 * Decode once, scale into every rendition.
 *
 * No tone mapping branch exists here on purpose. An HDR master is packaged as
 * HDR; converting it to SDR is a different product decision with a different
 * ladder, and silently folding it in would mean a title's grade changed because
 * of how it happened to be packaged.
 */
export function buildAdaptiveFilterComplex({
  videoOutputs,
  encoder = "libx264",
  hdr,
}: Pick<
  AdaptivePackageEncodingInput,
  "videoOutputs" | "encoder" | "hdr"
>): string {
  if (videoOutputs.length === 0) {
    throw new Error("At least one adaptive video rendition is required.");
  }

  const pixelFormat = pixelFormatFor(encoder, hdr);
  const chains: string[] = [];
  let head = "0:v:0";

  if (hdr) {
    // The colour properties are stamped onto the frames rather than left to the
    // `-color_*` output options alone. On FFmpeg 8 those options reach the
    // matrix but not the transfer or the primaries, so a PQ rendition tagged
    // only through them comes out claiming an unspecified transfer — and a
    // player then renders a PQ signal as if it were BT.709, which is the washed
    // out picture HDR preservation exists to avoid. `setparams` sets what the
    // encoder reads, so every encoder writes the full VUI.
    chains.push(
      `[${head}]setparams=color_primaries=${hdr.colorPrimaries}:color_trc=${hdr.colorTransfer}:colorspace=${hdr.colorSpace}[tagged]`,
    );
    head = "tagged";
  }

  if (videoOutputs.length > 1) {
    const branches = videoOutputs.map((_, index) => `split${index}`);
    chains.push(
      `[${head}]split=${videoOutputs.length}${branches
        .map((label) => `[${label}]`)
        .join("")}`,
    );
    videoOutputs.forEach((output, index) => {
      chains.push(
        `[${branches[index]}]scale=${output.width}:${output.height}:flags=lanczos,format=${pixelFormat}[out${index}]`,
      );
    });
  } else {
    chains.push(
      `[${head}]scale=${videoOutputs[0].width}:${videoOutputs[0].height}:flags=lanczos,format=${pixelFormat}[out0]`,
    );
  }

  return chains.join(";");
}

function gopEncoderFamily(encoder: RenditionVideoEncoder): GopEncoderFamily {
  return encoder;
}

function videoEncoderArgsFor(
  encoder: RenditionVideoEncoder,
  ordinal: number,
  output: AdaptiveVideoOutput,
  preset: string,
  hdr: RenditionHdrSignal | undefined,
  frameRate: number | undefined,
  segmentSeconds: number,
): string[] {
  const family = codecFamilyForEncoder(encoder);
  const policy = getEncodingPolicy(output.qualityHeight, family);
  const specifier = `v:${ordinal}`;
  const args: string[] = [
    `-c:${specifier}`,
    encoder,
    `-preset:${specifier}`,
    preset,
  ];

  if (encoder === "hevc_qsv") {
    args.push(
      `-profile:${specifier}`,
      hdr ? "main10" : "main",
      `-global_quality:${specifier}`,
      String(policy.globalQuality),
    );
  } else if (encoder === "libx265") {
    args.push(`-crf:${specifier}`, String(policy.crf));
  } else if (encoder === "h264_qsv") {
    args.push(
      `-global_quality:${specifier}`,
      String(policy.globalQuality),
      `-profile:${specifier}`,
      "high",
      `-level:${specifier}`,
      levelFor(output.qualityHeight, family),
    );
  } else {
    args.push(
      `-crf:${specifier}`,
      String(policy.crf),
      `-profile:${specifier}`,
      "high",
      `-level:${specifier}`,
      levelFor(output.qualityHeight, family),
    );
  }

  args.push(
    `-maxrate:${specifier}`,
    String(policy.maxVideoBitrate),
    `-bufsize:${specifier}`,
    String(policy.maxVideoBitrate * 2),
  );

  // Colour has to be written explicitly. An HDR rendition that inherits nothing
  // is tagged as unspecified, and a player then guesses BT.709 for a PQ signal.
  if (hdr) {
    args.push(
      `-color_primaries:${specifier}`,
      hdr.colorPrimaries,
      `-color_trc:${specifier}`,
      hdr.colorTransfer,
      `-colorspace:${specifier}`,
      hdr.colorSpace,
    );
  }

  // The GOP policy is per-stream because `-force_key_frames` without a stream
  // specifier only reaches the first video output, which would leave every
  // other rung of the ladder on the encoder's own cadence.
  for (const argument of buildGopArgs({
    encoder: gopEncoderFamily(encoder),
    frameRate,
    segmentSeconds,
  })) {
    args.push(argument.startsWith("-") ? `${argument}:${specifier}` : argument);
  }

  return args;
}

function audioEncoderArgsFor(
  output: AdaptiveAudioOutput,
  ordinal: number,
): string[] {
  const specifier = `a:${ordinal}`;
  if (output.action === "copy") {
    return [`-c:${specifier}`, "copy"];
  }
  return [
    `-c:${specifier}`,
    "aac",
    `-b:${specifier}`,
    String(output.bitrate),
    `-ar:${specifier}`,
    "48000",
  ];
}

/**
 * `var_stream_map` entry names double as output directory names, because
 * `%v` in the segment and playlist templates expands to them. Naming a video
 * rendition `video/720p` is therefore what puts its two files at
 * `video/720p/media.m4s` and `video/720p/playlist.m3u8`.
 */
export function buildVarStreamMap({
  videoOutputs,
  audioOutputs,
}: Pick<
  AdaptivePackageEncodingInput,
  "videoOutputs" | "audioOutputs"
>): string {
  const entries: string[] = [];

  videoOutputs.forEach((output, index) => {
    entries.push(
      `v:${index},agroup:${ADAPTIVE_AUDIO_GROUP},name:${ADAPTIVE_VIDEO_DIRECTORY}/${videoRenditionId(
        output.qualityHeight,
      )}`,
    );
  });

  audioOutputs.forEach((output, index) => {
    const parts = [
      `a:${index}`,
      `agroup:${ADAPTIVE_AUDIO_GROUP}`,
      `name:${ADAPTIVE_AUDIO_DIRECTORY}/${audioRenditionId(output.sourceStreamIndex)}`,
    ];
    if (output.isDefault) parts.push("default:yes");
    if (output.language) parts.push(`language:${output.language}`);
    entries.push(parts.join(","));
  });

  return entries.join(" ");
}

export function buildAdaptivePackageFfmpegArgs({
  inputPath,
  outputRoot,
  videoOutputs,
  audioOutputs,
  encoder = "libx264",
  hdr,
  frameRate,
  segmentSeconds = SEGMENT_TARGET_SECONDS,
  preset = "medium",
}: AdaptivePackageEncodingInput): string[] {
  if (videoOutputs.length === 0) {
    throw new Error("At least one adaptive video rendition is required.");
  }
  if (audioOutputs.length === 0) {
    throw new Error(
      "An adaptive package requires at least one audio rendition.",
    );
  }
  if (audioOutputs.filter((output) => output.isDefault).length !== 1) {
    throw new Error("Exactly one adaptive audio rendition must be default.");
  }
  if (hdr && codecFamilyForEncoder(encoder) !== "hevc") {
    throw new Error(
      "Preserving HDR requires an HEVC encoder; no browser decodes 10-bit H.264.",
    );
  }

  const args = [
    "-hide_banner",
    "-nostdin",
    "-progress",
    "pipe:1",
    "-nostats",
    "-y",
    "-i",
    inputPath,
    "-filter_complex",
    buildAdaptiveFilterComplex({ videoOutputs, encoder, hdr }),
  ];

  videoOutputs.forEach((_, index) => {
    args.push("-map", `[out${index}]`);
  });
  audioOutputs.forEach((output) => {
    args.push("-map", `0:${output.sourceStreamIndex}`);
  });

  // Video variants carry picture only. A subtitle or data stream riding along
  // would be duplicated into every rung and, worse, would make the variants
  // non-interchangeable to a player switching between them mid-playback.
  args.push("-sn", "-dn");

  videoOutputs.forEach((output, index) => {
    args.push(
      ...videoEncoderArgsFor(
        encoder,
        index,
        output,
        preset,
        hdr,
        frameRate,
        segmentSeconds,
      ),
      // Rotation is applied by the scaler, so the output must not also ask a
      // player to rotate it again.
      `-metadata:s:v:${index}`,
      "rotate=0",
    );
    if (codecFamilyForEncoder(encoder) === "hevc") {
      // Safari refuses `hev1`-tagged media; `hvc1` is required for playback.
      args.push(`-tag:v:${index}`, "hvc1");
    }
  });

  audioOutputs.forEach((output, index) => {
    args.push(...audioEncoderArgsFor(output, index));
    if (output.language) {
      args.push(`-metadata:s:a:${index}`, `language=${output.language}`);
    }
    if (output.title) {
      args.push(`-metadata:s:a:${index}`, `title=${output.title}`);
    }
    args.push(
      `-disposition:a:${index}`,
      [output.isDefault ? "default" : "", output.isForced ? "forced" : ""]
        .filter(Boolean)
        .join("+") || "0",
    );
  });

  args.push(
    "-max_muxing_queue_size",
    "4096",
    "-f",
    "hls",
    "-hls_time",
    String(segmentSeconds),
    "-hls_playlist_type",
    "vod",
    "-hls_list_size",
    "0",
    "-hls_segment_type",
    "fmp4",
    // `single_file` is what keeps a 345-hour library from becoming a million
    // small files: one media file per rendition, addressed by byte range.
    "-hls_flags",
    "single_file+independent_segments",
    "-var_stream_map",
    buildVarStreamMap({ videoOutputs, audioOutputs }),
    "-master_pl_name",
    ADAPTIVE_MASTER_PLAYLIST,
    "-hls_segment_filename",
    `${outputRoot}/%v/${ADAPTIVE_MEDIA_FILE}`,
    `${outputRoot}/%v/${ADAPTIVE_PLAYLIST_FILE}`,
  );

  return args;
}

/**
 * Directories the muxer expects to already exist.
 *
 * The HLS muxer opens `<name>/media.m4s` directly and fails if the directory is
 * missing, so the packager creates them before the encode rather than after a
 * confusing "No such file or directory" from inside FFmpeg.
 */
export function adaptiveOutputDirectories({
  videoOutputs,
  audioOutputs,
}: Pick<
  AdaptivePackageEncodingInput,
  "videoOutputs" | "audioOutputs"
>): string[] {
  return [
    ...videoOutputs.map(
      (output) =>
        `${ADAPTIVE_VIDEO_DIRECTORY}/${videoRenditionId(output.qualityHeight)}`,
    ),
    ...audioOutputs.map(
      (output) =>
        `${ADAPTIVE_AUDIO_DIRECTORY}/${audioRenditionId(output.sourceStreamIndex)}`,
    ),
  ];
}

/**
 * Whether a source audio stream can be carried through without re-encoding.
 *
 * Stream copy is only safe when the result is something every target browser
 * decodes from an fMP4 segment. AAC-LC at a standard sample rate with a normal
 * channel layout qualifies; HE-AAC does not, because its implicit signalling
 * survives the remux badly and Chromium then plays it at half rate.
 */
export function canStreamCopyAudio(track: {
  codec: string;
  profile?: string;
  sampleRate?: number;
  channels?: number;
}): boolean {
  if (track.codec.toLowerCase() !== "aac") return false;
  const profile = track.profile?.toLowerCase() ?? "lc";
  if (!profile.includes("lc") || profile.includes("he")) return false;
  if (
    track.sampleRate !== undefined &&
    ![44_100, 48_000].includes(track.sampleRate)
  ) {
    return false;
  }
  if (
    track.channels !== undefined &&
    (track.channels < 1 || track.channels > 2)
  ) {
    // Multichannel AAC is re-encoded to a stereo-safe layout rather than copied,
    // because a 5.1 AAC track copied into fMP4 is decoded by fewer browsers than
    // the ladder is offered to.
    return false;
  }
  return true;
}
