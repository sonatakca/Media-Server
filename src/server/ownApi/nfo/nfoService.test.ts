import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { NFO_DEFAULT_CONFIG, type NfoConfig } from "./nfoConfig";
import { createNfoService } from "./nfoService";
import { createNfoWriter } from "./nfoWriter";
import type {
  NfoItemBundle,
  NfoItemRow,
  NfoLibrary,
  NfoRepository,
} from "./nfoRepository";

const MOVIE_ID = "aaaaaaaa-1111-4111-8111-111111111111";
const SECOND_MOVIE_ID = "aaaaaaaa-1111-4111-8111-111111111112";
const LIBRARY_ID = "bbbbbbbb-2222-4222-8222-222222222222";

const LEGACY_JELLYFIN = `<?xml version="1.0" encoding="utf-8" standalone="yes"?>
<movie><title>Curated by hand</title><lockdata>true</lockdata></movie>
`;

let mediaRoot: string;
let generatedRoot: string;

beforeEach(async () => {
  const base = await mkdtemp(path.join(tmpdir(), "seyirlik-nfo-service-"));
  mediaRoot = path.join(base, "media");
  generatedRoot = path.join(base, "generated");
  await mkdir(path.join(mediaRoot, "Movies", "Dune (2021)"), {
    recursive: true,
  });
  await mkdir(path.join(mediaRoot, "Movies", "Arrival (2016)"), {
    recursive: true,
  });
  await mkdir(generatedRoot, { recursive: true });
});

function movieBundle(
  id: string,
  folder: string,
  overrides: Partial<NfoItemRow> = {},
): NfoItemBundle {
  return {
    item: {
      id,
      libraryId: LIBRARY_ID,
      parentId: null,
      seriesId: null,
      kind: "movie",
      sourceKey: `movie:movies/${folder.toLowerCase()}`,
      title: folder.replace(/ \(\d{4}\)$/, ""),
      sortTitle: folder.toLowerCase(),
      originalTitle: null,
      overview: null,
      tagline: null,
      productionYear: null,
      premiereDate: null,
      endDate: null,
      officialRating: null,
      communityRating: null,
      runtimeMs: null,
      indexNumber: null,
      parentIndexNumber: null,
      providerIds: {},
      ...overrides,
    },
    files: [
      {
        id: `${id.slice(0, 8)}-file`,
        itemId: id,
        relativePath: `Movies/${folder}/${folder}.mkv`,
        container: "mkv",
        durationMs: null,
        isPrimary: true,
      },
    ],
    streams: [],
    genres: [],
    people: [],
  };
}

const LIBRARY: NfoLibrary = {
  id: LIBRARY_ID,
  slug: "movies",
  name: "Movies",
};

function fakeRepository(
  bundles: NfoItemBundle[],
  overrides: Partial<NfoRepository> = {},
): NfoRepository {
  const byId = new Map(bundles.map((bundle) => [bundle.item.id, bundle]));
  return {
    getLibrary: async (id) => (id === LIBRARY_ID ? LIBRARY : null),
    getLibraryForItem: async (id) => (byId.has(id) ? LIBRARY : null),
    listExportableItemIds: async (_libraryId, { after, limit }) => {
      const ids = [...byId.keys()].sort();
      const start = after ? ids.findIndex((id) => id > after) : 0;
      return start === -1 ? [] : ids.slice(start, start + limit);
    },
    countExportableItems: async () => byId.size,
    loadBundles: async (ids) =>
      ids
        .map((id) => byId.get(id))
        .filter((bundle): bundle is NfoItemBundle => bundle !== undefined),
    ...overrides,
  };
}

function buildService(
  config: Partial<NfoConfig>,
  bundles: NfoItemBundle[] = [movieBundle(MOVIE_ID, "Dune (2021)")],
  repositoryOverrides: Partial<NfoRepository> = {},
) {
  const merged: NfoConfig = { ...NFO_DEFAULT_CONFIG, ...config };
  return createNfoService({
    repository: fakeRepository(bundles, repositoryOverrides),
    writer: createNfoWriter({
      mode: merged.mode,
      overwritePolicy: merged.overwritePolicy,
      mediaRoot,
      generatedStoragePath: generatedRoot,
    }),
    config: merged,
  });
}

async function mediaRootEntries(): Promise<string[]> {
  const folders = await readdir(path.join(mediaRoot, "Movies"));
  const entries: string[] = [];
  for (const folder of folders) {
    for (const name of await readdir(path.join(mediaRoot, "Movies", folder))) {
      entries.push(`${folder}/${name}`);
    }
  }
  return entries.sort();
}

