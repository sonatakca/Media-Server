import type { TranslationKey } from "../i18n/translations";
import type { MediaItem } from "./types";

export const SEARCH_OVERLAY_OPEN_EVENT = "seyirlik:open-search";

export const MIN_SEARCH_QUERY_LENGTH = 2;
export const SEARCH_DEBOUNCE_MS = 220;

export type SearchGroupId = "movies" | "shows" | "episodes" | "books" | "other";

export interface SearchGroup {
  id: SearchGroupId;
  labelKey: TranslationKey;
  items: MediaItem[];
}

const GROUP_LABEL_KEYS: Record<SearchGroupId, TranslationKey> = {
  movies: "search.groupMovies",
  shows: "search.groupShows",
  episodes: "search.groupEpisodes",
  books: "search.groupBooks",
  other: "search.groupOther",
};

// Ordered by how often people search for each kind, so the most likely hit is
// the first thing under the cursor when the results land.
const GROUP_ORDER: SearchGroupId[] = [
  "movies",
  "shows",
  "episodes",
  "books",
  "other",
];

export function getSearchGroupId(item: MediaItem): SearchGroupId {
  switch (item.Type) {
    case "Movie":
      return "movies";
    case "Series":
      return "shows";
    case "Episode":
      return "episodes";
    case "Book":
      return "books";
    default:
      return "other";
  }
}

/** Buckets results by kind, dropping groups that matched nothing. */
export function groupSearchResults(items: MediaItem[]): SearchGroup[] {
  const buckets = new Map<SearchGroupId, MediaItem[]>();

  for (const item of items) {
    const groupId = getSearchGroupId(item);
    const bucket = buckets.get(groupId);

    if (bucket) {
      bucket.push(item);
    } else {
      buckets.set(groupId, [item]);
    }
  }

  return GROUP_ORDER.filter((groupId) => buckets.get(groupId)?.length).map(
    (groupId) => ({
      id: groupId,
      labelKey: GROUP_LABEL_KEYS[groupId],
      items: buckets.get(groupId) ?? [],
    }),
  );
}

/** Flattens groups back into the visual order, for arrow-key navigation. */
export function flattenSearchGroups(groups: SearchGroup[]): MediaItem[] {
  return groups.flatMap((group) => group.items);
}

export function isSearchableQuery(query: string): boolean {
  return query.trim().length >= MIN_SEARCH_QUERY_LENGTH;
}

export function openSearchOverlay(): void {
  if (typeof window === "undefined") {
    return;
  }

  window.dispatchEvent(new Event(SEARCH_OVERLAY_OPEN_EVENT));
}

/**
 * True for the Cmd+K / Ctrl+K chord that opens search from anywhere.
 */
export function isSearchShortcut(event: KeyboardEvent): boolean {
  return (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k";
}

/**
 * Typing into a field should never be hijacked by the shortcut-free "/" style
 * handlers, and the overlay must not open on top of an active text entry.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  const tagName = target.tagName;

  return (
    tagName === "INPUT" ||
    tagName === "TEXTAREA" ||
    tagName === "SELECT" ||
    Boolean(target.isContentEditable)
  );
}
