import { getCachedSession } from "./authStorage";
import { getUserViews } from "./mediaApi";
import type { MediaLibrary } from "./types";

export type LibrarySlug = "movies" | "shows" | "books" | "collections";

export interface SavedLibraryRoute {
  id: string;
  name: string;
  collectionType: string | null;
  path: `/${LibrarySlug}`;
}

export type LibraryRouteRegistry = Partial<
  Record<LibrarySlug, SavedLibraryRoute>
>;

const slugByCollectionType: Record<string, LibrarySlug> = {
  movies: "movies",
  tvshows: "shows",
  books: "books",
  boxsets: "collections",
};

function storageKey(): string | null {
  const session = getCachedSession();
  // v2 drops a server-URL segment that was always empty. Old keys are simply
  // orphaned; the routes refresh from the API on the next load.
  return session ? `seyirlik:library-routes:v2:${session.userId}` : null;
}

export function getLibrarySlug(
  library: Pick<MediaLibrary, "Name" | "CollectionType">,
): LibrarySlug | null {
  const collectionType = library.CollectionType?.trim().toLowerCase() ?? "";
  const directMatch = slugByCollectionType[collectionType];
  if (directMatch) return directMatch;

  const normalizedName = library.Name.trim().toLocaleLowerCase("tr");
  return normalizedName === "koleksiyonlar" || normalizedName === "collections"
    ? "collections"
    : null;
}

export function createLibraryRouteRegistry(
  libraries: MediaLibrary[],
): LibraryRouteRegistry {
  const registry: LibraryRouteRegistry = {};

  for (const library of libraries) {
    const slug = getLibrarySlug(library);
    if (!slug || registry[slug]) continue;

    registry[slug] = {
      id: library.Id,
      name: library.Name,
      collectionType: library.CollectionType ?? null,
      path: `/${slug}`,
    };
  }

  return registry;
}

export function readSavedLibraryRoutes(): LibraryRouteRegistry {
  const key = storageKey();
  if (!key) return {};

  try {
    return JSON.parse(
      localStorage.getItem(key) ?? "{}",
    ) as LibraryRouteRegistry;
  } catch {
    localStorage.removeItem(key);
    return {};
  }
}

export async function refreshLibraryRoutes(): Promise<LibraryRouteRegistry> {
  const registry = createLibraryRouteRegistry(await getUserViews());
  const key = storageKey();
  if (key) localStorage.setItem(key, JSON.stringify(registry));
  return registry;
}

export function getLibraryRoute(library: MediaLibrary): string {
  const slug = getLibrarySlug(library);
  return slug ? `/${slug}` : `/library/${library.Id}`;
}
