import type {
  AudioCapability,
  AudioStreamAnalysis,
  ClientCapabilities,
  CodecCapability,
  DecidePlaybackPlanInput,
  MediaAnalysis,
  NativePlayerCapabilities,
  PlaybackPlan,
  PlaybackReason,
  PlaybackReasonCode,
  SubtitleAction,
  SubtitleStreamAnalysis,
  VideoStreamAnalysis,
} from "./types";

type VideoCodecKey = keyof ClientCapabilities["video"];
type AudioCodecKey = keyof ClientCapabilities["audio"];

const TEXT_SUBTITLE_CODECS = new Set([
  "subrip",
  "srt",
  "webvtt",
  "ass",
  "ssa",
  "mov_text",
]);

function reason(
  code: PlaybackReasonCode,
  severity: PlaybackReason["severity"],
  message: string,
): PlaybackReason {
  return { code, severity, message };
}

function normalizeCodec(codec: string | undefined): string {
  return (codec ?? "unknown").toLowerCase();
}

function nativeListSupports(
  supportedValues: string[] | "*",
  value: string,
): boolean {
  return (
    supportedValues === "*" ||
    supportedValues
      .map((supportedValue) => normalizeCodec(supportedValue))
      .includes(normalizeCodec(value))
  );
}

function getNativePlayer(
  client: ClientCapabilities,
): NativePlayerCapabilities | undefined {
  return client.playbackEngine === "native" ? client.nativePlayer : undefined;
}

function normalizeContainer(media: MediaAnalysis): string {
  const extension = media.container.extension?.toLowerCase();

  if (extension) {
    return extension;
  }

  const formatName = media.container.formatName.toLowerCase();

  if (formatName.includes("matroska")) {
    return formatName.includes("webm") ? "webm" : "mkv";
  }

  if (formatName.includes("mp4") || formatName.includes("mov")) {
    return "mp4";
  }

  if (formatName.includes("webm")) {
    return "webm";
  }

  return formatName.split(",")[0] || "unknown";
}

function isMp4FamilyContainer(container: string): boolean {
  return container === "mp4" || container === "m4v" || container === "mov";
}

function videoCodecKey(codec: string): VideoCodecKey | undefined {
  switch (normalizeCodec(codec)) {
    case "h264":
    case "avc":
    case "avc1":
      return "h264";
    case "hevc":
    case "h265":
      return "hevc";
    case "av1":
      return "av1";
    case "vp9":
      return "vp9";
    default:
      return undefined;
  }
}

function audioCodecKey(codec: string): AudioCodecKey | undefined {
  switch (normalizeCodec(codec)) {
    case "aac":
    case "mp4a":
      return "aac";
    case "mp3":
    case "mp2":
      return "mp3";
    case "opus":
      return "opus";
    case "ac3":
      return "ac3";
    case "eac3":
    case "e-ac-3":
      return "eac3";
    case "flac":
      return "flac";
    default:
      return undefined;
  }
}

function findVideoStream(
  media: MediaAnalysis,
  selectedIndex: number | undefined,
): VideoStreamAnalysis {
  const selected =
    selectedIndex === undefined
      ? undefined
      : media.videoStreams.find((stream) => stream.index === selectedIndex);

  return selected ?? media.videoStreams[0];
}

function findAudioStream(
  media: MediaAnalysis,
  selectedIndex: number | undefined,
): AudioStreamAnalysis | undefined {
  if (selectedIndex !== undefined) {
    return media.audioStreams.find((stream) => stream.index === selectedIndex);
  }

  return (
    media.audioStreams.find((stream) => stream.isDefault) ??
    media.audioStreams[0]
  );
}

function findSubtitleStream(
  media: MediaAnalysis,
  selectedIndex: number | null | undefined,
): SubtitleStreamAnalysis | undefined {
  if (selectedIndex === undefined || selectedIndex === null) {
    return undefined;
  }

  return media.subtitleStreams.find((stream) => stream.index === selectedIndex);
}

