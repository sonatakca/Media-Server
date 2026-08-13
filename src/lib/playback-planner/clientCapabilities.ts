import { randomUuid } from "../randomId";
import type {
  AudioCapability,
  ClientCapabilities,
  CodecCapability,
} from "./types";

interface VideoProbe {
  key: keyof ClientCapabilities["video"];
  mimeType: string;
  width: number;
  height: number;
  bitrate: number;
  framerate: number;
  bitDepth: 8 | 10;
  hdr?: boolean;
}

interface AudioProbe {
  key: keyof ClientCapabilities["audio"];
  mimeType: string;
  channels: number;
  bitrate: number;
  samplerate: number;
}

const DEVICE_ID_STORAGE_KEY = "seyirlik.clientCapabilities.deviceId.v1";

const VIDEO_PROBES: VideoProbe[] = [
  {
    key: "h264",
    mimeType: 'video/mp4; codecs="avc1.640028, mp4a.40.2"',
    width: 1920,
    height: 1080,
    bitrate: 8_000_000,
    framerate: 30,
    bitDepth: 8,
  },
  {
    key: "h264",
    mimeType: 'video/mp4; codecs="avc1.640033, mp4a.40.2"',
    width: 3840,
    height: 2160,
    bitrate: 35_000_000,
    framerate: 60,
    bitDepth: 8,
  },
  {
    // High 10 carries 10-bit and HDR H.264 masters. Without this probe a client
    // that can decode them is still told it cannot, so every such original is
    // classed as needing FFmpeg and never offered as a playable quality.
    key: "h264",
    mimeType: 'video/mp4; codecs="avc1.6E0034, mp4a.40.2"',
    width: 3840,
    height: 2160,
    bitrate: 40_000_000,
    framerate: 60,
    bitDepth: 10,
    hdr: true,
  },
  {
    key: "hevc",
    mimeType: 'video/mp4; codecs="hvc1.1.6.L120.B0, mp4a.40.2"',
    width: 1920,
    height: 1080,
    bitrate: 12_000_000,
    framerate: 30,
    bitDepth: 8,
  },
  {
    key: "hevc",
    mimeType: 'video/mp4; codecs="hvc1.2.4.L153.B0, mp4a.40.2"',
    width: 3840,
    height: 2160,
    bitrate: 40_000_000,
    framerate: 60,
    bitDepth: 10,
    hdr: true,
  },
  {
    key: "av1",
    mimeType: 'video/mp4; codecs="av01.0.08M.08, mp4a.40.2"',
    width: 1920,
    height: 1080,
    bitrate: 8_000_000,
    framerate: 30,
    bitDepth: 8,
  },
  {
    key: "vp9",
    mimeType: 'video/webm; codecs="vp09.00.10.08, opus"',
    width: 1920,
    height: 1080,
    bitrate: 8_000_000,
    framerate: 30,
    bitDepth: 8,
  },
];

const AUDIO_PROBES: AudioProbe[] = [
  {
    key: "aac",
    mimeType: 'audio/mp4; codecs="mp4a.40.2"',
    channels: 2,
    bitrate: 192_000,
    samplerate: 48_000,
  },
  {
    key: "mp3",
    mimeType: 'audio/mpeg; codecs="mp3"',
    channels: 2,
    bitrate: 192_000,
    samplerate: 48_000,
  },
  {
    key: "opus",
    mimeType: 'audio/webm; codecs="opus"',
    channels: 2,
    bitrate: 160_000,
    samplerate: 48_000,
  },
  {
    key: "ac3",
    mimeType: 'audio/mp4; codecs="ac-3"',
    channels: 6,
    bitrate: 640_000,
    samplerate: 48_000,
  },
  {
    key: "eac3",
    mimeType: 'audio/mp4; codecs="ec-3"',
    channels: 6,
    bitrate: 768_000,
    samplerate: 48_000,
  },
  {
    key: "flac",
    mimeType: 'audio/flac; codecs="flac"',
    channels: 2,
    bitrate: 1_000_000,
    samplerate: 48_000,
  },
];

function getOrCreateDeviceId(): string | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }

  try {
    const existing = window.localStorage.getItem(DEVICE_ID_STORAGE_KEY);

    if (existing) {
      return existing;
    }

    const next = randomUuid();

    window.localStorage.setItem(DEVICE_ID_STORAGE_KEY, next);
    return next;
  } catch {
    return undefined;
  }
}

function canPlayType(element: HTMLMediaElement, mimeType: string): boolean {
  const result = element.canPlayType(mimeType);
  return result === "probably" || result === "maybe";
}

function isMseTypeSupported(mimeType: string): boolean {
  return (
    typeof MediaSource !== "undefined" &&
    typeof MediaSource.isTypeSupported === "function" &&
    MediaSource.isTypeSupported(mimeType)
  );
}

/** Codec identifiers that name a video track rather than an audio one. */
const VIDEO_CODEC_PREFIXES =
  /^(avc1|avc3|hvc1|hev1|av01|vp09|vp08|vp9|vp8|dvh1|dvhe)/i;

