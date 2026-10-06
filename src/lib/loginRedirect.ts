/**
 * Where to go after signing in.
 *
 * A shared link opened while signed out is sent to `/login?next=<that link>`,
 * and sign-in returns there instead of to `/home`. `next` arrives in the URL,
 * so it is untrusted: only a path on this same origin is ever followed, which
 * keeps the login page from becoming an open redirect.
 */

export const LOGIN_NEXT_PARAM = "next";
export const DEFAULT_AFTER_LOGIN_PATH = "/home";

interface LocationLike {
  pathname: string;
  search?: string;
  hash?: string;
}

/** The login URL that brings the reader back to `location` afterwards. */
export function loginPathFor(location: LocationLike): string {
  const target = `${location.pathname}${location.search ?? ""}${location.hash ?? ""}`;
  if (safeAfterLoginPath(target) === null) return "/login";
  return `/login?${LOGIN_NEXT_PARAM}=${encodeURIComponent(target)}`;
}

/**
 * `candidate` as a same-origin path, or null when it is missing, points
 * elsewhere, or leads straight back to the login page.
 */
export function safeAfterLoginPath(
  candidate: string | null | undefined,
): string | null {
  if (!candidate || !candidate.startsWith("/")) return null;
  // "//host" and "/\host" are protocol-relative to browsers.
  if (candidate.startsWith("//") || candidate.startsWith("/\\")) return null;

  let parsed: URL;
  try {
    parsed = new URL(candidate, "https://seyirlik.invalid");
  } catch {
    return null;
  }
  if (parsed.origin !== "https://seyirlik.invalid") return null;
  if (parsed.pathname === "/login" || parsed.pathname === "/") return null;

  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

/** Where sign-in should land, given the login page's own query string. */
export function afterLoginPath(search: string): string {
  const next = new URLSearchParams(search).get(LOGIN_NEXT_PARAM);
  return safeAfterLoginPath(next) ?? DEFAULT_AFTER_LOGIN_PATH;
}