function getMaxResolution(
  capability: CodecCapability | undefined,
  client: ClientCapabilities,
  forceQualityLimit: DecidePlaybackPlanInput["forceQualityLimit"],
): { maxWidth?: number; maxHeight?: number } {
  const nativePlayer = getNativePlayer(client);

  const widths = [
    nativePlayer ? capability?.maxWidth : undefined,
    client.maxResolution?.width,
    forceQualityLimit?.maxWidth,
  ].filter((value): value is number => typeof value === "number" && value > 0);

  const heights = [
    nativePlayer ? capability?.maxHeight : undefined,
    client.maxResolution?.height,
    forceQualityLimit?.maxHeight,
  ].filter((value): value is number => typeof value === "number" && value > 0);

  return {
    maxWidth: widths.length > 0 ? Math.min(...widths) : undefined,
    maxHeight: heights.length > 0 ? Math.min(...heights) : undefined,
  };
}

function getMaxBitrate(
  capability: CodecCapability | undefined,
  client: ClientCapabilities,
  forceQualityLimit: DecidePlaybackPlanInput["forceQualityLimit"],
): number | undefined {
  const nativePlayer = getNativePlayer(client);

  const bitrates = [
    nativePlayer ? capability?.maxBitrate : undefined,
    client.maxBitrate,
    forceQualityLimit?.maxBitrate,
  ].filter((value): value is number => typeof value === "number" && value > 0);

  return bitrates.length > 0 ? Math.min(...bitrates) : undefined;
}

function isHigh10Profile(video: VideoStreamAnalysis): boolean {
  const profile = video.profile?.toLowerCase() ?? "";

  return (
    profile.includes("10") ||
    profile.includes("main 10") ||
    profile.includes("high 10")
  );
}

