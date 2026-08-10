import type { Language } from "../i18n/translations";
import type { MediaItem } from "./types";

const ITEM_METADATA_STORAGE_KEY = "seyirlik-item-metadata-overrides";
const STORE_VERSION = 1;

type LocalizedText = Partial<Record<Language, string>>;

export interface ItemMetadataOverrideInput {
  itemId: string;
  titles?: Partial<Record<Language, string | null>>;
  overviews?: Partial<Record<Language, string | null>>;
}

interface StoredItemMetadata {
  itemId: string;
  titles: LocalizedText;
  overviews: LocalizedText;
  logos: LocalizedText;
  updatedAt: string;
}

interface ItemMetadataStore {
  version: typeof STORE_VERSION;
  itemsById: Record<string, StoredItemMetadata>;
}

export interface ItemDisplayMetadata {
  title: string | null;
  overview: string | null;
}

function getStorage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

function normalizeText(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function sanitizeTextMap(value: unknown): LocalizedText {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const map = value as Partial<Record<Language, unknown>>;
  const en = normalizeText(typeof map.en === "string" ? map.en : undefined);
  const tr = normalizeText(typeof map.tr === "string" ? map.tr : undefined);

  return {
    ...(en ? { en } : {}),
    ...(tr ? { tr } : {}),
  };
}

function createEmptyStore(): ItemMetadataStore {
  return {
    version: STORE_VERSION,
    itemsById: {},
  };
}

function readStore(): ItemMetadataStore {
  const storage = getStorage();

  if (!storage) {
    return createEmptyStore();
  }

  try {
    const parsed = JSON.parse(
      storage.getItem(ITEM_METADATA_STORAGE_KEY) ?? "",
    ) as Partial<ItemMetadataStore>;

    if (parsed.version !== STORE_VERSION || !parsed.itemsById) {
      return createEmptyStore();
    }

    const store = createEmptyStore();

    Object.entries(parsed.itemsById).forEach(([itemId, value]) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return;
      }

      const item = value as Partial<StoredItemMetadata>;
      const normalizedItemId = normalizeText(item.itemId) ?? itemId;

      if (!normalizedItemId) {
        return;
      }

      store.itemsById[normalizedItemId] = {
        itemId: normalizedItemId,
        titles: sanitizeTextMap(item.titles),
        overviews: sanitizeTextMap(item.overviews),
        logos: sanitizeTextMap(item.logos),
        updatedAt: normalizeText(item.updatedAt) ?? new Date(0).toISOString(),
      };
    });

    return store;
  } catch {
    return createEmptyStore();
  }
}

function writeStore(store: ItemMetadataStore): void {
  getStorage()?.setItem(ITEM_METADATA_STORAGE_KEY, JSON.stringify(store));
}

export function saveItemMetadataOverride(
  override: ItemMetadataOverrideInput,
): void {
  const itemId = normalizeText(override.itemId);

  if (!itemId) {
    return;
  }

  const store = readStore();
  const current = store.itemsById[itemId];
  store.itemsById[itemId] = {
    itemId,
    titles: sanitizeTextMap(override.titles),
    overviews: sanitizeTextMap(override.overviews),
    logos: current?.logos ?? {},
    updatedAt: new Date().toISOString(),
  };
  writeStore(store);
}

export function saveItemLogoOverride(
  itemIdValue: string,
  language: Language,
  urlValue: string,
): void {
  const itemId = normalizeText(itemIdValue);
  const url = normalizeText(urlValue);

  if (!itemId || !url) {
    return;
  }

  const store = readStore();
  const current = store.itemsById[itemId];

  store.itemsById[itemId] = {
    itemId,
    titles: current?.titles ?? {},
    overviews: current?.overviews ?? {},
    logos: {
      ...(current?.logos ?? {}),
      [language]: url,
    },
    updatedAt: new Date().toISOString(),
  };
  writeStore(store);
}

export function getItemLogoUrl(
  item: MediaItem,
  language: Language,
  fallbackUrl: string,
): string {
  return getItemLogoUrlById(item.Id, language, fallbackUrl);
}

export function getItemLogoUrlById(
  itemId: string | null | undefined,
  language: Language,
  fallbackUrl: string,
): string {
  return (
    (itemId ? readStore().itemsById[itemId]?.logos[language] : null) ??
    fallbackUrl
  );
}

export function getItemDisplayMetadata(
  item: MediaItem,
  language: Language,
): ItemDisplayMetadata {
  const stored = readStore().itemsById[item.Id];

  return {
    title: stored?.titles[language] ?? item.Name ?? null,
    overview: stored?.overviews[language] ?? item.Overview ?? null,
  };
}
