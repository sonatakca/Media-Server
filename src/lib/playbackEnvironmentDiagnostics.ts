import {
  getAuthHeaders,
  getAuthSession,
  getServerUrl,
} from "./authStorage";
import {
  buildJellyfinUrl,
  buildPlaybackCandidates,
  getPlaybackInfo,
  redactPlaybackUrl,
} from "./jellyfinApi";
import type { PlaybackSourceCandidate } from "./types";
import { buildClientCapabilities } from "./playback-planner/clientCapabilities";
import {
  getCustomPlaybackBackendUrl,
  requestCustomPlaybackCandidate,
  stopCustomPlaybackSession,
} from "./playback-planner/customPlaybackApi";

export type PlaybackHealthStatus = "pass" | "warn" | "fail" | "skip";

export interface PlaybackHealthProbe {
  id: string;
  label: string;
  status: PlaybackHealthStatus;
  message: string;
  url?: string;
  method?: string;
  statusCode?: number;
  durationMs?: number;
  headers?: Record<string, string | null>;
  bodyExcerpt?: string;
}

export interface PlaybackEndpointInfo {
  rawUrl: string | null;
  redactedUrl: string | null;
  origin: string | null;
  protocol: string | null;
  sameOrigin: boolean | null;
  mixedContentRisk: boolean;
}

export interface PlaybackEnvironmentContext {
  pageUrl: string;
  pageOrigin: string;
  pageProtocol: string;
  pageHostname: string;
  isSecureContext: boolean;
  userAgent: string;
  serviceWorkerAvailable: boolean;
  jellyfin: PlaybackEndpointInfo;
  customPlaybackBackend: PlaybackEndpointInfo;
  capabilities: {
    hlsNative: boolean;
    hlsNativeCanPlayType: string;
    mediaSource: boolean;
    managedMediaSource: boolean;
    directFileContainers: string[];
    mseContainers: string[];
  };
}

export interface PlaybackHealthSourceSummary {
  mode: PlaybackSourceCandidate["mode"];
  isHls: boolean;
  hlsKind?: PlaybackSourceCandidate["hlsKind"];
  mimeType?: string;
  url: string;
  mediaSourceId: string;
  directPlaySupported: boolean;
  directStreamSupported: boolean;
  transcodingSupported: boolean;
  transcodingUrlPresent: boolean;
  container?: string;
  videoCodec?: string;
  audioCodec?: string;
  reason?: string;
  diagnosticsPresent: boolean;
}

export interface PlaybackEnvironmentHealthReport {
  generatedAt: string;
  context: PlaybackEnvironmentContext;
  probes: PlaybackHealthProbe[];
  itemId?: string;
  jellyfinSource?: PlaybackHealthSourceSummary;
  customSource?: PlaybackHealthSourceSummary;
}

interface ProbeOptions {
  expectedStatuses?: number[];
  readBody?: boolean;
  bodyLimit?: number;
  timeoutMs?: number;
}

const DEFAULT_PROBE_TIMEOUT_MS = 8_000;
const BODY_EXCERPT_LIMIT = 1_200;
const HEADER_ALLOWLIST = [
  "access-control-allow-origin",
  "access-control-allow-methods",
  "access-control-allow-headers",
  "access-control-expose-headers",
  "accept-ranges",
  "content-length",
  "content-range",
  "content-type",
  "location",
  "vary",
];
const SENSITIVE_QUERY_KEYS = new Set([
  "api_key",
  "access_token",
  "x-emby-token",
  "apikey",
  "token",
]);

function getCurrentPageUrl(): string {
  if (typeof window === "undefined") {
    return "http://localhost/";
  }

  return window.location.href;
}

function getCurrentUserAgent(): string {
  if (typeof navigator === "undefined") {
    return "unknown";
  }

  return navigator.userAgent;
}

function getWindowSecureContext(): boolean {
  return typeof window !== "undefined" && window.isSecureContext === true;
}

function getServiceWorkerAvailability(): boolean {
  return typeof navigator !== "undefined" && "serviceWorker" in navigator;
}

function toUrl(value: string | null | undefined, base?: string): URL | null {
  if (!value) {
    return null;
  }

  try {
    return new URL(value, base);
  } catch {
    return null;
  }
}

export function redactDiagnosticsUrl(value: string | null | undefined): string {
  if (!value) {
    return "";
  }

  try {
    const url = new URL(value);

    for (const key of Array.from(url.searchParams.keys())) {
      if (SENSITIVE_QUERY_KEYS.has(key.toLowerCase())) {
        url.searchParams.set(key, "REDACTED");
      }
    }

    return redactPlaybackUrl(url.toString());
  } catch {
    return redactPlaybackUrl(value);
  }
}