function evaluateVideoCompatibility(
  media: MediaAnalysis,
  client: ClientCapabilities,
  video: VideoStreamAnalysis,
  container: string,
  directContainerSupported: boolean,
  forceQualityLimit: DecidePlaybackPlanInput["forceQualityLimit"],
): {
  compatible: boolean;
  outputCodec?: string;
  reasons: PlaybackReason[];
} {
  const reasons: PlaybackReason[] = [];
  const codecKey = videoCodecKey(video.codecName);
  const nativePlayer = getNativePlayer(client);
  const nativeCodecSupported = Boolean(
    nativePlayer &&
    nativeListSupports(nativePlayer.supportedVideoCodecs, video.codecName),
  );
  const browserCapability = codecKey ? client.video[codecKey] : undefined;
  const inferredBrowserH264Support =
    !nativePlayer &&
    codecKey === "h264" &&
    isMp4FamilyContainer(container) &&
    directContainerSupported &&
    media.container.isBrowserDirectPlayableContainer &&
    (video.bitDepth === undefined || video.bitDepth <= 8) &&
    !isHigh10Profile(video) &&
    !video.isHdr &&
    !video.hasDolbyVision;
  const capability: CodecCapability | undefined = nativeCodecSupported
    ? {
        supported: true,
        smooth: true,
        powerEfficient: nativePlayer?.hardwareDecoding,
        maxWidth: nativePlayer?.maxWidth,
        maxHeight: nativePlayer?.maxHeight,
        maxBitrate: nativePlayer?.maxBitrate,
        supports10Bit: nativePlayer?.supports10BitVideo,
        supportsHdr: nativePlayer?.supportsHdr,
      }
    : browserCapability?.supported
      ? browserCapability
      : inferredBrowserH264Support
        ? {
            supported: true,
            smooth: true,
            powerEfficient: browserCapability?.powerEfficient,
            mimeTypesTested: browserCapability?.mimeTypesTested,
            maxWidth: browserCapability?.maxWidth,
            maxHeight: browserCapability?.maxHeight,
            maxBitrate: browserCapability?.maxBitrate,
            maxFramerate: browserCapability?.maxFramerate,
            supports10Bit: browserCapability?.supports10Bit,
            supportsHdr: browserCapability?.supportsHdr,
          }
        : browserCapability;

  if (!capability?.supported) {
    reasons.push(
      reason(
        "video_codec_unsupported",
        "blocking",
        `Video codec ${video.codecName} is not reported as playable by this client.`,
      ),
    );
  }

  if (
    capability?.supported &&
    video.profile &&
    codecKey === "h264" &&
    isHigh10Profile(video) &&
    !capability.supports10Bit
  ) {
    reasons.push(
      reason(
        "video_profile_unsupported",
        "blocking",
        `Video profile ${video.profile} needs 10-bit H.264 support.`,
      ),
    );
  }

  if (
    capability?.supported &&
    typeof video.bitDepth === "number" &&
    video.bitDepth > 8 &&
    !capability.supports10Bit
  ) {
    reasons.push(
      reason(
        "video_bit_depth_unsupported",
        "blocking",
        `Video is ${video.bitDepth}-bit, but the client did not report ${video.bitDepth}-bit support for ${video.codecName}.`,
      ),
    );
  }

  if ((video.isHdr || video.hasDolbyVision) && !capability?.supportsHdr) {
    reasons.push(
      reason(
        "hdr_tonemap_required",
        "blocking",
        "Video is HDR or Dolby Vision and the client did not report HDR support.",
      ),
    );
  }

  if (
    video.hasDolbyVision &&
    nativePlayer &&
    !nativePlayer.supportsDolbyVisionBaseLayer &&
    !reasons.some((item) => item.code === "hdr_tonemap_required")
  ) {
    reasons.push(
      reason(
        "hdr_tonemap_required",
        "blocking",
        "Dolby Vision requires base-layer fallback or tone mapping on this client.",
      ),
    );
  }

  const { maxWidth, maxHeight } = getMaxResolution(
    capability,
    client,
    forceQualityLimit,
  );

  if (
    (maxWidth && video.width > maxWidth) ||
    (maxHeight && video.height > maxHeight)
  ) {
    reasons.push(
      reason(
        "resolution_too_high",
        "blocking",
        `Video resolution ${video.width}x${video.height} exceeds the requested/client limit.`,
      ),
    );
  }

  const maxBitrate = getMaxBitrate(capability, client, forceQualityLimit);
  const bitrateToCheck = video.bitrate ?? media.overallBitrate;

  if (maxBitrate && bitrateToCheck && bitrateToCheck > maxBitrate) {
    reasons.push(
      reason(
        "bitrate_too_high",
        "blocking",
        `Media bitrate ${bitrateToCheck} exceeds the limit of ${maxBitrate}.`,
      ),
    );
  }

  return {
    compatible: reasons.length === 0,
    outputCodec: reasons.length === 0 ? undefined : "h264",
    reasons,
  };
}

function evaluateAudioCompatibility(
  client: ClientCapabilities,
  audio: AudioStreamAnalysis | undefined,
  container: string,
  directContainerSupported: boolean,
): {
  compatible: boolean;
  outputCodec?: string;
  reasons: PlaybackReason[];
} {
  if (!audio) {
    return { compatible: true, reasons: [] };
  }

  const reasons: PlaybackReason[] = [];
  const codecKey = audioCodecKey(audio.codecName);
  const nativePlayer = getNativePlayer(client);
  const nativeCodecSupported = Boolean(
    nativePlayer &&
    nativeListSupports(nativePlayer.supportedAudioCodecs, audio.codecName),
  );
  const browserCapability = codecKey ? client.audio[codecKey] : undefined;
  const inferredBrowserAacSupport =
    !nativePlayer &&
    codecKey === "aac" &&
    isMp4FamilyContainer(container) &&
    directContainerSupported;
  const capability: AudioCapability | undefined = nativeCodecSupported
    ? {
        supported: true,
        maxChannels: nativePlayer?.maxAudioChannels,
      }
    : browserCapability?.supported
      ? browserCapability
      : inferredBrowserAacSupport
        ? {
            supported: true,
            mimeTypesTested: browserCapability?.mimeTypesTested,
            maxChannels: browserCapability?.maxChannels,
          }
        : browserCapability;

  if (!capability?.supported) {
    reasons.push(
      reason(
        "audio_codec_unsupported",
        "blocking",
        `Audio codec ${audio.codecName} is not reported as playable by this client.`,
      ),
    );
  }

  if (
    capability?.supported &&
    capability.maxChannels &&
    audio.channels &&
    audio.channels > capability.maxChannels
  ) {
    reasons.push(
      reason(
        "audio_channels_unsupported",
        "blocking",
        `Audio has ${audio.channels} channels, above the client limit of ${capability.maxChannels}.`,
      ),
    );
  }

  return {
    compatible: reasons.length === 0,
    outputCodec: reasons.length === 0 ? undefined : "aac",
    reasons,
  };
}