describe("nfo service", () => {
  describe("preview", () => {
    it("returns the XML and its intended path without writing anything", async () => {
      const service = buildService({ mode: "preview" });

      const preview = await service.preview(MOVIE_ID);

      expect(preview?.mode).toBe("preview");
      expect(preview?.destination).toBe("none");
      expect(preview?.files).toHaveLength(1);
      expect(preview?.files[0]?.relativePath).toBe(
        "Movies/Dune (2021)/movie.nfo",
      );
      expect(preview?.files[0]?.xml).toContain("<title>Dune</title>");
      expect(await mediaRootEntries()).toEqual([]);
      expect(await readdir(generatedRoot)).toEqual([]);
    });

    it("writes nothing to the media root even in sidecar mode", async () => {
      const service = buildService({ mode: "sidecar" });

      await service.preview(MOVIE_ID);

      expect(await mediaRootEntries()).toEqual([]);
    });

    it("says what is already at the path", async () => {
      await writeFile(
        path.join(mediaRoot, "Movies", "Dune (2021)", "movie.nfo"),
        LEGACY_JELLYFIN,
        "utf8",
      );
      const service = buildService({ mode: "sidecar" });

      const preview = await service.preview(MOVIE_ID);

      expect(preview?.files[0]?.existing).toBe("foreign");
      expect(preview?.files[0]?.identical).toBe(false);
      expect(await mediaRootEntries()).toEqual(["Dune (2021)/movie.nfo"]);
    });

    it("warns about a legacy file even while the feature is only previewing", async () => {
      // The point of a preview is finding out what an export would run into.
      // Reporting "absent" here would hide the one thing worth knowing.
      await writeFile(
        path.join(mediaRoot, "Movies", "Dune (2021)", "movie.nfo"),
        LEGACY_JELLYFIN,
        "utf8",
      );

      for (const mode of ["preview", "disabled"] as const) {
        const preview = await buildService({ mode }).preview(MOVIE_ID);

        expect(preview?.files[0]?.existing).toBe("foreign");
        expect(preview?.files[0]?.identical).toBe(false);
      }

      expect(await mediaRootEntries()).toEqual(["Dune (2021)/movie.nfo"]);
    });

    it("reports an identical managed file as identical", async () => {
      const service = buildService({ mode: "sidecar" });
      await service.exportItem(MOVIE_ID);

      const preview = await service.preview(MOVIE_ID);

      expect(preview?.files[0]?.existing).toBe("managed");
      expect(preview?.files[0]?.identical).toBe(true);
    });

    it("exposes no absolute host path", async () => {
      const preview = await buildService({ mode: "sidecar" }).preview(MOVIE_ID);

      expect(JSON.stringify(preview)).not.toContain(mediaRoot);
    });

    it("is null for an item that does not exist", async () => {
      expect(
        await buildService({ mode: "preview" }).preview(SECOND_MOVIE_ID),
      ).toBeNull();
    });
  });

  describe("exportItem", () => {
    it("creates the file and counts it", async () => {
      const summary = await buildService({ mode: "sidecar" }).exportItem(
        MOVIE_ID,
      );

      expect(summary).toMatchObject({
        created: 1,
        updated: 0,
        unchanged: 0,
        skippedConflict: 0,
        failed: 0,
        itemsConsidered: 1,
      });
      expect(await mediaRootEntries()).toEqual(["Dune (2021)/movie.nfo"]);
    });

    it("is idempotent: a second export reports unchanged", async () => {
      const service = buildService({ mode: "sidecar" });
      await service.exportItem(MOVIE_ID);

      const summary = await service.exportItem(MOVIE_ID);

      expect(summary).toMatchObject({ created: 0, unchanged: 1 });
    });

    it("reports a legacy file as a conflict and leaves it in place", async () => {
      const target = path.join(mediaRoot, "Movies", "Dune (2021)", "movie.nfo");
      await writeFile(target, LEGACY_JELLYFIN, "utf8");

      const summary = await buildService({ mode: "sidecar" }).exportItem(
        MOVIE_ID,
      );

      expect(summary?.skippedConflict).toBe(1);
      expect(summary?.conflicts).toEqual([
        {
          itemId: MOVIE_ID,
          relativePath: "Movies/Dune (2021)/movie.nfo",
          reason: "foreign-file",
        },
      ]);
      expect(await readFile(target, "utf8")).toBe(LEGACY_JELLYFIN);
    });

    it("replaces a legacy file when an administrator forces it", async () => {
      const target = path.join(mediaRoot, "Movies", "Dune (2021)", "movie.nfo");
      await writeFile(target, LEGACY_JELLYFIN, "utf8");

      const summary = await buildService({ mode: "sidecar" }).exportItem(
        MOVIE_ID,
        { force: true },
      );

      expect(summary?.updated).toBe(1);
      expect(await readFile(target, "utf8")).toContain("Seyirlik nfo-export");
    });

    it("writes nothing while the feature is disabled", async () => {
      const summary = await buildService({ mode: "disabled" }).exportItem(
        MOVIE_ID,
      );

      expect(summary?.created).toBe(0);
      expect(summary?.skippedNotApplicable).toBe(1);
      expect(await mediaRootEntries()).toEqual([]);
    });

    it("writes nothing in preview mode", async () => {
      const summary = await buildService({ mode: "preview" }).exportItem(
        MOVIE_ID,
      );

      expect(summary?.created).toBe(0);
      expect(await mediaRootEntries()).toEqual([]);
    });

    it("keeps generated-mode output off the media volume", async () => {
      await buildService({ mode: "generated" }).exportItem(MOVIE_ID);

      expect(await mediaRootEntries()).toEqual([]);
      expect(
        await readFile(
          path.join(generatedRoot, "nfo", "Movies", "Dune (2021)", "movie.nfo"),
          "utf8",
        ),
      ).toContain("<title>Dune</title>");
    });

    it("is null for an item that does not exist", async () => {
      expect(
        await buildService({ mode: "sidecar" }).exportItem(SECOND_MOVIE_ID),
      ).toBeNull();
    });
  });

  describe("exportLibrary", () => {
    const both = [
      movieBundle(MOVIE_ID, "Dune (2021)"),
      movieBundle(SECOND_MOVIE_ID, "Arrival (2016)"),
    ];

    it("walks the whole library and reports the counts", async () => {
      const summary = await buildService(
        { mode: "sidecar" },
        both,
      ).exportLibrary(LIBRARY_ID);

      expect(summary).toMatchObject({
        created: 2,
        itemsConsidered: 2,
        cancelled: false,
      });
      expect(await mediaRootEntries()).toEqual([
        "Arrival (2016)/movie.nfo",
        "Dune (2021)/movie.nfo",
      ]);
    });

    it("reports progress as it goes", async () => {
      const progress: number[] = [];

      await buildService({ mode: "sidecar" }, both).exportLibrary(LIBRARY_ID, {
        reportProgress: async (fraction) => {
          progress.push(fraction);
        },
      });

      expect(progress.length).toBeGreaterThan(0);
      expect(progress[progress.length - 1]).toBe(1);
    });

    it("stops when the task is cancelled", async () => {
      const summary = await buildService(
        { mode: "sidecar" },
        both,
      ).exportLibrary(LIBRARY_ID, { isCancelled: async () => true });

      expect(summary?.cancelled).toBe(true);
      expect(summary?.itemsConsidered).toBe(0);
      expect(await mediaRootEntries()).toEqual([]);
    });

    it("mixes created, unchanged and conflicting outcomes in one run", async () => {
      await writeFile(
        path.join(mediaRoot, "Movies", "Arrival (2016)", "movie.nfo"),
        LEGACY_JELLYFIN,
        "utf8",
      );
      const service = buildService({ mode: "sidecar" }, both);
      await service.exportItem(MOVIE_ID);

      const summary = await service.exportLibrary(LIBRARY_ID);

      expect(summary).toMatchObject({
        created: 0,
        unchanged: 1,
        skippedConflict: 1,
      });
    });

    it("is null for a library that does not exist", async () => {
      expect(
        await buildService({ mode: "sidecar" }).exportLibrary(
          "cccccccc-3333-4333-8333-333333333333",
        ),
      ).toBeNull();
    });
  });

  describe("Arr ownership", () => {
    const arrConfig = {
      mode: "sidecar" as const,
      arrManagedLibrarySlugs: new Set(["movies"]),
    };

    it("refuses to export a library a Radarr instance manages", async () => {
      const summary = await buildService(arrConfig).exportLibrary(LIBRARY_ID);

      expect(summary?.itemsConsidered).toBe(0);
      expect(summary?.created).toBe(0);
      expect(await mediaRootEntries()).toEqual([]);
    });

    it("refuses a single item in such a library too", async () => {
      const summary = await buildService(arrConfig).exportItem(MOVIE_ID);

      expect(summary?.created).toBe(0);
      expect(summary?.skippedNotApplicable).toBe(1);
      expect(await mediaRootEntries()).toEqual([]);
    });

    it("says so in the preview rather than showing a path it will not write", async () => {
      const preview = await buildService(arrConfig).preview(MOVIE_ID);

      expect(preview?.skipped).toBe("arr-managed");
      expect(preview?.files).toEqual([]);
    });
  });
});
