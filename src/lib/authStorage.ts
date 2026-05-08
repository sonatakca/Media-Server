import { getDeviceName, getOrCreateDeviceId } from "./device";
import type { AuthSession } from "./types";

const SERVER_URL_KEY = "seyirlik.serverUrl";
const AUTH_SESSION_KEY = "seyirlik.authSession";

export const JELLYFIN_CLIENT_NAME = "Seyirlik Web";
export const JELLYFIN_CLIENT_VERSION = "0.1.0";

export function normalizeServerUrl(rawServerUrl: string): string {
  const trimmed = rawServerUrl.trim();

  if (!trimmed) {
    throw new Error("Enter your Jellyfin server URL.");
  }

  let parsed: URL;

  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Enter a valid URL that starts with http:// or https://.");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Jellyfin server URL must start with http:// or https://.");
  }

  parsed.hash = "";
  parsed.search = "";

  return parsed.toString().replace(/\/+$/, "");
}

export function saveNormalizedServerUrl(normalizedServerUrl: string): string {
  const safeServerUrl = normalizeServerUrl(normalizedServerUrl);
  localStorage.setItem(SERVER_URL_KEY, safeServerUrl);
  return safeServerUrl;
}

export function getServerUrl(): string | null {
  return localStorage.getItem(SERVER_URL_KEY);
}

export function setServerUrl(serverUrl: string): string {
  const normalizedServerUrl = normalizeServerUrl(serverUrl);
  localStorage.setItem(SERVER_URL_KEY, normalizedServerUrl);
  return normalizedServerUrl;
}

export function clearServerUrl(): void {
  localStorage.removeItem(SERVER_URL_KEY);
}

export function getAuthSession(): AuthSession | null {
  const rawSession = localStorage.getItem(AUTH_SESSION_KEY);

  if (!rawSession) {
    return null;
  }

  try {
    const session = JSON.parse(rawSession) as Partial<AuthSession>;

    if (
      typeof session.serverUrl !== "string" ||
      typeof session.accessToken !== "string" ||
      typeof session.userId !== "string" ||
      typeof session.username !== "string" ||
      typeof session.deviceId !== "string"
    ) {
      return null;
    }

    return session as AuthSession;
  } catch {
    return null;
  }
}

export function setAuthSession(session: AuthSession): void {
  const normalizedSession: AuthSession = {
    ...session,
    serverUrl: normalizeServerUrl(session.serverUrl),
    deviceId: session.deviceId || getOrCreateDeviceId(),
  };

  localStorage.setItem(AUTH_SESSION_KEY, JSON.stringify(normalizedSession));
  localStorage.setItem(SERVER_URL_KEY, normalizedSession.serverUrl);
}

export function clearAuthSession(): void {
  localStorage.removeItem(AUTH_SESSION_KEY);
}

export function isAuthenticated(): boolean {
  const session = getAuthSession();
  return Boolean(session?.accessToken && session.userId);
}

export function createJellyfinAuthorizationHeader(token?: string): string {
  const tokenPart = token ? `, Token="${token}"` : "";

  return `MediaBrowser Client="${JELLYFIN_CLIENT_NAME}", Device="${getDeviceName()}", DeviceId="${getOrCreateDeviceId()}", Version="${JELLYFIN_CLIENT_VERSION}"${tokenPart}`;
}

export function getAuthHeaders(): Record<string, string> {
  const session = getAuthSession();

  if (!session?.accessToken) {
    return {};
  }

  return {
    Authorization: createJellyfinAuthorizationHeader(session.accessToken),
    "X-Emby-Authorization": createJellyfinAuthorizationHeader(session.accessToken),
    "X-Emby-Token": session.accessToken,
  };
}
