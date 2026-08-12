/**
 * Browser-side session state.
 *
 * Seyirlik authenticates with an `HttpOnly` cookie the page cannot read, so
 * nothing secret is stored here. What remains is a cache of who is signed in,
 * used to render the shell before `/auth/me` resolves and to decide whether to
 * show the login route at all.
 *
 * There is no server URL and no access token: the API is served from the page's
 * own origin, and the session cookie is the only credential.
 */

const SESSION_STORAGE_KEY = "seyirlik.session";

export interface CachedSession {
  userId: string;
  username: string;
  displayName: string;
  isAdministrator: boolean;
}

function readStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    // Private-mode browsers can throw on access; the app still works, it just
    // has to wait for `/auth/me` on every load.
    return null;
  }
}

export function getCachedSession(): CachedSession | null {
  const storage = readStorage();
  if (!storage) return null;

  try {
    const raw = storage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as Partial<CachedSession>;
    if (
      typeof parsed.userId !== "string" ||
      typeof parsed.username !== "string"
    ) {
      return null;
    }

    return {
      userId: parsed.userId,
      username: parsed.username,
      displayName: parsed.displayName ?? parsed.username,
      isAdministrator: parsed.isAdministrator === true,
    };
  } catch {
    return null;
  }
}

export function setCachedSession(session: CachedSession): void {
  readStorage()?.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
}

export function clearCachedSession(): void {
  readStorage()?.removeItem(SESSION_STORAGE_KEY);
}

export function setAuthSession(session: {
  userId: string;
  username: string;
  displayName?: string;
  isAdministrator?: boolean;
}): void {
  setCachedSession({
    userId: session.userId,
    username: session.username,
    displayName: session.displayName ?? session.username,
    isAdministrator: session.isAdministrator === true,
  });
}

export function clearAuthSession(): void {
  clearCachedSession();
}

/**
 * Whether the browser believes it has a session. This is a hint for routing
 * only — the server re-checks the cookie on every request, so a stale cache
 * results in a 401 and a redirect, never in unauthorized access.
 */
export function isAuthenticated(): boolean {
  return getCachedSession() !== null;
}

export function isAdministrator(): boolean {
  return getCachedSession()?.isAdministrator === true;
}