function evaluateSubtitleAction(
  client: ClientCapabilities,
  subtitle: SubtitleStreamAnalysis | undefined,
): {
  action: SubtitleAction;
  reasons: PlaybackReason[];
} {
  if (!subtitle) {
    return { action: "none", reasons: [] };
  }

  const codec = normalizeCodec(subtitle.codecName);
  const nativePlayer = getNativePlayer(client);

  if (nativePlayer) {
    const nativeSubtitleSupported = subtitle.isImageBased
      ? nativePlayer.subtitles.imageBased
      : codec === "ass" || codec === "ssa"
        ? nativePlayer.subtitles.ass
        : nativePlayer.subtitles.text;

    if (nativeSubtitleSupported) {
      return {
        action: "external",
        reasons: [
          reason(
            "subtitle_external_supported",
            "info",
            `Selected ${subtitle.codecName} subtitle can be rendered by the native player.`,
          ),
        ],
      };
    }
  }

  if (subtitle.isImageBased) {
    if (client.subtitles.imageBasedExternal) {
      return {
        action: "external",
        reasons: [
          reason(
            "subtitle_external_supported",
            "info",
            `Selected image subtitle ${subtitle.codecName} can be delivered externally by this client.`,
          ),
        ],
      };
    }

    return {
      action: "burn",
      reasons: [
        reason(
          "subtitle_burn_required",
          "blocking",
          `Selected image subtitle ${subtitle.codecName} requires burn-in for this client.`,
        ),
      ],
    };
  }

  if (codec === "webvtt" && client.subtitles.webvttExternal) {
    return {
      action: "external",
      reasons: [
        reason(
          "subtitle_external_supported",
          "info",
          "Selected WebVTT subtitle can be delivered externally.",
        ),
      ],
    };
  }

  if ((codec === "subrip" || codec === "srt") && client.subtitles.srtExternal) {
    return {
      action: "external",
      reasons: [
        reason(
          "subtitle_external_supported",
          "info",
          "Selected SRT subtitle can be delivered externally.",
        ),
      ],
    };
  }

  if ((codec === "ass" || codec === "ssa") && client.subtitles.assExternal) {
    return {
      action: "external",
      reasons: [
        reason(
          "subtitle_external_supported",
          "info",
          "Selected ASS/SSA subtitle can be delivered externally.",
        ),
      ],
    };
  }

  if (TEXT_SUBTITLE_CODECS.has(codec) && client.subtitles.webvttExternal) {
    return {
      action: "convert",
      reasons: [
        reason(
          "subtitle_conversion_required",
          "warning",
          `Selected subtitle ${subtitle.codecName} should be converted to WebVTT for this client.`,
        ),
      ],
    };
  }

  return {
    action: "burn",
    reasons: [
      reason(
        "subtitle_burn_required",
        "blocking",
        `Selected subtitle ${subtitle.codecName} cannot be delivered externally or converted for this client.`,
      ),
    ],
  };
}

