import type {
  ClientCapabilities,
  NativePlayerCapabilities,
} from "./types";

const DEFAULT_NATIVE_CONTAINERS = [
  "mp4",
  "m4v",
  "mov",
  "mkv",
  "webm",
  "avi",
  "mpeg",
  "ts",
  "m2ts",
];
const DEFAULT_NATIVE_VIDEO_CODECS = [
  "h264",
  "hevc",
  "av1",
  "vp9",
  "vp8",
  "mpeg2video",
  "mpeg4",
  "vc1",
];
const DEFAULT_NATIVE_AUDIO_CODECS = [
  "aac",
  "mp3",
  "opus",
  "ac3",
  "eac3",
  "flac",
  "dts",
  "truehd",
  "vorbis",
  "alac",
  "pcm_s16le",
  "pcm_s24le",
];

export interface NativeClientProfileInput {
  deviceId?: string;
  platform: string;
  userAgent?: string;
  engine?: NativePlayerCapabilities["engine"];
  engineVersion?: string;
  hardwareDecoding?: boolean;
  supportsHdr?: boolean;
  supportsDolbyVisionBaseLayer?: boolean;
  maxWidth?: number;
  maxHeight?: number;
  maxBitrate?: number;
  maxAudioChannels?: number;
  supportedContainers?: string[] | "*";
  supportedVideoCodecs?: string[] | "*";
  supportedAudioCodecs?: string[] | "*";
}

/**
 * Produces the capability payload expected by the playback backend for a
 * desktop shell backed by libmpv/FFmpeg rather than an HTMLVideoElement.
 */
export function createNativeClientCapabilities({
  deviceId,
  platform,
  userAgent,
  engine = "libmpv",
  engineVersion,
  hardwareDecoding = true,
  supportsHdr = true,
  supportsDolbyVisionBaseLayer = true,
  maxWidth = 7680,
  maxHeight = 4320,
  maxBitrate,
  maxAudioChannels = 16,
  supportedContainers = DEFAULT_NATIVE_CONTAINERS,
  supportedVideoCodecs = DEFAULT_NATIVE_VIDEO_CODECS,
  supportedAudioCodecs = DEFAULT_NATIVE_AUDIO_CODECS,
}: NativeClientProfileInput): ClientCapabilities {
  const genericVideoCapability = {
    supported: true,
    smooth: true,
    powerEfficient: hardwareDecoding,
    maxWidth,
    maxHeight,
    maxBitrate,
    supports10Bit: true,
    supportsHdr,
  };
  const genericAudioCapability = {
    supported: true,
    maxChannels: maxAudioChannels,
  };

  return {
    deviceId,
    platform,
    userAgent,
    playbackEngine: "native",
    nativePlayer: {
      engine,
      version: engineVersion,
      supportedContainers:
        supportedContainers === "*" ? "*" : [...supportedContainers],
      supportedVideoCodecs:
        supportedVideoCodecs === "*" ? "*" : [...supportedVideoCodecs],
      supportedAudioCodecs:
        supportedAudioCodecs === "*" ? "*" : [...supportedAudioCodecs],
      hardwareDecoding,
      supports10BitVideo: true,
      supportsHdr,
      supportsDolbyVisionBaseLayer,
      maxWidth,
      maxHeight,
      maxBitrate,
      maxAudioChannels,
      subtitles: {
        text: true,
        ass: true,
        imageBased: true,
      },
    },
    supportsHlsNative: true,
    supportsMediaSource: false,
    supportsManagedMediaSource: false,
    directFileContainers:
      supportedContainers === "*" ? [] : [...supportedContainers],
    mseContainers: [],
    video: {
      h264: { ...genericVideoCapability },
      hevc: { ...genericVideoCapability },
      av1: { ...genericVideoCapability },
      vp9: { ...genericVideoCapability },
    },
    audio: {
      aac: { ...genericAudioCapability },
      mp3: { ...genericAudioCapability },
      opus: { ...genericAudioCapability },
      ac3: { ...genericAudioCapability },
      eac3: { ...genericAudioCapability },
      flac: { ...genericAudioCapability },
    },
    subtitles: {
      srtExternal: true,
      webvttExternal: true,
      assExternal: true,
      imageBasedExternal: true,
    },
    maxResolution: {
      width: maxWidth,
      height: maxHeight,
    },
    maxBitrate,
    testedAt: new Date().toISOString(),
  };
}
