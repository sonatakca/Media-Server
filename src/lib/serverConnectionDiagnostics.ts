import { getServerUrl, normalizeServerUrl } from "./authStorage";
import { buildJellyfinUrl, type JellyfinServerUnavailableEventDetail } from "./jellyfinApi";
import { getCustomPlaybackBackendUrl } from "./playback-planner/customPlaybackApi";

export type ServerProbeKind =
  | "jellyfin"
  | "opaque-reachable"
  | "cloudflare-bad-gateway"
  | "cloudflare-tunnel-error"
  | "cloudflare-error"
  | "http-ok"
  | "http-error"
  | "network-error"
  | "not-configured";

export interface ServerProbe {
  url: string;
  endpoint?: string;
  ok: boolean;
  reachable: boolean;
  kind: ServerProbeKind;
  status?: number;
  statusText?: string;
  message?: string;
  productName?: string;
}

export type ServerConnectionProblem =
  | "none"
  | "jellyfin-down"
  | "cloudflared-down"
  | "both-down"
  | "tunnel-origin-error"
  | "unknown";

export interface ServerConnectionDiagnosis {
  problem: ServerConnectionProblem;
  serverUrl: string;
  checkedAt: string;
  source: "backend" | "browser";
  publicProbe: ServerProbe;
  localProbe: ServerProbe | null;
  localProbeUrls: string[];
}

interface BackendDiagnosticsResponse {
  publicProbe?: ServerProbe;
  localProbe?: ServerProbe | null;
  localProbeUrls?: string[];
  checkedAt?: string;
}

interface DiagnoseServerConnectionOptions {
  serverUrl?: string | null;
  failure?: JellyfinServerUnavailableEventDetail | null;
}

const DIAGNOSTIC_TIMEOUT_MS = 3500;
const JELLYFIN_DEFAULT_PORT = "8096";

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split(".").map((part) => Number(part));

  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }

  const [first, second] = parts;
  return (
    first === 10 ||
    first === 127 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

function isLocalHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "localhost" ||
    normalized.endsWith(".local") ||
    normalized === "::1" ||
    isPrivateIpv4(normalized)
  );
}

function splitUrlList(rawValue: string | undefined): string[] {
  return (
    rawValue
      ?.split(",")
      .map((value) => value.trim())
      .filter(Boolean) ?? []
  );
}

function addUrl(urls: string[], rawUrl: string | undefined): void {
  if (!rawUrl) {
    return;
  }

  try {
    const normalizedUrl = normalizeServerUrl(rawUrl);

    if (!urls.includes(normalizedUrl)) {
      urls.push(normalizedUrl);
    }
  } catch {
    // Ignore invalid optional diagnostic URLs.
  }
}

function getCurrentPageHostname(): string | null {
  if (typeof window === "undefined") {
    return null;
  }

  return window.location.hostname || null;
}

function getLocalProbeUrls(serverUrl: string): string[] {
  const urls: string[] = [];

  addUrl(urls, import.meta.env.VITE_LOCAL_JELLYFIN_SERVER_URL);
  splitUrlList(import.meta.env.VITE_JELLYFIN_LOCAL_PROBE_URLS).forEach((url) =>
    addUrl(urls, url),
  );

  try {
    const parsedServerUrl = new URL(serverUrl);

    if (isLocalHostname(parsedServerUrl.hostname)) {
      addUrl(urls, serverUrl);
    }
  } catch {
    // The caller already normalizes serverUrl. This is only defensive.
  }

  const currentHostname = getCurrentPageHostname();

  if (currentHostname && isLocalHostname(currentHostname)) {
    addUrl(urls, `http://${currentHostname}:${JELLYFIN_DEFAULT_PORT}`);
  }

  addUrl(urls, `http://127.0.0.1:${JELLYFIN_DEFAULT_PORT}`);
  addUrl(urls, `http://localhost:${JELLYFIN_DEFAULT_PORT}`);

  return urls;
}

function createAbortController(timeoutMs: number): {
  controller: AbortController;
  cancel: () => void;
} {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  return {
    controller,
    cancel: () => window.clearTimeout(timeoutId),
  };
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = DIAGNOSTIC_TIMEOUT_MS,
): Promise<Response> {
  const { controller, cancel } = createAbortController(timeoutMs);

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    cancel();
  }
}

