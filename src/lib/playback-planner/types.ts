export type PlaybackMode =
  | "direct-play"
  | "remux"
  | "audio-transcode"
  | "subtitle-burn"
  | "video-transcode";

export type StreamAction = "copy" | "transcode" | "none";
export type ContainerAction = "direct" | "remux" | "hls";
export type SubtitleAction = "none" | "external" | "convert" | "burn";

export interface MediaAnalysis {
  mediaId: string;
  filePath: string;
  container: {
    formatName: string;
    extension?: string;
    isBrowserDirectPlayableContainer: boolean;
  };
  durationSeconds: number;
  overallBitrate?: number;
  videoStreams: VideoStreamAnalysis[];
  audioStreams: AudioStreamAnalysis[];
  subtitleStreams: SubtitleStreamAnalysis[];
  chapters?: Array<{
    id?: number;
    startSeconds: number;
    endSeconds: number;
    title?: string;
  }>;
  analysedAt: string;
}

export interface VideoStreamAnalysis {
  index: number;
  codecName: string;
  codecLongName?: string;
  profile?: string;
  level?: number | string;
  width: number;
  height: number;
  framerate?: number;
  bitrate?: number;
  pixFmt?: string;
  bitDepth?: number;
  colorRange?: string;
  colorSpace?: string;
  colorTransfer?: string;
  colorPrimaries?: string;
  isHdr?: boolean;
  hasDolbyVision?: boolean;
}

export interface AudioStreamAnalysis {
  index: number;
  codecName: string;
  codecLongName?: string;
  channels?: number;
  channelLayout?: string;
  bitrate?: number;
  sampleRate?: number;
  language?: string;
  title?: string;
  isDefault?: boolean;
}

export interface SubtitleStreamAnalysis {
  index: number;
  codecName: string;
  language?: string;
  title?: string;
  isDefault?: boolean;
  isForced?: boolean;
  isImageBased: boolean;
}

export interface ClientCapabilities {
  deviceId?: string;
  userAgent?: string;
  platform?: string;
  supportsHlsNative: boolean;
  supportsMediaSource: boolean;
  supportsManagedMediaSource?: boolean;
  directFileContainers: string[];
  mseContainers: string[];
  video: {
    h264?: CodecCapability;
    hevc?: CodecCapability;
    av1?: CodecCapability;
    vp9?: CodecCapability;
  };
  audio: {
    aac?: AudioCapability;
    mp3?: AudioCapability;
    opus?: AudioCapability;
    ac3?: AudioCapability;
    eac3?: AudioCapability;
    flac?: AudioCapability;
  };
  subtitles: {
    srtExternal: boolean;
    webvttExternal: boolean;
    assExternal: boolean;
    imageBasedExternal: boolean;
  };
  maxResolution?: {
    width: number;
    height: number;
  };
  maxBitrate?: number;
  testedAt: string;
}

export interface CodecCapability {
  supported: boolean;
  smooth?: boolean;
  powerEfficient?: boolean;
  mimeTypesTested?: string[];
  maxWidth?: number;
  maxHeight?: number;
  maxBitrate?: number;
  maxFramerate?: number;
  supports10Bit?: boolean;
  supportsHdr?: boolean;
}

export interface AudioCapability {
  supported: boolean;
  mimeTypesTested?: string[];
  maxChannels?: number;
}

export type PlaybackReasonCode =
  | "direct_play_supported"
  | "container_unsupported"
  | "video_codec_unsupported"
  | "video_profile_unsupported"
  | "video_bit_depth_unsupported"
  | "hdr_tonemap_required"
  | "resolution_too_high"
  | "bitrate_too_high"
  | "audio_codec_unsupported"
  | "audio_channels_unsupported"
  | "subtitle_external_supported"
  | "subtitle_conversion_required"
  | "subtitle_burn_required"
  | "client_capability_unknown";

export interface PlaybackReason {
  code: PlaybackReasonCode;
  severity: "info" | "warning" | "blocking";
  message: string;
}

export interface PlaybackPlan {
  mode: PlaybackMode;
  requiresFfmpeg: boolean;
  preservesOriginalVideoQuality: boolean;
  expectedStartup: "instant" | "fast" | "slow";
  mediaId: string;
  selected: {
    videoStreamIndex: number;
    audioStreamIndex?: number;
    subtitleStreamIndex?: number;
  };
  container: {
    input: string;
    output: "original" | "mp4" | "hls-fmp4" | "hls-ts";
    action: ContainerAction;
  };
  video: {
    inputCodec: string;
    outputCodec?: string;
    action: StreamAction;
    reason?: string;
  };
  audio: {
    inputCodec?: string;
    outputCodec?: string;
    action: StreamAction;
    reason?: string;
  };
  subtitles: {
    inputCodec?: string;
    action: SubtitleAction;
    reason?: string;
  };
  reasons: PlaybackReason[];
  delivery: {
    type: "file" | "hls";
    url?: string;
    sessionId?: string;
  };
}

export interface PlaybackQualityLimit {
  maxBitrate?: number;
  maxWidth?: number;
  maxHeight?: number;
}

export interface DecidePlaybackPlanInput {
  media: MediaAnalysis;
  client: ClientCapabilities;
  selectedVideoStreamIndex?: number;
  selectedAudioStreamIndex?: number;
  selectedSubtitleStreamIndex?: number | null;
  forceQualityLimit?: PlaybackQualityLimit;
}
