import type {
  JellyfinMediaSource,
  PlaybackMode as JellyfinPlaybackMode,
  PlaybackSourceCandidate,
} from "../types";
import { buildClientCapabilities } from "./clientCapabilities";
import type { PlaybackPlan } from "./types";

const CAPABILITY_CACHE_TTL_MS = 30 * 60 * 1000;
let cachedCapabilities:
  | {
      testedAtMs: number;
      value: Awaited<ReturnType<typeof buildClientCapabilities>>;
    }
  | undefined;
let capabilityPromise: Promise<
  Awaited<ReturnType<typeof buildClientCapabilities>>
> | null = null;

function getBackendUrl(): string | null {
  const rawUrl = import.meta.env.VITE_SEYIRLIK_PLAYBACK_BACKEND_URL;

  if (!rawUrl) {
    return null;
  }

  return rawUrl.replace(/\/+$/, "");
}

function buildPlaybackEndpoint(baseUrl: string): string {
  if (baseUrl.endsWith("/api/playback")) {
    return `${baseUrl}/request`;
  }

  return `${baseUrl}/api/playback/request`;
}

function buildSessionStopEndpoint(baseUrl: string, sessionId: string): string {
  if (baseUrl.endsWith("/api/playback")) {
    return `${baseUrl}/sessions/${encodeURIComponent(sessionId)}/stop`;
  }

  return `${baseUrl}/api/playback/sessions/${encodeURIComponent(sessionId)}/stop`;
}

function makePlanUrlAbsolute(baseUrl: string, url: string | undefined): string {
  if (!url) {
    throw new Error("Custom playback backend did not return a delivery URL.");
  }

  return new URL(url, `${baseUrl}/`).toString();
}

function getMimeType(plan: PlaybackPlan): string {
  if (plan.delivery.type === "hls") {
    return "application/vnd.apple.mpegurl";
  }

  switch (plan.container.input) {
    case "mp4":
      return "video/mp4";
    case "webm":
      return "video/webm";
    case "mkv":
      return "video/x-matroska";
    default:
      return "application/octet-stream";
  }
}

function mapMode(plan: PlaybackPlan): JellyfinPlaybackMode {
  switch (plan.mode) {
    case "direct-play":
      return "DirectPlay";
    case "remux":
    case "audio-transcode":
      return "DirectStream";
    case "subtitle-burn":
    case "video-transcode":
      return "Transcoding";
    default:
      return "Unknown";
  }
}

function mapHlsKind(
  plan: PlaybackPlan,
): PlaybackSourceCandidate["hlsKind"] | undefined {
  if (plan.delivery.type !== "hls") {
    return "direct";
  }

  switch (plan.mode) {
    case "remux":
      return "stream-copy";
    case "audio-transcode":
      return "audio-transcode";
    case "subtitle-burn":
    case "video-transcode":
      return "forced-transcode";
    default:
      return undefined;
  }
}

function buildSyntheticMediaSource(plan: PlaybackPlan): JellyfinMediaSource {
  return {
    Id: plan.mediaId,
    Name: plan.mediaId,
    Container: plan.container.input,
    SupportsDirectPlay: plan.mode === "direct-play",
    SupportsDirectStream:
      plan.mode === "remux" || plan.mode === "audio-transcode",
    SupportsTranscoding:
      plan.mode === "subtitle-burn" || plan.mode === "video-transcode",
    TranscodingReasons: plan.reasons.map((reason) => reason.code),
    MediaStreams: [
      {
        Index: plan.selected.videoStreamIndex,
        Type: "Video",
        Codec: plan.video.outputCodec ?? plan.video.inputCodec,
      },
      ...(plan.selected.audioStreamIndex !== undefined
        ? [
            {
              Index: plan.selected.audioStreamIndex,
              Type: "Audio" as const,
              Codec: plan.audio.outputCodec ?? plan.audio.inputCodec,
            },
          ]
        : []),
      ...(plan.selected.subtitleStreamIndex !== undefined
        ? [
            {
              Index: plan.selected.subtitleStreamIndex,
              Type: "Subtitle" as const,
              Codec: plan.subtitles.inputCodec,
            },
          ]
        : []),
    ],
  };
}

function planToPlaybackCandidate(
  itemId: string,
  plan: PlaybackPlan,
  baseUrl: string,
): PlaybackSourceCandidate {
  const url = makePlanUrlAbsolute(baseUrl, plan.delivery.url);
  const reason = plan.reasons.map((item) => item.message).join(" ");

  return {
    id: `custom-${plan.mode}-${plan.delivery.sessionId ?? "file"}`,
    itemId,
    mediaSourceId: plan.mediaId,
    playSessionId: plan.delivery.sessionId,
    mode: mapMode(plan),
    url,
    mimeType: getMimeType(plan),
    isHls: plan.delivery.type === "hls",
    hlsKind: mapHlsKind(plan),
    label: `Custom ${plan.mode}`,
    mediaSource: buildSyntheticMediaSource(plan),
    reason,
    transcodeReasons: plan.reasons.map((item) => item.code),
    priority: 0,
  };
}

export function isCustomPlaybackBackendConfigured(): boolean {
  return Boolean(getBackendUrl());
}

export function isCustomPlaybackCandidate(
  source: PlaybackSourceCandidate | null | undefined,
): boolean {
  return Boolean(source?.id.startsWith("custom-"));
}

async function getCachedClientCapabilities() {
  const now = Date.now();

  if (
    cachedCapabilities &&
    now - cachedCapabilities.testedAtMs < CAPABILITY_CACHE_TTL_MS
  ) {
    return cachedCapabilities.value;
  }

  if (!capabilityPromise) {
    capabilityPromise = buildClientCapabilities()
      .then((capabilities) => {
        cachedCapabilities = {
          testedAtMs: Date.now(),
          value: capabilities,
        };
        return capabilities;
      })
      .finally(() => {
        capabilityPromise = null;
      });
  }

  return capabilityPromise;
}

export async function requestCustomPlaybackCandidate(
  itemId: string,
): Promise<PlaybackSourceCandidate | null> {
  const baseUrl = getBackendUrl();

  if (!baseUrl) {
    return null;
  }

  const clientCapabilities = await getCachedClientCapabilities();
  const response = await fetch(buildPlaybackEndpoint(baseUrl), {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      mediaId: itemId,
      clientCapabilities,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Custom playback request failed with ${response.status}: ${text}`,
    );
  }

  const plan = (await response.json()) as PlaybackPlan;
  return planToPlaybackCandidate(itemId, plan, baseUrl);
}

export async function stopCustomPlaybackSession(
  source: PlaybackSourceCandidate | null | undefined,
  options: { keepalive?: boolean } = {},
): Promise<void> {
  const baseUrl = getBackendUrl();
  const sessionId = source?.playSessionId;

  if (!baseUrl || !sessionId || !isCustomPlaybackCandidate(source)) {
    return;
  }

  await fetch(buildSessionStopEndpoint(baseUrl, sessionId), {
    method: "POST",
    keepalive: options.keepalive,
  });
}