export function hasMixedContentRisk(
  pageUrl: string,
  targetUrl: string | null | undefined,
): boolean {
  const page = toUrl(pageUrl);
  const target = toUrl(targetUrl ?? undefined, pageUrl);

  return Boolean(
    page?.protocol === "https:" &&
      target?.protocol === "http:" &&
      target.hostname !== "localhost" &&
      target.hostname !== "127.0.0.1",
  );
}

function buildEndpointInfo(
  rawUrl: string | null,
  pageUrl: string,
): PlaybackEndpointInfo {
  const page = toUrl(pageUrl);
  const target = toUrl(rawUrl, pageUrl);

  return {
    rawUrl,
    redactedUrl: rawUrl ? redactDiagnosticsUrl(rawUrl) : null,
    origin: target?.origin ?? null,
    protocol: target?.protocol ?? null,
    sameOrigin: page && target ? page.origin === target.origin : null,
    mixedContentRisk: hasMixedContentRisk(pageUrl, rawUrl),
  };
}

async function collectCapabilities(): Promise<
  PlaybackEnvironmentContext["capabilities"]
> {
  try {
    const capabilities = await buildClientCapabilities();
    const hlsNativeCanPlayType =
      typeof document !== "undefined"
        ? document
            .createElement("video")
            .canPlayType("application/vnd.apple.mpegurl")
        : "";

    return {
      hlsNative: capabilities.supportsHlsNative,
      hlsNativeCanPlayType,
      mediaSource: capabilities.supportsMediaSource,
      managedMediaSource: Boolean(capabilities.supportsManagedMediaSource),
      directFileContainers: capabilities.directFileContainers,
      mseContainers: capabilities.mseContainers,
    };
  } catch {
    return {
      hlsNative: false,
      hlsNativeCanPlayType: "",
      mediaSource: typeof MediaSource !== "undefined",
      managedMediaSource: "ManagedMediaSource" in globalThis,
      directFileContainers: [],
      mseContainers: [],
    };
  }
}

export async function buildPlaybackEnvironmentContext(): Promise<PlaybackEnvironmentContext> {
  const pageUrl = getCurrentPageUrl();
  const page = toUrl(pageUrl) ?? new URL("http://localhost/");
  const jellyfinBaseUrl = getServerUrl();
  const customPlaybackBackendUrl = getCustomPlaybackBackendUrl();
  const capabilities = await collectCapabilities();

  return {
    pageUrl,
    pageOrigin: page.origin,
    pageProtocol: page.protocol,
    pageHostname: page.hostname,
    isSecureContext: getWindowSecureContext(),
    userAgent: getCurrentUserAgent(),
    serviceWorkerAvailable: getServiceWorkerAvailability(),
    jellyfin: buildEndpointInfo(jellyfinBaseUrl, pageUrl),
    customPlaybackBackend: buildEndpointInfo(customPlaybackBackendUrl, pageUrl),
    capabilities,
  };
}

function collectHeaders(headers: Headers): Record<string, string | null> {
  return Object.fromEntries(
    HEADER_ALLOWLIST.map((header) => [header, headers.get(header)]),
  );
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    window.clearTimeout(timeoutId);
  }
}

async function probeFetch(
  id: string,
  label: string,
  url: string,
  init: RequestInit = {},
  options: ProbeOptions = {},
): Promise<PlaybackHealthProbe> {
  const startedAt = Date.now();
  const method = init.method ?? "GET";
  const expectedStatuses = options.expectedStatuses ?? [200, 204, 206];

  try {
    const response = await fetchWithTimeout(
      url,
      {
        ...init,
        cache: "no-store",
      },
      options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
    );
    const durationMs = Date.now() - startedAt;
    const headers = collectHeaders(response.headers);
    let bodyExcerpt: string | undefined;

    if (options.readBody) {
      const text = await response.text();
      bodyExcerpt = text.slice(0, options.bodyLimit ?? BODY_EXCERPT_LIMIT);
    }

    return {
      id,
      label,
      status: expectedStatuses.includes(response.status) ? "pass" : "fail",
      message: `${response.status} ${response.statusText}`,
      url: redactDiagnosticsUrl(url),
      method,
      statusCode: response.status,
      durationMs,
      headers,
      bodyExcerpt,
    };
  } catch (error) {
    return {
      id,
      label,
      status: "fail",
      message: error instanceof Error ? error.message : String(error),
      url: redactDiagnosticsUrl(url),
      method,
      durationMs: Date.now() - startedAt,
    };
  }
}

