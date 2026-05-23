import { DEFAULT_SEO_TITLE, setSeoMetadata } from "./seo";

const DEFAULT_TITLE = DEFAULT_SEO_TITLE;
const LOADING_PREFIX = "· ";

let lastRealTitle = DEFAULT_TITLE;

function clean(title: string): string {
  return title.trim() || DEFAULT_TITLE;
}

function withLoadingDot(title: string): string {
  const cleanTitle = clean(title);

  return cleanTitle.startsWith(LOADING_PREFIX)
    ? cleanTitle
    : `${LOADING_PREFIX}${cleanTitle}`;
}

export function setPageTitle(title: string): void {
  const nextTitle = clean(title);
  lastRealTitle = nextTitle;
  setSeoMetadata({ title: nextTitle });
}

export function setDefaultPageTitle(isLoading = false): void {
  const nextTitle = DEFAULT_TITLE;
  lastRealTitle = nextTitle;
  if (isLoading) {
    document.title = withLoadingDot(nextTitle);
    return;
  }

  setSeoMetadata({ title: nextTitle, canonicalPath: "/" });
}

export function setLoadingPageTitle(title?: string): void {
  const baseTitle = title?.trim() ? title.trim() : lastRealTitle;
  document.title = withLoadingDot(baseTitle);
}
