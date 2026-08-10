import type { TranslationKey } from "../../i18n/translations";
import { formatTemplate } from "../../lib/format";
import type { MediaItem } from "../../lib/types";
import { isItemCompleted } from "../../lib/watchStatus";
import type { LibraryPageProps } from "../libraryPageTypes";

type LibraryMode = NonNullable<LibraryPageProps["mode"]>;
type LibraryRouteKind = LibraryPageProps["libraryRouteKind"];

interface ResolveLibraryCanonicalPathOptions {
  activeId?: string;
  canonicalPathOverride?: string;
  libraryRouteKind?: LibraryRouteKind;
  mode: LibraryMode;
  seasonId?: string;
  seriesId?: string;
}

export function countLabel(
  count: number,
  singularKey: TranslationKey,
  pluralKey: TranslationKey,
  t: (key: TranslationKey) => string,
): string {
  return count === 1 ? t(singularKey) : formatTemplate(t(pluralKey), { count });
}

export function compareNames(left: MediaItem, right: MediaItem): number {
  return (left.SortName ?? left.Name).localeCompare(
    right.SortName ?? right.Name,
    undefined,
    { numeric: true },
  );
}

export function resolveLibraryCanonicalPath({
  activeId,
  canonicalPathOverride,
  libraryRouteKind,
  mode,
  seasonId,
  seriesId,
}: ResolveLibraryCanonicalPathOptions): string {
  return (
    canonicalPathOverride ??
    (libraryRouteKind === "movie" && activeId
      ? `/movies/${activeId}`
      : libraryRouteKind === "collection" && activeId
        ? `/collections/${activeId}`
        : libraryRouteKind === "show" && mode === "series" && activeId
          ? `/shows/${activeId}`
          : libraryRouteKind === "show" &&
              mode === "season" &&
              seriesId &&
              seasonId
            ? `/shows/${seriesId}/season/${seasonId}`
            : libraryRouteKind === "show" && mode === "season" && seasonId
              ? `/shows/season/${seasonId}`
              : mode === "series" && seriesId
                ? `/series/${seriesId}`
                : mode === "season" && seriesId && seasonId
                  ? `/series/${seriesId}/season/${seasonId}`
                  : mode === "season" && seasonId
                    ? `/season/${seasonId}`
                    : activeId
                      ? `/library/${activeId}`
                      : "/home")
  );
}

export function isWatchableScopeItem(item: MediaItem): boolean {
  return (
    item.Type === "Episode" ||
    item.Type === "Season" ||
    item.Type === "Movie" ||
    item.MediaType === "Video"
  );
}

export function isWholeWatchedScope(
  library: MediaItem | undefined,
  items: MediaItem[],
): boolean {
  if (library && isItemCompleted(library)) {
    return true;
  }

  const watchableItems = items.filter(isWatchableScopeItem);

  return watchableItems.length > 0 && watchableItems.every(isItemCompleted);
}

export function withWatchedState(
  item: MediaItem,
  watched: boolean,
): MediaItem {
  return {
    ...item,
    UserData: {
      ...(item.UserData ?? {}),
      PlaybackPositionTicks: watched
        ? (item.RunTimeTicks ?? item.UserData?.PlaybackPositionTicks ?? 0)
        : 0,
      PlayedPercentage: watched ? 100 : 0,
      Played: watched,
      LastPlayedDate: watched ? new Date().toISOString() : null,
    },
  };
}
