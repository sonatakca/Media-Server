import type { MediaItem } from "./types";

export const HOME_CURATION_STORAGE_KEY = "seyirlik-home-curation-v1";

export interface HomeCurationPreferences {
  carouselOrderIds: string[];
  carouselExcludedIds: string[];
  latestOrderIds: string[];
  latestExcludedIds: string[];
}

export const DEFAULT_HOME_CURATION_PREFERENCES: HomeCurationPreferences = {
  carouselOrderIds: [],
  carouselExcludedIds: [],
  latestOrderIds: [],
  latestExcludedIds: [],
};

function hasBackdrop(item: MediaItem): boolean {
  return Boolean(
    item.BackdropImageTags?.[0] ||
    (item.ParentBackdropItemId && item.ParentBackdropImageTags?.[0]),
  );
}

function hasPrimaryImage(item: MediaItem): boolean {
  return Boolean(item.ImageTags?.Primary);
}

function removeDuplicateItems(items: MediaItem[]): MediaItem[] {
  const seenItemIds = new Set<string>();

  return items.filter((item) => {
    if (seenItemIds.has(item.Id)) {
      return false;
    }

    seenItemIds.add(item.Id);
    return true;
  });
}

function isHomeCarouselItem(item: MediaItem): boolean {
  return item.Type === "Movie" || item.Type === "Series";
}

function scoreHomeCarouselItem(item: MediaItem): number {
  let score = 0;

  if (hasBackdrop(item)) {
    score += 100;
  } else if (hasPrimaryImage(item)) {
    score += 50;
  }

  if (item.ImageTags?.Logo) {
    score += 20;
  }

  if (item.Overview?.trim()) {
    score += 15;
  }

  if (item.Type === "Movie" || item.Type === "Series") {
    score += 10;
  }

  return score;
}

function getStorage(): Storage | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const storage = window.localStorage;

    if (
      !storage ||
      typeof storage.getItem !== "function" ||
      typeof storage.setItem !== "function" ||
      typeof storage.removeItem !== "function"
    ) {
      return null;
    }

    return storage;
  } catch {
    return null;
  }
}

function normalizeIdArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const seenIds = new Set<string>();

  return value.filter((candidate): candidate is string => {
    if (typeof candidate !== "string" || candidate.length === 0) {
      return false;
    }

    if (seenIds.has(candidate)) {
      return false;
    }

    seenIds.add(candidate);
    return true;
  });
}

export function normalizeHomeCurationPreferences(
  value: unknown,
): HomeCurationPreferences {
  if (!value || typeof value !== "object") {
    return DEFAULT_HOME_CURATION_PREFERENCES;
  }

  const candidate = value as Partial<HomeCurationPreferences>;

  return {
    carouselOrderIds: normalizeIdArray(candidate.carouselOrderIds),
    carouselExcludedIds: normalizeIdArray(candidate.carouselExcludedIds),
    latestOrderIds: normalizeIdArray(candidate.latestOrderIds),
    latestExcludedIds: normalizeIdArray(candidate.latestExcludedIds),
  };
}

export function loadHomeCurationPreferences(): HomeCurationPreferences {
  const storage = getStorage();

  if (!storage) {
    return DEFAULT_HOME_CURATION_PREFERENCES;
  }

  const storedValue = storage.getItem(HOME_CURATION_STORAGE_KEY);

  if (!storedValue) {
    return DEFAULT_HOME_CURATION_PREFERENCES;
  }

  try {
    return normalizeHomeCurationPreferences(JSON.parse(storedValue));
  } catch {
    return DEFAULT_HOME_CURATION_PREFERENCES;
  }
}

export function saveHomeCurationPreferences(
  preferences: HomeCurationPreferences,
): void {
  const storage = getStorage();

  if (!storage) {
    return;
  }

  storage.setItem(
    HOME_CURATION_STORAGE_KEY,
    JSON.stringify(normalizeHomeCurationPreferences(preferences)),
  );
}

export function clearHomeCurationPreferences(): void {
  const storage = getStorage();

  if (!storage) {
    return;
  }

  storage.removeItem(HOME_CURATION_STORAGE_KEY);
}

export function buildHomeCarouselPool(items: MediaItem[]): MediaItem[] {
  return removeDuplicateItems(items.filter(isHomeCarouselItem))
    .map((item, index) => ({
      item,
      index,
      score: scoreHomeCarouselItem(item),
    }))
    .sort(
      (firstItem, secondItem) =>
        secondItem.score - firstItem.score ||
        firstItem.index - secondItem.index,
    )
    .map(({ item }) => item);
}

export function orderHomeCarouselItemsForEditor(
  items: MediaItem[],
  preferences: HomeCurationPreferences,
): MediaItem[] {
  return orderItemsForEditor(items, preferences.carouselOrderIds);
}

function orderItemsForEditor(
  items: MediaItem[],
  orderIds: string[],
): MediaItem[] {
  const itemById = new Map(items.map((item) => [item.Id, item]));
  const orderedItems = orderIds
    .map((itemId) => itemById.get(itemId))
    .filter((item): item is MediaItem => Boolean(item));
  const orderedIds = new Set(orderedItems.map((item) => item.Id));
  const remainingItems = items.filter((item) => !orderedIds.has(item.Id));

  return [...orderedItems, ...remainingItems];
}

export function orderLatestMediaItemsForEditor(
  items: MediaItem[],
  preferences: HomeCurationPreferences,
): MediaItem[] {
  return orderItemsForEditor(items, preferences.latestOrderIds);
}

export function applyHomeCarouselCuration(
  items: MediaItem[],
  preferences: HomeCurationPreferences,
): MediaItem[] {
  const excludedIds = new Set(preferences.carouselExcludedIds);

  return orderHomeCarouselItemsForEditor(items, preferences).filter(
    (item) => !excludedIds.has(item.Id),
  );
}

export function filterLatestMediaItems(
  items: MediaItem[],
  preferences: HomeCurationPreferences,
): MediaItem[] {
  const excludedIds = new Set(preferences.latestExcludedIds);

  return orderLatestMediaItemsForEditor(items, preferences).filter(
    (item) => !excludedIds.has(item.Id),
  );
}