/**
 * The same content type with any audio codec removed.
 *
 * `decodingInfo`'s `video` member takes a content type naming exactly one video
 * codec. Chrome enforces that and answers `supported: false` for a type that
 * also names an audio codec — for *every* codec, including plain H.264. Since
 * `decodingInfo` is treated as authoritative below, that reported Chrome as
 * unable to decode anything at all, and the server's `canDecodeRendition`
 * filter then withheld every pre-generated rendition: the quality picker showed
 * the original and nothing else. Safari is lenient about the combined type,
 * which is exactly why the ladder appeared there and not in Chrome.
 *
 * Audio is probed separately by `probeAudioCapability`, so nothing is lost by
 * asking the video question on its own.
 */
export function videoOnlyContentType(mimeType: string): string {
  const codecs = /codecs="([^"]+)"/.exec(mimeType);
  if (!codecs) return mimeType;

  const videoCodecs = codecs[1]
    .split(",")
    .map((codec) => codec.trim())
    .filter((codec) => VIDEO_CODEC_PREFIXES.test(codec));

  // A type naming no recognisable video codec is left alone rather than
  // rewritten into something meaningless.
  if (videoCodecs.length === 0) return mimeType;

  return mimeType.replace(
    /codecs="[^"]+"/,
    `codecs="${videoCodecs.join(", ")}"`,
  );
}

/**
 * One probe answered two ways.
 *
 * `combined` asks with the probe's own type, audio codec included, which is
 * what this module has always done and what Safari answers correctly.
 * `videoOnly` asks the spec-conformant way, with a single video codec, which is
 * the only form Chrome accepts. Which of the two to believe is decided across
 * the whole probe set rather than probe by probe — see `resolveVideoProbes`.
 */
interface VideoProbeResult {
  combined: CodecCapability;
  videoOnly: CodecCapability;
}

async function askDecodingInfo(
  contentType: string,
  probe: VideoProbe,
): Promise<
  { supported: boolean; smooth?: boolean; powerEfficient?: boolean } | undefined
> {
  const mediaCapabilities = navigator.mediaCapabilities;
  if (!mediaCapabilities?.decodingInfo) return undefined;

  try {
    const info = await mediaCapabilities.decodingInfo({
      type: isMseTypeSupported(contentType) ? "media-source" : "file",
      video: {
        contentType,
        width: probe.width,
        height: probe.height,
        bitrate: probe.bitrate,
        framerate: probe.framerate,
      },
    });
    return {
      supported: info.supported,
      smooth: info.smooth,
      powerEfficient: info.powerEfficient,
    };
  } catch {
    // Browser implementations differ here; the caller's fallbacks still apply.
    return undefined;
  }
}

async function probeVideoCapability(
  videoElement: HTMLVideoElement,
  probe: VideoProbe,
): Promise<VideoProbeResult> {
  const videoContentType = videoOnlyContentType(probe.mimeType);
  const fallbackSupported =
    canPlayType(videoElement, probe.mimeType) ||
    isMseTypeSupported(probe.mimeType);

  const [combinedInfo, videoOnlyInfo] = await Promise.all([
    askDecodingInfo(probe.mimeType, probe),
    videoContentType === probe.mimeType
      ? Promise.resolve(undefined)
      : askDecodingInfo(videoContentType, probe),
  ]);

  const shape = (
    info: Awaited<ReturnType<typeof askDecodingInfo>>,
    tested: string[],
  ): CodecCapability => {
    // `decodingInfo` is authoritative when the browser implements it.
    // `canPlayType` is not: Safari answers "probably" for avc1.6E0034 because
    // it matches `avc1` without reading the profile, so a 10-bit H.264 master
    // was reported as playable and then failed to decode — a fatal player
    // error on a title that had a perfectly good rendition to fall back to.
    const supported = info ? info.supported : fallbackSupported;
    return {
      supported,
      smooth: info?.smooth,
      powerEfficient: info?.powerEfficient,
      mimeTypesTested: tested,
      supports10Bit: supported && probe.bitDepth === 10 ? true : undefined,
      supportsHdr: supported && probe.hdr ? true : undefined,
    };
  };

  return {
    combined: shape(combinedInfo, [probe.mimeType]),
    videoOnly: shape(videoOnlyInfo ?? combinedInfo, [
      probe.mimeType,
      videoContentType,
    ]),
  };
}

/**
 * Picks which of the two answers to believe, for the probe set as a whole.
 *
 * A browser that rejects the combined form does so for *every* codec, so
 * "nothing at all is decodable" is the signature of a query the browser would
 * not answer rather than of a client that genuinely cannot play video — no
 * shipping browser can decode none of H.264, HEVC, AV1 and VP9. Only in that
 * case is the spec-conformant video-only answer substituted.
 *
 * Deciding this across the set rather than per probe is what keeps Safari's
 * behaviour identical to before: it answers the combined form fine, so its
 * results are used unchanged, including its correct refusal of 10-bit H.264.
 */
