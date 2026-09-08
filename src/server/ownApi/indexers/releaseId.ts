/**
 * The identifier a provider will accept back, taken from the guid it gave.
 *
 * Newznab guids are written two ways. Some providers return a bare identifier;
 * others return the details URL it belongs to, and NZBgeek is one of them. The
 * `t=get` call wants the identifier either way, so the last path segment is
 * taken when the guid is a URL.
 *
 * Deliberately does not accept a URL as *input to a request*. A caller that
 * could hand over the URL could hand over any URL, and the request this
 * identifier ends up in carries the provider's API key.
 */
export function releaseIdFromGuid(guid: string): string | undefined {
  const trimmed = typeof guid === "string" ? guid.trim() : "";
  if (!trimmed) return undefined;

  let candidate = trimmed;
  if (/^https?:\/\//i.test(trimmed)) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      return undefined;
    }
    // Some providers put the id in the query rather than the path.
    const fromQuery =
      url.searchParams.get("id") ?? url.searchParams.get("guid");
    const fromPath = url.pathname.split("/").filter(Boolean).pop();
    candidate = (fromQuery ?? fromPath ?? "").trim();
  }

  // Whatever it came from, it has to look like an identifier and nothing else:
  // it is about to become a query parameter on an authenticated request.
  return /^[A-Za-z0-9._~-]{1,200}$/.test(candidate) ? candidate : undefined;
}
