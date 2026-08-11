import { describe, expect, it, vi } from "vitest";
import { createMetadataService } from "./metadataService";
import { TmdbError, type TmdbClient, type TmdbTitleDetails } from "./tmdbClient";
import type {
  MetadataRepository,
  MetadataTarget,
  TitleMetadataUpdate,
} from "./metadataRepository";
import type { ImageRepository } from "../images/imageRepository";
import type { ImageStorage } from "../images/imageStorage";

function target(overrides: Partial<MetadataTarget> = {}): MetadataTarget {
  return {
    id: "item-1",
    kind: "movie",
    title: "The Matrix",
    productionYear: 1999,
    providerIds: {},
    lockedFields: [],
    seriesId: null,
    indexNumber: null,
    parentIndexNumber: null,
    ...overrides,
  };
}

function details(overrides: Partial<TmdbTitleDetails> = {}): TmdbTitleDetails {
  return {
    providerId: "603",
    title: "The Matrix",
    overview: "A hacker learns the truth.",
    releaseDate: "1999-03-31",
    genres: ["Science Fiction"],
    people: [],
    backdropPaths: [],
    ...overrides,
  };
}

function fakeMetadata(initial: MetadataTarget) {
  const updates: Array<{ itemId: string; update: TitleMetadataUpdate }> = [];
  const genres: Array<{ itemId: string; genres: string[] }> = [];
  let failed = false;

  const repository: MetadataRepository = {
    listPendingItems: async () => [initial],
    getTarget: async () => initial,
    listSeasonsForSeries: async () => [],
    listEpisodesForSeries: async () => [],
    applyTitleMetadata: async (itemId, update) => {
      updates.push({ itemId, update });
    },
    replaceGenres: async (itemId, list) => {
      genres.push({ itemId, genres: list });
    },
    replacePeople: async () => undefined,
    markFailed: async () => {
      failed = true;
    },
    lockFields: async () => undefined,
    setLogoLayout: async () => true,
  };

  return {
    repository,
    updates,
    genres,
    get failed() {
      return failed;
    },
  };
}

function fakeImages(): ImageRepository & { upserts: unknown[] } {
  const upserts: unknown[] = [];
  return {
    upserts,
    listForItems: async () => [],
    listInheritedForItems: async () => new Map(),
    getById: async () => null,
    getOwningItemId: async () => null,
    findByItemAndType: async () => null,
    upsert: async (input) => {
      upserts.push(input);
      return "image-1";
    },
    replaceLocked: async () => "locked-image",
    clear: async () => true,
    listLockedTypes: async () => [],
    deleteForItem: async () => undefined,
  };
}

function fakeStorage(): ImageStorage {
  return {
    resolve: (key) => `/generated/${key}`,
    store: async () => ({
      contentHash: "hash",
      contentType: "image/jpeg",
      sizeBytes: 10,
      storageKey: "aa/bb/hash.jpg",
    }),
    fetchAndStore: async () => ({
      contentHash: "hash",
      contentType: "image/jpeg",
      sizeBytes: 10,
      storageKey: "aa/bb/hash.jpg",
    }),
    remove: async () => undefined,
  };
}

function fakeTmdb(overrides: Partial<TmdbClient> = {}): TmdbClient {
  return {
    searchMovies: async () => [
      { providerId: "603", title: "The Matrix", year: 1999 },
    ],
    searchSeries: async () => [],
    getMovie: async () => details(),
    getSeries: async () => details(),
    getSeasonEpisodes: async () => [],
    listArtwork: async () => [],
    buildImageUrl: (path, size) => `https://image.tmdb.org/t/p/${size}${path}`,
    ...overrides,
  };
}

