import {
  isCollectionItem,
  sortCollectionItemsForWatching,
} from "./collectionUtils";
import type { JellyfinItem } from "./types";

export type CollectionPosterChildrenMap = Record<string, JellyfinItem[]>;

type LoadCollectionItems = (collectionId: string) => Promise<JellyfinItem[]>;

export function shouldUseCollectionFallbackPoster(item: JellyfinItem): boolean {
  return isCollectionItem(item) && !item.ImageTags?.Primary;
}

export function getCollectionPosterItems(
  collectionItems: JellyfinItem[],
  limit = 4,
): JellyfinItem[] {
  return sortCollectionItemsForWatching(collectionItems)
    .filter((item) => Boolean(item.ImageTags?.Primary))
    .slice(0, limit);
}

export async function loadCollectionPosterChildrenMap(
  items: JellyfinItem[],
  loadCollectionItems: LoadCollectionItems,
): Promise<CollectionPosterChildrenMap> {
  const collectionsNeedingPoster = items.filter(
    shouldUseCollectionFallbackPoster,
  );

  if (collectionsNeedingPoster.length === 0) {
    return {};
  }

  const entries = await Promise.all(
    collectionsNeedingPoster.map(async (collection) => {
      const children = await loadCollectionItems(collection.Id).catch(() => []);
      const posterItems = getCollectionPosterItems(children);
      return [collection.Id, posterItems] as const;
    }),
  );

  return entries.reduce<CollectionPosterChildrenMap>(
    (childrenByCollectionId, [collectionId, children]) => {
      if (children.length > 0) {
        childrenByCollectionId[collectionId] = children;
      }

      return childrenByCollectionId;
    },
    {},
  );
}
