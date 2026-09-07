import {
  curatedEntriesFrom,
  orderItemsByCuration,
  type CuratedEntry,
  type CuratedList,
  type CuratedSurface,
} from "../../lib/curation";
import type { MediaItem } from "../../lib/types";

/**
 * A shelf the editor can reorder.
 *
 * `surface` plus `libraryId` is the list's identity on the server; `id` is only
 * the editor's own key for it, because two library grids share one surface and
 * would otherwise collide in the editor's state.
 */
export interface CurationSection {
  id: string;
  surface: CuratedSurface;
  libraryId?: string | undefined;
}

export interface SectionDraft {
  /** Every id in the pool, in the order the shelf will render them. */
  orderedIds: string[];
  hiddenIds: string[];
}

export const EMPTY_SECTION_DRAFT: SectionDraft = {
  orderedIds: [],
  hiddenIds: [],
};

export function moveId(
  ids: string[],
  itemId: string,
  direction: -1 | 1,
): string[] {
  return moveIdToIndex(ids, itemId, ids.indexOf(itemId) + direction);
}

export function moveIdToIndex(
  ids: string[],
  itemId: string,
  targetIndex: number,
): string[] {
  const index = ids.indexOf(itemId);
  const boundedIndex = Math.min(
    Math.max(targetIndex, 0),
    Math.max(ids.length - 1, 0),
  );

  if (index < 0 || index === boundedIndex) return ids;

  const next = [...ids];
  const [moved] = next.splice(index, 1);
  next.splice(boundedIndex, 0, moved);
  return next;
}

export function toggleId(ids: string[], itemId: string): string[] {
  return ids.includes(itemId)
    ? ids.filter((candidate) => candidate !== itemId)
    : [...ids, itemId];
}

/**
 * The draft a section starts from: the shelf's pool, already in whatever order
 * the saved list imposes, with the saved hidden marks carried over.
 *
 * Seeded from the whole pool rather than from the saved entries alone so that
 * moving the tenth title to the top is one action rather than ten.
 */
export function draftFromPool(
  pool: MediaItem[],
  list: CuratedList | null,
): SectionDraft {
  const poolIds = new Set(pool.map((item) => item.Id));

  return {
    orderedIds: orderItemsByCuration(pool, list).map((item) => item.Id),
    // Entries can outlive the pool — a title drops out of Latest as newer ones
    // arrive — and a hidden mark for a title that is not on screen must not be
    // written back as if the editor had seen it.
    hiddenIds: (list?.entries ?? [])
      .filter((entry) => entry.hidden && poolIds.has(entry.itemId))
      .map((entry) => entry.itemId),
  };
}

/**
 * What a save sends: the draft's order and its hidden marks.
 *
 * Hiding means the same thing on every shelf here — keep this off the home
 * page — because the library grid that shares the list ignores the flag
 * entirely. There is nothing for a per-section exception to express.
 */
export function entriesFromDraft(
  draft: SectionDraft,
  pool: MediaItem[],
): CuratedEntry[] {
  const itemById = new Map(pool.map((item) => [item.Id, item]));
  const ordered = draft.orderedIds
    .map((itemId) => itemById.get(itemId))
    .filter((item): item is MediaItem => Boolean(item));

  return curatedEntriesFrom(ordered, new Set(draft.hiddenIds));
}

/**
 * Whether the draft has moved away from the state it was loaded in.
 *
 * Compared against the loaded draft rather than against the saved entries,
 * because those two are not the same shape: an unsaved shelf holds no entries
 * at all, and a draft always holds the whole pool. Comparing them directly
 * would announce unsaved changes to a page nobody had touched yet.
 */
export function isDraftDirty(
  draft: SectionDraft,
  baseline: SectionDraft,
): boolean {
  const hidden = new Set(draft.hiddenIds);
  const baselineHidden = new Set(baseline.hiddenIds);

  return (
    draft.orderedIds.length !== baseline.orderedIds.length ||
    draft.orderedIds.some(
      (itemId, index) => itemId !== baseline.orderedIds[index],
    ) ||
    hidden.size !== baselineHidden.size ||
    [...hidden].some((itemId) => !baselineHidden.has(itemId))
  );
}

/**
 * Puts a reordered window back into the whole shelf.
 *
 * The editor never shows the whole of a large library at once — it shows the
 * head of it, or whatever a search matched — so a drag rearranges a subset. The
 * positions that subset occupied stay where they are and receive the new
 * sequence; every other title keeps its place exactly. Reordering the first
 * sixty rows must not move the six hundredth.
 */
export function applyVisibleOrder(
  fullIds: readonly string[],
  nextVisibleIds: readonly string[],
): string[] {
  // The window's membership is unchanged by a reorder, so the ids it names are
  // both the slots to fill and the sequence to fill them with.
  const visible = new Set(nextVisibleIds);

  let cursor = 0;
  return fullIds.map((itemId) =>
    visible.has(itemId) ? (nextVisibleIds[cursor++] as string) : itemId,
  );
}

/** Moves a block of ids to the front of the whole shelf, in shelf order. */
export function moveIdsToFront(
  ids: readonly string[],
  block: readonly string[],
): string[] {
  const moving = new Set(block);
  const moved = ids.filter((itemId) => moving.has(itemId));
  return [...moved, ...ids.filter((itemId) => !moving.has(itemId))];
}

/** Moves a block of ids to the end of the whole shelf, in shelf order. */
export function moveIdsToBack(
  ids: readonly string[],
  block: readonly string[],
): string[] {
  const moving = new Set(block);
  const moved = ids.filter((itemId) => moving.has(itemId));
  return [...ids.filter((itemId) => !moving.has(itemId)), ...moved];
}
