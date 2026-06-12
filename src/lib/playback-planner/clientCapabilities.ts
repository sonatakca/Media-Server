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

    const next =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

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

async function probeVideoCapability(
  videoElement: HTMLVideoElement,
  probe: VideoProbe,
): Promise<CodecCapability> {
  const mediaCapabilities = navigator.mediaCapabilities;
  const tested = [probe.mimeType];
  let supported =
    canPlayType(videoElement, probe.mimeType) ||
    isMseTypeSupported(probe.mimeType);
  let smooth: boolean | undefined;
  let powerEfficient: boolean | undefined;

  if (mediaCapabilities?.decodingInfo) {
    try {
      const info = await mediaCapabilities.decodingInfo({
        type: isMseTypeSupported(probe.mimeType) ? "media-source" : "file",
        video: {
          contentType: probe.mimeType,
          width: probe.width,
          height: probe.height,
          bitrate: probe.bitrate,
          framerate: probe.framerate,
        },
      });

      supported = info.supported || supported;
      smooth = info.smooth;
      powerEfficient = info.powerEfficient;
    } catch {
      // Browser implementations differ here; fallback probes above still apply.
    }
  }

  return {
    supported,
    smooth,
    powerEfficient,
    mimeTypesTested: tested,
    maxWidth: supported ? probe.width : undefined,
    maxHeight: supported ? probe.height : undefined,
    maxBitrate: supported ? probe.bitrate : undefined,
    maxFramerate: supported ? probe.framerate : undefined,
    supports10Bit: supported && probe.bitDepth === 10 ? true : undefined,
    supportsHdr: supported && probe.hdr ? true : undefined,
  };
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
    maxChannels: supported ? probe.channels : undefined,
  };
}

function mergeVideoCapability(
  current: CodecCapability | undefined,
  next: CodecCapability,
): CodecCapability {
  return {
    supported: Boolean(current?.supported || next.supported),
    smooth: current?.smooth || next.smooth,
    powerEfficient: current?.powerEfficient || next.powerEfficient,
    mimeTypesTested: [
      ...(current?.mimeTypesTested ?? []),
      ...(next.mimeTypesTested ?? []),
    ],
    maxWidth: Math.max(current?.maxWidth ?? 0, next.maxWidth ?? 0) || undefined,
    maxHeight:
      Math.max(current?.maxHeight ?? 0, next.maxHeight ?? 0) || undefined,
    maxBitrate:
      Math.max(current?.maxBitrate ?? 0, next.maxBitrate ?? 0) || undefined,
    maxFramerate:
      Math.max(current?.maxFramerate ?? 0, next.maxFramerate ?? 0) || undefined,
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
    mimeTypesTested: [
      ...(current?.mimeTypesTested ?? []),
      ...(next.mimeTypesTested ?? []),
    ],
    maxChannels:
      Math.max(current?.maxChannels ?? 0, next.maxChannels ?? 0) || undefined,
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

  for (const probe of VIDEO_PROBES) {
    const capability = await probeVideoCapability(videoElement, probe);
    video[probe.key] = mergeVideoCapability(video[probe.key], capability);
  }

  for (const probe of AUDIO_PROBES) {
    const capability = await probeAudioCapability(audioElement, probe);
    audio[probe.key] = mergeAudioCapability(audio[probe.key], capability);
  }

  return {
    deviceId: getOrCreateDeviceId(),
    userAgent: navigator.userAgent,
    platform: navigator.platform,
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