function detectProbeKind(
  status: number,
  statusText: string,
  bodyText: string,
): ServerProbeKind {
  const searchableText = `${statusText}\n${bodyText}`;

  if (status === 502 || /bad gateway|error code 502/i.test(searchableText)) {
    return "cloudflare-bad-gateway";
  }

  if (
    status === 530 ||
    /error 1033|cloudflare tunnel error/i.test(searchableText)
  ) {
    return "cloudflare-tunnel-error";
  }

  if (/cloudflare/i.test(searchableText)) {
    return "cloudflare-error";
  }

  return "http-error";
}

function getJellyfinProductName(bodyText: string): string | undefined {
  try {
    const json = JSON.parse(bodyText) as {
      ProductName?: string;
      ServerName?: string;
    };

    return json.ProductName || json.ServerName;
  } catch {
    return undefined;
  }
}

async function probeCorsJellyfinUrl(rawServerUrl: string): Promise<ServerProbe> {
  const serverUrl = normalizeServerUrl(rawServerUrl);
  const endpoint = buildJellyfinUrl(serverUrl, "/System/Info/Public", {
    seyirlikDiagnostics: Date.now(),
  });

  try {
    const response = await fetchWithTimeout(endpoint, {
      cache: "no-store",
      headers: {
        Accept: "application/json, text/html;q=0.8",
      },
    });
    const bodyText = await response.text().catch(() => "");

    if (response.ok) {
      return {
        url: serverUrl,
        endpoint,
        ok: true,
        reachable: true,
        kind: getJellyfinProductName(bodyText) ? "jellyfin" : "http-ok",
        status: response.status,
        statusText: response.statusText,
        productName: getJellyfinProductName(bodyText),
      };
    }

    return {
      url: serverUrl,
      endpoint,
      ok: false,
      reachable: true,
      kind: detectProbeKind(response.status, response.statusText, bodyText),
      status: response.status,
      statusText: response.statusText,
      message: bodyText || `${response.status} ${response.statusText}`,
    };
  } catch (error) {
    return {
      url: serverUrl,
      endpoint,
      ok: false,
      reachable: false,
      kind: "network-error",
      message: getErrorMessage(error),
    };
  }
}

async function probeOpaqueReachability(
  rawServerUrl: string,
): Promise<ServerProbe> {
  const serverUrl = normalizeServerUrl(rawServerUrl);
  const endpoint = buildJellyfinUrl(serverUrl, "/System/Info/Public", {
    seyirlikDiagnostics: Date.now(),
  });

  try {
    await fetchWithTimeout(endpoint, {
      cache: "no-store",
      mode: "no-cors",
    });

    return {
      url: serverUrl,
      endpoint,
      ok: true,
      reachable: true,
      kind: "opaque-reachable",
      message:
        "The browser could reach this local endpoint, but CORS hid the response body.",
    };
  } catch (error) {
    return {
      url: serverUrl,
      endpoint,
      ok: false,
      reachable: false,
      kind: "network-error",
      message: getErrorMessage(error),
    };
  }
}

async function probeLocalJellyfinUrl(rawServerUrl: string): Promise<ServerProbe> {
  const corsProbe = await probeCorsJellyfinUrl(rawServerUrl);

  if (corsProbe.ok || corsProbe.reachable) {
    return corsProbe;
  }

  return probeOpaqueReachability(rawServerUrl);
}

async function findReachableLocalProbe(
  localProbeUrls: string[],
): Promise<ServerProbe | null> {
  if (localProbeUrls.length === 0) {
    return null;
  }

  let lastProbe: ServerProbe | null = null;

  for (const url of localProbeUrls) {
    const probe = await probeLocalJellyfinUrl(url);
    lastProbe = probe;

    if (isProbeOnline(probe)) {
      return probe;
    }
  }

  return lastProbe;
}

function isProbeOnline(probe: ServerProbe | null | undefined): boolean {
  return Boolean(
    probe &&
      probe.reachable &&
      (probe.ok || probe.kind === "opaque-reachable" || probe.kind === "http-ok"),
  );
}