function pushSkippedProbe(
  probes: PlaybackHealthProbe[],
  id: string,
  label: string,
  message: string,
) {
  probes.push({
    id,
    label,
    status: "skip",
    message,
  });
}

function getStreamCodec(
  source: PlaybackSourceCandidate,
  type: "Video" | "Audio",
): string | undefined {
  return source.mediaSource.MediaStreams?.find(
    (stream) => stream.Type === type,
  )?.Codec;
}

function summarizeSource(
  source: PlaybackSourceCandidate,
): PlaybackHealthSourceSummary {
  return {
    mode: source.mode,
    isHls: source.isHls,
    hlsKind: source.hlsKind,
    mimeType: source.mimeType,
    url: redactDiagnosticsUrl(source.url),
    mediaSourceId: source.mediaSourceId ?? source.mediaSource.Id ?? "unknown",
    directPlaySupported: Boolean(source.mediaSource.SupportsDirectPlay),
    directStreamSupported: Boolean(source.mediaSource.SupportsDirectStream),
    transcodingSupported: Boolean(source.mediaSource.SupportsTranscoding),
    transcodingUrlPresent: Boolean(source.mediaSource.TranscodingUrl),
    container: source.mediaSource.Container,
    videoCodec: getStreamCodec(source, "Video"),
    audioCodec: getStreamCodec(source, "Audio"),
    reason: source.reason,
    diagnosticsPresent: Boolean(source.playbackDiagnostics),
  };
}

export function getFirstLocalHlsUri(playlist: string): string | null {
  for (const line of playlist.split(/\r?\n/)) {
    const trimmedLine = line.trim();

    if (!trimmedLine || trimmedLine.startsWith("#")) {
      continue;
    }

    if (
      trimmedLine.includes("://") ||
      trimmedLine.startsWith("//") ||
      trimmedLine.startsWith("data:")
    ) {
      continue;
    }

    return trimmedLine;
  }

  return null;
}

function resolveRelativeMediaUrl(baseUrl: string, relativeUrl: string): string {
  return new URL(relativeUrl, baseUrl).toString();
}

async function probeMediaSource(
  probes: PlaybackHealthProbe[],
  source: PlaybackSourceCandidate,
  prefix: string,
) {
  if (source.isHls) {
    const manifestProbe = await probeFetch(
      `${prefix}Manifest`,
      `${prefix} HLS manifest`,
      source.url,
      {
        headers: {
          Accept: "application/vnd.apple.mpegurl,*/*",
        },
      },
      { readBody: true, expectedStatuses: [200, 206] },
    );

    probes.push(manifestProbe);

    if (manifestProbe.status !== "pass" || !manifestProbe.bodyExcerpt) {
      return;
    }

    const segmentUri = getFirstLocalHlsUri(manifestProbe.bodyExcerpt);

    if (!segmentUri) {
      pushSkippedProbe(
        probes,
        `${prefix}Segment`,
        `${prefix} first HLS segment`,
        "No local HLS segment URI was present in the manifest excerpt.",
      );
      return;
    }

    probes.push(
      await probeFetch(
        `${prefix}Segment`,
        `${prefix} first HLS segment`,
        resolveRelativeMediaUrl(source.url, segmentUri),
        {
          headers: {
            Range: "bytes=0-1023",
          },
        },
        { expectedStatuses: [200, 206] },
      ),
    );
    return;
  }

  probes.push(
    await probeFetch(
      `${prefix}DirectMedia`,
      `${prefix} direct media range`,
      source.url,
      {
        headers: {
          Range: "bytes=0-1023",
        },
      },
      { expectedStatuses: [200, 206] },
    ),
  );
}

async function probeJellyfinPlayback(
  probes: PlaybackHealthProbe[],
  itemId: string,
): Promise<PlaybackHealthSourceSummary | undefined> {
  const startedAt = Date.now();

  try {
    const playbackInfo = await getPlaybackInfo(itemId);
    const candidates = buildPlaybackCandidates(itemId, playbackInfo);
    const source = candidates[0];

    probes.push({
      id: "jellyfinPlaybackInfo",
      label: "Jellyfin PlaybackInfo",
      status: source ? "pass" : "fail",
      message: source
        ? `${playbackInfo.MediaSources?.length ?? 0} media source(s), ${candidates.length} candidate(s)`
        : "PlaybackInfo returned no playable candidates.",
      durationMs: Date.now() - startedAt,
    });

    if (!source) {
      return undefined;
    }

    await probeMediaSource(probes, source, "jellyfin");
    return summarizeSource(source);
  } catch (error) {
    probes.push({
      id: "jellyfinPlaybackInfo",
      label: "Jellyfin PlaybackInfo",
      status: "fail",
      message: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - startedAt,
    });
    return undefined;
  }
}

