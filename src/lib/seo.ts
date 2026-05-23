export const SITE_URL = "https://www.seyirlik.sonatakca.com/";

export const DEFAULT_SEO_TITLE = "Seyirlik — Modern Jellyfin Media Client";

export const DEFAULT_SEO_DESCRIPTION =
  "Seyirlik is a modern web frontend for Jellyfin, built for browsing movies, TV shows, playback diagnostics, and a cinematic media experience.";

interface SeoMetadataInput {
  title?: string;
  description?: string;
  canonicalPath?: string;
  robots?: "index, follow" | "noindex, nofollow";
}

function getCanonicalUrl(path?: string): string {
  if (!path) {
    return new URL(window.location.pathname || "/", SITE_URL).toString();
  }

  return new URL(path, SITE_URL).toString();
}

function ensureMeta(selector: string, attributes: Record<string, string>) {
  const existing = document.head.querySelector<HTMLMetaElement>(selector);

  if (existing) {
    return existing;
  }

  const meta = document.createElement("meta");

  for (const [key, value] of Object.entries(attributes)) {
    meta.setAttribute(key, value);
  }

  document.head.appendChild(meta);
  return meta;
}

function setMetaContent(
  selector: string,
  attributes: Record<string, string>,
  content: string,
) {
  const meta = ensureMeta(selector, attributes);
  meta.setAttribute("content", content);
}

function ensureCanonicalLink() {
  const existing =
    document.head.querySelector<HTMLLinkElement>("link[rel='canonical']");

  if (existing) {
    return existing;
  }

  const link = document.createElement("link");
  link.setAttribute("rel", "canonical");
  document.head.appendChild(link);
  return link;
}

export function setSeoMetadata({
  title = DEFAULT_SEO_TITLE,
  description = DEFAULT_SEO_DESCRIPTION,
  canonicalPath,
  robots = "index, follow",
}: SeoMetadataInput): void {
  if (typeof document === "undefined" || typeof window === "undefined") {
    return;
  }

  const canonicalUrl = getCanonicalUrl(canonicalPath);

  document.title = title;
  setMetaContent("meta[name='description']", { name: "description" }, description);
  setMetaContent("meta[name='robots']", { name: "robots" }, robots);
  ensureCanonicalLink().setAttribute("href", canonicalUrl);
  setMetaContent("meta[property='og:title']", { property: "og:title" }, title);
  setMetaContent(
    "meta[property='og:description']",
    { property: "og:description" },
    description,
  );
  setMetaContent("meta[property='og:url']", { property: "og:url" }, canonicalUrl);
  setMetaContent("meta[name='twitter:title']", { name: "twitter:title" }, title);
  setMetaContent(
    "meta[name='twitter:description']",
    { name: "twitter:description" },
    description,
  );
}