function getProbeFromFailure(
  serverUrl: string,
  failure: JellyfinServerUnavailableEventDetail | null | undefined,
): ServerProbe | null {
  if (!failure?.status) {
    return null;
  }

  return {
    url: failure.serverUrl || serverUrl,
    endpoint: failure.requestUrl,
    ok: false,
    reachable: true,
    kind: detectProbeKind(
      failure.status,
      failure.statusText ?? "",
      failure.message ?? "",
    ),
    status: failure.status,
    statusText: failure.statusText,
    message: failure.message,
  };
}

function classifyServerConnection(
  publicProbe: ServerProbe,
  localProbe: ServerProbe | null,
): ServerConnectionProblem {
  if (isProbeOnline(publicProbe)) {
    return "none";
  }

  const localOnline = isProbeOnline(localProbe);

  if (publicProbe.kind === "cloudflare-bad-gateway") {
    return localOnline ? "tunnel-origin-error" : "jellyfin-down";
  }

  if (localOnline) {
    return "cloudflared-down";
  }

  if (
    publicProbe.kind === "cloudflare-tunnel-error" ||
    publicProbe.kind === "cloudflare-error" ||
    publicProbe.kind === "network-error" ||
    publicProbe.kind === "http-error"
  ) {
    return "both-down";
  }

  return "unknown";
}

function normalizeBackendProbe(value: unknown): ServerProbe | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const probe = value as Partial<ServerProbe>;

  if (typeof probe.url !== "string" || typeof probe.kind !== "string") {
    return null;
  }

  return {
    url: probe.url,
    endpoint: probe.endpoint,
    ok: Boolean(probe.ok),
    reachable: Boolean(probe.reachable),
    kind: probe.kind as ServerProbeKind,
    status: probe.status,
    statusText: probe.statusText,
    message: probe.message,
    productName: probe.productName,
  };
}

async function diagnoseViaBackend(
  serverUrl: string,
): Promise<ServerConnectionDiagnosis | null> {
  const backendUrl = getCustomPlaybackBackendUrl();

  if (!backendUrl) {
    return null;
  }

  const endpoint = new URL("/api/server-diagnostics", `${backendUrl}/`);
  endpoint.searchParams.set("serverUrl", serverUrl);

  try {
    const response = await fetchWithTimeout(endpoint.toString(), {
      cache: "no-store",
      headers: {
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      return null;
    }

    const payload = (await response.json()) as BackendDiagnosticsResponse;
    const publicProbe = normalizeBackendProbe(payload.publicProbe);

    if (!publicProbe) {
      return null;
    }

    const localProbe = normalizeBackendProbe(payload.localProbe);
    const localProbeUrls =
      payload.localProbeUrls?.filter((url) => typeof url === "string") ?? [];

    return {
      problem: classifyServerConnection(publicProbe, localProbe),
      serverUrl,
      checkedAt: payload.checkedAt ?? new Date().toISOString(),
      source: "backend",
      publicProbe,
      localProbe,
      localProbeUrls,
    };
  } catch {
    return null;
  }
}

export async function diagnoseServerConnection({
  serverUrl,
  failure,
}: DiagnoseServerConnectionOptions = {}): Promise<ServerConnectionDiagnosis> {
  const normalizedServerUrl = normalizeServerUrl(serverUrl ?? getServerUrl() ?? "");
  const backendDiagnosis = await diagnoseViaBackend(normalizedServerUrl);

  if (backendDiagnosis) {
    return backendDiagnosis;
  }

  const failureProbe = getProbeFromFailure(normalizedServerUrl, failure);
  const [publicProbe, localProbeUrls] = await Promise.all([
    failureProbe
      ? Promise.resolve(failureProbe)
      : probeCorsJellyfinUrl(normalizedServerUrl),
    Promise.resolve(getLocalProbeUrls(normalizedServerUrl)),
  ]);
  const localProbe = await findReachableLocalProbe(localProbeUrls);

  return {
    problem: classifyServerConnection(publicProbe, localProbe),
    serverUrl: normalizedServerUrl,
    checkedAt: new Date().toISOString(),
    source: "browser",
    publicProbe,
    localProbe,
    localProbeUrls,
  };
}

export function probeIsOnline(probe: ServerProbe | null | undefined): boolean {
  return isProbeOnline(probe);
}
