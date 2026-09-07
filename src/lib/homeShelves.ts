import { applyCuration, type CuratedList } from "./curation";
import type { MediaItem } from "./types";

/**
 * How many titles a Latest row renders.
 *
 * The row draws from the whole library now rather than from a forty-item
 * server page, so the cap moved here. It is applied *after* the ordering, so a
 * hand-placed title reaches the row from anywhere in the catalogue.
 */
export const HOME_ROW_LIMIT = 40;

function addedAt(item: MediaItem): number {
  return Date.parse(item.DateCreated ?? item.PremiereDate ?? "1970-01-01");
}

/**
 * Newest first: the default a Latest row has always had, now computed from the
 * full pool instead of relying on the server's own `date_created` page.
 */
export function orderByNewest(items: MediaItem[]): MediaItem[] {
  return [...items].sort((left, right) => addedAt(right) - addedAt(left));
}

/**
 * One Latest row: the whole library, newest first, then the library's own
 * hand-placed order over the top, then the cap.
 *
 * The same list orders the library grid, which is the point — the row and the
 * grid are one decision, not two that have to be kept in agreement.
 */
export function buildLatestRow(
  pool: MediaItem[],
  list: CuratedList | null,
  limit = HOME_ROW_LIMIT,
): MediaItem[] {
  return applyCuration(orderByNewest(pool), list).slice(0, limit);
}