describe("metadata identification", () => {
  it("applies a confident match and records the provider id", async () => {
    const metadata = fakeMetadata(target());
    const service = createMetadataService({
      metadata: metadata.repository,
      images: fakeImages(),
      imageStorage: fakeStorage(),
      tmdb: fakeTmdb(),
    });

    const result = await service.identify(target());

    expect(result).toMatchObject({ status: "matched", providerId: "603" });
    expect(metadata.updates[0]?.update).toMatchObject({
      title: "The Matrix",
      productionYear: 1999,
      metadataState: "matched",
      providerIds: { tmdb: "603" },
    });
    expect(metadata.genres[0]?.genres).toEqual(["Science Fiction"]);
  });

  it("does not apply an ambiguous match", async () => {
    const metadata = fakeMetadata(target({ title: "The Killer", productionYear: null }));
    const service = createMetadataService({
      metadata: metadata.repository,
      images: fakeImages(),
      imageStorage: fakeStorage(),
      tmdb: fakeTmdb({
        searchMovies: async () => [
          { providerId: "1", title: "The Killer", year: 2023 },
          { providerId: "2", title: "The Killer", year: 1989 },
        ],
      }),
    });

    const result = await service.identify(
      target({ title: "The Killer", productionYear: null }),
    );

    expect(result.status).toBe("ambiguous");
    expect(metadata.updates).toHaveLength(1);
    expect(metadata.updates[0]?.update).toEqual({ metadataState: "unmatched" });
  });

  it("skips an item whose identity an administrator locked", async () => {
    const metadata = fakeMetadata(target({ lockedFields: ["identity"] }));
    const searchMovies = vi.fn(async () => []);
    const service = createMetadataService({
      metadata: metadata.repository,
      images: fakeImages(),
      imageStorage: fakeStorage(),
      tmdb: fakeTmdb({ searchMovies }),
    });

    const result = await service.identify(target({ lockedFields: ["identity"] }));

    expect(result.status).toBe("skipped");
    expect(searchMovies).not.toHaveBeenCalled();
    // Nothing about the title is rewritten, but it must leave the pending set,
    // otherwise the batch scan would keep reselecting it and never terminate.
    expect(metadata.updates).toEqual([
      { itemId: "item-1", update: { metadataState: "locked" } },
    ]);
  });

  it("reuses a provider id that is already recorded instead of searching again", async () => {
    const searchMovies = vi.fn(async () => []);
    const getMovie = vi.fn(async () => details({ providerId: "999" }));
    const metadata = fakeMetadata(target({ providerIds: { tmdb: "999" } }));
    const service = createMetadataService({
      metadata: metadata.repository,
      images: fakeImages(),
      imageStorage: fakeStorage(),
      tmdb: fakeTmdb({ searchMovies, getMovie }),
    });

    const result = await service.identify(
      target({ providerIds: { tmdb: "999" } }),
    );

    expect(searchMovies).not.toHaveBeenCalled();
    expect(getMovie).toHaveBeenCalledWith("999");
    expect(result).toMatchObject({ status: "matched", providerId: "999" });
  });

  it("marks an item unmatched when the provider has no record", async () => {
    const metadata = fakeMetadata(target());
    const service = createMetadataService({
      metadata: metadata.repository,
      images: fakeImages(),
      imageStorage: fakeStorage(),
      tmdb: fakeTmdb({ searchMovies: async () => [] }),
    });

    const result = await service.identify(target());

    expect(result.status).toBe("not-found");
    expect(metadata.updates[0]?.update).toEqual({ metadataState: "unmatched" });
  });

  it("lets a rate limit propagate so the job retries instead of failing the item", async () => {
    const metadata = fakeMetadata(target());
    const service = createMetadataService({
      metadata: metadata.repository,
      images: fakeImages(),
      imageStorage: fakeStorage(),
      tmdb: fakeTmdb({
        searchMovies: async () => {
          throw new TmdbError("rate-limited", "slow down");
        },
      }),
    });

    await expect(service.identify(target())).rejects.toThrow(TmdbError);
    expect(metadata.failed).toBe(false);
  });

  it("stores poster, logo and backdrop artwork", async () => {
    const images = fakeImages();
    const metadata = fakeMetadata(target());
    const service = createMetadataService({
      metadata: metadata.repository,
      images,
      imageStorage: fakeStorage(),
      tmdb: fakeTmdb({
        getMovie: async () =>
          details({
            posterPath: "/poster.jpg",
            logoPath: "/logo.png",
            backdropPaths: ["/back1.jpg", "/back2.jpg"],
          }),
      }),
    });

    await service.identify(target());

    expect(
      images.upserts.map((entry) => (entry as { imageType: string }).imageType),
    ).toEqual(["primary", "logo", "backdrop", "backdrop"]);
  });

  it("does not rewrite artwork whose bytes are unchanged", async () => {
    const images = fakeImages();
    images.findByItemAndType = async () => ({
      id: "existing",
      itemId: "item-1",
      imageType: "primary",
      imageIndex: 0,
      contentHash: "hash",
      width: null,
      height: null,
      contentType: "image/jpeg",
      storageKey: "aa/bb/hash.jpg",
      sizeBytes: 10,
    });

    const service = createMetadataService({
      metadata: fakeMetadata(target()).repository,
      images,
      imageStorage: fakeStorage(),
      tmdb: fakeTmdb({
        getMovie: async () => details({ posterPath: "/poster.jpg" }),
      }),
    });

    await service.identify(target());

    expect(images.upserts).toHaveLength(0);
  });

  it("still applies metadata when artwork cannot be downloaded", async () => {
    const metadata = fakeMetadata(target());
    const storage = fakeStorage();
    storage.fetchAndStore = async () => {
      throw new Error("network down");
    };

    const service = createMetadataService({
      metadata: metadata.repository,
      images: fakeImages(),
      imageStorage: storage,
      tmdb: fakeTmdb({
        getMovie: async () => details({ posterPath: "/poster.jpg" }),
      }),
    });

    const result = await service.identify(target());

    expect(result.status).toBe("matched");
    expect(metadata.updates[0]?.update.metadataState).toBe("matched");
  });
});
