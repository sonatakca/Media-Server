import { describe, expect, it } from "vitest";
import {
  createLibraryRouteRegistry,
  getLibraryRoute,
  getLibrarySlug,
} from "./libraryRoutes";
import type { JellyfinLibrary } from "./types";

const library = (overrides: Partial<JellyfinLibrary>): JellyfinLibrary => ({
  Id: "library-id",
  Name: "Library",
  Type: "CollectionFolder",
  ...overrides,
});

describe("library route aliases", () => {
  it.each([
    ["movies", "movies"],
    ["tvshows", "shows"],
    ["books", "books"],
    ["boxsets", "collections"],
  ] as const)("maps %s libraries to /%s", (collectionType, slug) => {
    const item = library({ CollectionType: collectionType });
    expect(getLibrarySlug(item)).toBe(slug);
    expect(getLibraryRoute(item)).toBe(`/${slug}`);
  });

  it("falls back to the ID route for unknown library types", () => {
    expect(getLibraryRoute(library({ CollectionType: "music" }))).toBe(
      "/library/library-id",
    );
  });

  it("stores the first user-visible library for each clean route", () => {
    const registry = createLibraryRouteRegistry([
      library({ Id: "movies-1", Name: "Movies A", CollectionType: "movies" }),
      library({ Id: "movies-2", Name: "Movies B", CollectionType: "movies" }),
      library({ Id: "shows", Name: "Shows", CollectionType: "tvshows" }),
    ]);

    expect(registry.movies?.id).toBe("movies-1");
    expect(registry.shows?.path).toBe("/shows");
  });
});