async function probeCustomPlayback(
  probes: PlaybackHealthProbe[],
  itemId: string,
): Promise<PlaybackHealthSourceSummary | undefined> {
  const startedAt = Date.now();
  let source: PlaybackSourceCandidate | null = null;

  try {
    source = await requestCustomPlaybackCandidate(itemId);

    probes.push({
      id: "customPlaybackRequest",
      label: "Custom playback request",
      status: source ? "pass" : "fail",
      message: source
        ? `${source.mode}${source.isHls ? " HLS" : ""}${source.playbackDiagnostics ? " with diagnostics" : " without diagnostics"}`
        : "Custom playback backend returned no source.",
      durationMs: Date.now() - startedAt,
    });

    if (!source) {
      return undefined;
    }

    await probeMediaSource(probes, source, "custom");
    return summarizeSource(source);
  } catch (error) {
    probes.push({
      id: "customPlaybackRequest",
      label: "Custom playback request",
      status: "fail",
      message: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - startedAt,
    });
    return undefined;
  } finally {
    if (source) {
      void stopCustomPlaybackSession(source).catch((error) => {
        console.warn(
          "[Seyirlik Playback Diagnostics] Could not stop probe session",
          error,
        );
      });
    }
  }
}

export async function runPlaybackEnvironmentHealthCheck(
  itemId?: string,
): Promise<PlaybackEnvironmentHealthReport> {
  const context = await buildPlaybackEnvironmentContext();
  const probes: PlaybackHealthProbe[] = [];
  const session = getAuthSession();
  const jellyfinBaseUrl = getServerUrl();
  const customBackendUrl = getCustomPlaybackBackendUrl();
  const normalizedItemId = itemId?.trim();

  if (jellyfinBaseUrl) {
    probes.push(
      await probeFetch(
        "jellyfinPublic",
        "Jellyfin public API",
        buildJellyfinUrl(jellyfinBaseUrl, "/System/Info/Public"),
        {
          headers: {
            Accept: "application/json",
          },
        },
        { readBody: true },
      ),
    );
  } else {
    pushSkippedProbe(
      probes,
      "jellyfinPublic",
      "Jellyfin public API",
      "No Jellyfin server URL is configured.",
    );
  }

  if (jellyfinBaseUrl && session?.userId && session.accessToken) {
    probes.push(
      await probeFetch(
        "jellyfinAuthenticated",
        "Authenticated Jellyfin API",
        buildJellyfinUrl(
          jellyfinBaseUrl,
          `/Users/${encodeURIComponent(session.userId)}/Items`,
          { Limit: 1 },
        ),
        {
          headers: {
            Accept: "application/json",
            ...getAuthHeaders(),
          },
        },
        { readBody: true },
      ),
    );
  } else {
    pushSkippedProbe(
      probes,
      "jellyfinAuthenticated",
      "Authenticated Jellyfin API",
      "No authenticated Jellyfin session is available.",
    );
  }

  if (customBackendUrl) {
    probes.push(
      await probeFetch(
        "customBackendHealth",
        "Custom playback backend health",
        `${customBackendUrl}/health`,
        {
          headers: {
            Accept: "application/json",
          },
        },
        { readBody: true },
      ),
    );
  } else {
    pushSkippedProbe(
      probes,
      "customBackendHealth",
      "Custom playback backend health",
      "VITE_SEYIRLIK_PLAYBACK_BACKEND_URL is not configured.",
    );
  }

  let jellyfinSource: PlaybackHealthSourceSummary | undefined;
  let customSource: PlaybackHealthSourceSummary | undefined;

  if (normalizedItemId) {
    jellyfinSource = await probeJellyfinPlayback(probes, normalizedItemId);

    if (customBackendUrl) {
      customSource = await probeCustomPlayback(probes, normalizedItemId);
    }
  } else {
    pushSkippedProbe(
      probes,
      "jellyfinPlaybackInfo",
      "Jellyfin PlaybackInfo",
      "Enter a media item id to test item-specific playback.",
    );
    pushSkippedProbe(
      probes,
      "customPlaybackRequest",
      "Custom playback request",
      "Enter a media item id to test item-specific playback.",
    );
  }

  return {
    generatedAt: new Date().toISOString(),
    context,
    probes,
    itemId: normalizedItemId || undefined,
    jellyfinSource,
    customSource,
  };
}
