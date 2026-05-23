import {
  DEFAULT_SEO_TITLE,
  PUBLIC_HOME_CANONICAL_PATH,
  PUBLIC_OG_LOCALE,
  PUBLIC_SEO_LANG,
  SEO_ROBOTS,
  setSeoMetadata,
  type RobotsDirective,
} from "./seo";

const DEFAULT_TITLE = DEFAULT_SEO_TITLE;
const LOADING_PREFIX = "· ";

interface PageTitleOptions {
  description?: string;
  canonicalPath?: string;
  robots?: RobotsDirective;
  lang?: string;
  ogLocale?: string;
}

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

export function setPageTitle(title: string, options?: PageTitleOptions): void {
  const nextTitle = clean(title);
  lastRealTitle = nextTitle;
  setSeoMetadata({ title: nextTitle, ...options });
}

export function setDefaultPageTitle(isLoading = false): void {
  const nextTitle = DEFAULT_TITLE;
  lastRealTitle = nextTitle;
  if (isLoading) {
    document.title = withLoadingDot(nextTitle);
    return;
  }

  setSeoMetadata({
    title: nextTitle,
    canonicalPath: PUBLIC_HOME_CANONICAL_PATH,
    robots: SEO_ROBOTS.index,
    lang: PUBLIC_SEO_LANG,
    ogLocale: PUBLIC_OG_LOCALE,
  });
}

export function setLoadingPageTitle(title?: string): void {
  const baseTitle = title?.trim() ? title.trim() : lastRealTitle;
  document.title = withLoadingDot(baseTitle);
}