export function resolveVideoProbes(
  results: VideoProbeResult[],
): CodecCapability[] {
  const combinedRejectsEverything =
    results.length > 0 && results.every((result) => !result.combined.supported);

  return results.map((result) =>
    combinedRejectsEverything ? result.videoOnly : result.combined,
  );
}

async function probeAudioCapability(
  audioElement: HTMLAudioElement,
  probe: AudioProbe,
): Promise<AudioCapability> {
  const mediaCapabilities = navigator.mediaCapabilities;
  let supported =
    canPlayType(audioElement, probe.mimeType) ||
    isMseTypeSupported(probe.mimeType);

  if (mediaCapabilities?.decodingInfo) {
    try {
      const info = await mediaCapabilities.decodingInfo({
        type: isMseTypeSupported(probe.mimeType) ? "media-source" : "file",
        audio: {
          contentType: probe.mimeType,
          channels: String(probe.channels),
          bitrate: probe.bitrate,
          samplerate: probe.samplerate,
        },
      });

      supported = info.supported || supported;
    } catch {
      // Keep the canPlayType/MSE answer.
    }
  }

  return {
    supported,
    mimeTypesTested: [probe.mimeType],
  };
}

function mergeVideoCapability(
  current: CodecCapability | undefined,
  next: CodecCapability,
): CodecCapability {
  return {
    supported: Boolean(current?.supported || next.supported),
    smooth: Boolean(current?.smooth || next.smooth),
    powerEfficient: Boolean(current?.powerEfficient || next.powerEfficient),
    mimeTypesTested: Array.from(
      new Set([
        ...(current?.mimeTypesTested ?? []),
        ...(next.mimeTypesTested ?? []),
      ]),
    ),
    supports10Bit: Boolean(current?.supports10Bit || next.supports10Bit),
    supportsHdr: Boolean(current?.supportsHdr || next.supportsHdr),
  };
}

function mergeAudioCapability(
  current: AudioCapability | undefined,
  next: AudioCapability,
): AudioCapability {
  return {
    supported: Boolean(current?.supported || next.supported),
    mimeTypesTested: Array.from(
      new Set([
        ...(current?.mimeTypesTested ?? []),
        ...(next.mimeTypesTested ?? []),
      ]),
    ),
  };
}

function getContainerSupport(videoElement: HTMLVideoElement): {
  directFileContainers: string[];
  mseContainers: string[];
  supportsHlsNative: boolean;
  supportsMediaSource: boolean;
  supportsManagedMediaSource: boolean;
} {
  const mp4Type = 'video/mp4; codecs="avc1.640028, mp4a.40.2"';
  const webmType = 'video/webm; codecs="vp09.00.10.08, opus"';
  const directFileContainers: string[] = [];
  const mseContainers: string[] = [];
  const mp4Supported = canPlayType(videoElement, mp4Type);
  const webmSupported = canPlayType(videoElement, webmType);

  if (mp4Supported) {
    directFileContainers.push("mp4", "m4v", "mov");
  }

  if (webmSupported) {
    directFileContainers.push("webm");
  }

  if (isMseTypeSupported(mp4Type)) {
    mseContainers.push("mp4");
  }

  if (isMseTypeSupported(webmType)) {
    mseContainers.push("webm");
  }

  return {
    directFileContainers,
    mseContainers,
    supportsHlsNative:
      canPlayType(videoElement, "application/vnd.apple.mpegurl") ||
      canPlayType(videoElement, "application/x-mpegURL"),
    supportsMediaSource: typeof MediaSource !== "undefined",
    supportsManagedMediaSource: "ManagedMediaSource" in globalThis,
  };
}

export async function buildClientCapabilities(): Promise<ClientCapabilities> {
  const videoElement = document.createElement("video");
  const audioElement = document.createElement("audio");
  const containers = getContainerSupport(videoElement);
  const video: ClientCapabilities["video"] = {};
  const audio: ClientCapabilities["audio"] = {};

  const [videoCapabilities, audioCapabilities] = await Promise.all([
    Promise.all(
      VIDEO_PROBES.map((probe) => probeVideoCapability(videoElement, probe)),
    ),
    Promise.all(
      AUDIO_PROBES.map((probe) => probeAudioCapability(audioElement, probe)),
    ),
  ]);

  const resolvedVideoCapabilities = resolveVideoProbes(videoCapabilities);

  VIDEO_PROBES.forEach((probe, index) => {
    const capability = resolvedVideoCapabilities[index];
    video[probe.key] = mergeVideoCapability(video[probe.key], capability);
  });

  AUDIO_PROBES.forEach((probe, index) => {
    const capability = audioCapabilities[index];
    audio[probe.key] = mergeAudioCapability(audio[probe.key], capability);
  });

  return {
    deviceId: getOrCreateDeviceId(),
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    playbackEngine: "browser",
    ...containers,
    video,
    audio,
    subtitles: {
      srtExternal: false,
      webvttExternal: true,
      assExternal: false,
      imageBasedExternal: false,
    },
    testedAt: new Date().toISOString(),
  };
}