function clientSupportsDirectContainer(
  client: ClientCapabilities,
  container: string,
): boolean {
  const nativePlayer = getNativePlayer(client);

  if (nativePlayer) {
    return nativeListSupports(nativePlayer.supportedContainers, container);
  }

  return client.directFileContainers
    .map((value) => value.toLowerCase())
    .includes(container.toLowerCase());
}

function chooseHlsContainer(client: ClientCapabilities): "hls-fmp4" | "hls-ts" {
  return client.supportsMediaSource ? "hls-fmp4" : "hls-ts";
}

function shouldCopyAudioInVideoTranscode(
  audio: AudioStreamAnalysis | undefined,
  audioCompatible: boolean,
): boolean {
  if (!audio || !audioCompatible) {
    return false;
  }

  return ["aac", "mp3", "opus"].includes(normalizeCodec(audio.codecName));
}

export function decidePlaybackPlan({
  media,
  client,
  selectedVideoStreamIndex,
  selectedAudioStreamIndex,
  selectedSubtitleStreamIndex,
  forceQualityLimit,
}: DecidePlaybackPlanInput): PlaybackPlan {
  const video = findVideoStream(media, selectedVideoStreamIndex);

  if (!video) {
    throw new Error(`Media ${media.mediaId} has no video streams.`);
  }

  const audio = findAudioStream(media, selectedAudioStreamIndex);
  const subtitle = findSubtitleStream(media, selectedSubtitleStreamIndex);
  const container = normalizeContainer(media);
  const directContainerSupported = getNativePlayer(client)
    ? clientSupportsDirectContainer(client, container)
    : media.container.isBrowserDirectPlayableContainer &&
      clientSupportsDirectContainer(client, container);
  const videoCompatibility = evaluateVideoCompatibility(
    media,
    client,
    video,
    container,
    directContainerSupported,
    forceQualityLimit,
  );
  const audioCompatibility = evaluateAudioCompatibility(
    client,
    audio,
    container,
    directContainerSupported,
  );
  const subtitleDecision = evaluateSubtitleAction(client, subtitle);
  const containerReasons: PlaybackReason[] = directContainerSupported
    ? []
    : [
        reason(
          "container_unsupported",
          "blocking",
          `Container ${container} is not direct-playable for this client; remux is enough if streams are compatible.`,
        ),
      ];
  const allReasons = [
    ...videoCompatibility.reasons,
    ...audioCompatibility.reasons,
    ...subtitleDecision.reasons,
    ...containerReasons,
  ];
  const selected = {
    videoStreamIndex: video.index,
    ...(audio ? { audioStreamIndex: audio.index } : {}),
    ...(subtitle ? { subtitleStreamIndex: subtitle.index } : {}),
  };
  const inputAudioCodec = audio?.codecName;
  const inputSubtitleCodec = subtitle?.codecName;

  if (!videoCompatibility.compatible) {
    const copyAudio = shouldCopyAudioInVideoTranscode(
      audio,
      audioCompatibility.compatible,
    );

    return {
      mode: "video-transcode",
      requiresFfmpeg: true,
      preservesOriginalVideoQuality: false,
      expectedStartup: "slow",
      mediaId: media.mediaId,
      selected,
      container: {
        input: container,
        output: chooseHlsContainer(client),
        action: "hls",
      },
      video: {
        inputCodec: video.codecName,
        outputCodec: "h264",
        action: "transcode",
        reason:
          videoCompatibility.reasons[0]?.message ??
          "Video stream requires transcoding.",
      },
      audio: {
        inputCodec: inputAudioCodec,
        outputCodec: copyAudio ? undefined : "aac",
        action: audio ? (copyAudio ? "copy" : "transcode") : "none",
        reason: copyAudio
          ? undefined
          : audio
            ? "Audio will be converted to AAC for the transcoded HLS output."
            : undefined,
      },
      subtitles: {
        inputCodec: inputSubtitleCodec,
        action: subtitleDecision.action,
        reason: subtitleDecision.reasons[0]?.message,
      },
      reasons: allReasons,
      delivery: {
        type: "hls",
      },
    };
  }

  if (subtitleDecision.action === "burn") {
    return {
      mode: "subtitle-burn",
      requiresFfmpeg: true,
      preservesOriginalVideoQuality: false,
      expectedStartup: "slow",
      mediaId: media.mediaId,
      selected,
      container: {
        input: container,
        output: chooseHlsContainer(client),
        action: "hls",
      },
      video: {
        inputCodec: video.codecName,
        outputCodec: "h264",
        action: "transcode",
        reason:
          "Selected subtitles require burn-in, which requires video encoding.",
      },
      audio: {
        inputCodec: inputAudioCodec,
        outputCodec: audioCompatibility.compatible ? undefined : "aac",
        action: audio
          ? audioCompatibility.compatible
            ? "copy"
            : "transcode"
          : "none",
        reason: audioCompatibility.reasons[0]?.message,
      },
      subtitles: {
        inputCodec: inputSubtitleCodec,
        action: "burn",
        reason: subtitleDecision.reasons[0]?.message,
      },
      reasons: allReasons,
      delivery: {
        type: "hls",
      },
    };
  }

  if (!audioCompatibility.compatible) {
    return {
      mode: "audio-transcode",
      requiresFfmpeg: true,
      preservesOriginalVideoQuality: true,
      expectedStartup: "fast",
      mediaId: media.mediaId,
      selected,
      container: {
        input: container,
        output: chooseHlsContainer(client),
        action: "hls",
      },
      video: {
        inputCodec: video.codecName,
        action: "copy",
      },
      audio: {
        inputCodec: inputAudioCodec,
        outputCodec: "aac",
        action: "transcode",
        reason: audioCompatibility.reasons[0]?.message,
      },
      subtitles: {
        inputCodec: inputSubtitleCodec,
        action: subtitleDecision.action,
        reason: subtitleDecision.reasons[0]?.message,
      },
      reasons: allReasons,
      delivery: {
        type: "hls",
      },
    };
  }

  if (!directContainerSupported || subtitleDecision.action === "convert") {
    return {
      mode: "remux",
      requiresFfmpeg: true,
      preservesOriginalVideoQuality: true,
      expectedStartup: "fast",
      mediaId: media.mediaId,
      selected,
      container: {
        input: container,
        output: chooseHlsContainer(client),
        action: "hls",
      },
      video: {
        inputCodec: video.codecName,
        action: "copy",
      },
      audio: {
        inputCodec: inputAudioCodec,
        action: audio ? "copy" : "none",
      },
      subtitles: {
        inputCodec: inputSubtitleCodec,
        action: subtitleDecision.action,
        reason: subtitleDecision.reasons[0]?.message,
      },
      reasons: [...containerReasons, ...subtitleDecision.reasons],
      delivery: {
        type: "hls",
      },
    };
  }

  return {
    mode: "direct-play",
    requiresFfmpeg: false,
    preservesOriginalVideoQuality: true,
    expectedStartup: "instant",
    mediaId: media.mediaId,
    selected,
    container: {
      input: container,
      output: "original",
      action: "direct",
    },
    video: {
      inputCodec: video.codecName,
      action: "copy",
    },
    audio: {
      inputCodec: inputAudioCodec,
      action: audio ? "copy" : "none",
    },
    subtitles: {
      inputCodec: inputSubtitleCodec,
      action: subtitleDecision.action,
      reason: subtitleDecision.reasons[0]?.message,
    },
    reasons: [
      reason(
        "direct_play_supported",
        "info",
        "Container, selected video, selected audio, and selected subtitles are direct-play compatible.",
      ),
      ...subtitleDecision.reasons,
    ],
    delivery: {
      type: "file",
      url: `/api/playback/direct/${encodeURIComponent(media.mediaId)}`,
    },
  };
}
