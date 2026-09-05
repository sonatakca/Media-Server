import { describe, expect, it } from "vitest";
import {
  applyOrganizationPlan,
  planLibraryOrganization,
  type OrganizeMove,
  type OrganizerFileSystem,
} from "./organizeLibrary";
import { scanLibraryTree, type LibraryKind } from "./libraryScan";

/**
 * A media volume small enough to read, mutable enough to organise.
 *
 * The organiser is the one thing here that moves a person's files, so its tests
 * run against a filesystem that really moves them and then let the scanner read
 * the result — the two together are the property that matters.
 */
function createMemoryFileSystem(paths: string[]) {
  const files = new Set<string>();
  const directories = new Set<string>();

  const addDirectories = (filePath: string): void => {
    const segments = filePath.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      directories.add(segments.slice(0, index).join("/"));
    }
  };

  for (const path of paths) {
    if (path.endsWith("/")) {
      const directory = path.slice(0, -1);
      directories.add(directory);
      addDirectories(`${directory}/x`);
      continue;
    }
    files.add(path);
    addDirectories(path);
  }

  const childrenOf = (directory: string): string[] => {
    const prefix = directory ? `${directory}/` : "";
    const names = new Set<string>();
    for (const path of [...files, ...directories]) {
      if (!path.startsWith(prefix) || path === directory) continue;
      const rest = path.slice(prefix.length);
      if (rest.includes("/")) continue;
      names.add(rest);
    }
    return [...names];
  };

  const fileSystem = {
    readDirectory: async (relativePath: string) => {
      if (!directories.has(relativePath)) {
        throw new Error(`missing directory ${relativePath}`);
      }
      return childrenOf(relativePath).map((name) => ({
        name,
        isDirectory: directories.has(`${relativePath}/${name}`),
      }));
    },
    readTextFile: async (relativePath: string) => {
      if (!files.has(relativePath)) throw new Error(`missing ${relativePath}`);
      return "";
    },
    statFile: async (relativePath: string) => {
      if (!files.has(relativePath)) throw new Error(`missing ${relativePath}`);
      return { size: 1_000, mtimeMs: 1_700_000_000_000 };
    },
    createDirectory: async (relativePath: string) => {
      directories.add(relativePath);
      const segments = relativePath.split("/");
      for (let index = 1; index < segments.length; index += 1) {
        directories.add(segments.slice(0, index).join("/"));
      }
    },
    move: async (from: string, to: string) => {
      if (!files.has(from)) throw new Error(`missing ${from}`);
      if (files.has(to) || directories.has(to)) {
        throw new Error(`occupied ${to}`);
      }
      files.delete(from);
      files.add(to);
    },
    snapshot: () => [...files].sort(),
  };

  return fileSystem satisfies OrganizerFileSystem & {
    snapshot: () => string[];
  };
}

function movesTo(moves: OrganizeMove[]): string[] {
  return moves.map((move) => `${move.from} -> ${move.to}`);
}

/** The half-processed season the layout was designed around. */
const HALF_PROCESSED_SEASON = [
  "Series/House of the Dragon/tvshow.nfo",
  "Series/House of the Dragon/Season 1/season.nfo",
  "Series/House of the Dragon/Season 1/House of the Dragon - S01E01 - The Heirs of the Dragon.mp4",
  "Series/House of the Dragon/Season 1/House of the Dragon - S01E01 - The Heirs of the Dragon.nfo",
  "Series/House of the Dragon/Season 1/House of the Dragon - S01E01 - The Heirs of the Dragon.tr.srt",
  "Series/House of the Dragon/Season 1/House of the Dragon - S01E02 - The Rogue Prince.mp4",
  "Series/House of the Dragon/Season 1/House of the Dragon - S01E02 - The Rogue Prince.nfo",
  "Series/House of the Dragon/Season 1/House of the Dragon - S01E01 - The Heirs of the Dragon/video/1080p.mp4",
  "Series/House of the Dragon/Season 1/House of the Dragon - S01E01 - The Heirs of the Dragon/.seyirlik/master.m3u8",
];

async function organize(
  paths: string[],
  rootPath: string,
  kind: LibraryKind,
): Promise<ReturnType<typeof createMemoryFileSystem>> {
  const fileSystem = createMemoryFileSystem(paths);
  const plan = await planLibraryOrganization({ fileSystem, rootPath, kind });
  await applyOrganizationPlan(fileSystem, plan);
  return fileSystem;
}

describe("planning a series library", () => {
  it("buckets the originals and files each .nfo with its episode", async () => {
    const fileSystem = createMemoryFileSystem(HALF_PROCESSED_SEASON);

    const plan = await planLibraryOrganization({
      fileSystem,
      rootPath: "Series",
      kind: "series",
    });

    const season = "Series/House of the Dragon/Season 1";
    expect(movesTo(plan.moves)).toEqual([
      `${season}/House of the Dragon - S01E01 - The Heirs of the Dragon.nfo -> ${season}/House of the Dragon - S01E01 - The Heirs of the Dragon/House of the Dragon - S01E01 - The Heirs of the Dragon.nfo`,
      `${season}/House of the Dragon - S01E02 - The Rogue Prince.nfo -> ${season}/House of the Dragon - S01E02 - The Rogue Prince/House of the Dragon - S01E02 - The Rogue Prince.nfo`,
      `${season}/House of the Dragon - S01E01 - The Heirs of the Dragon.mp4 -> ${season}/src/House of the Dragon - S01E01 - The Heirs of the Dragon.mp4`,
      `${season}/House of the Dragon - S01E01 - The Heirs of the Dragon.tr.srt -> ${season}/src/House of the Dragon - S01E01 - The Heirs of the Dragon.tr.srt`,
      `${season}/House of the Dragon - S01E02 - The Rogue Prince.mp4 -> ${season}/src/House of the Dragon - S01E02 - The Rogue Prince.mp4`,
    ]);
    expect(plan.skipped).toEqual([]);
  });

  it("leaves season.nfo and tvshow.nfo where the media managers look", async () => {
    const fileSystem = await organize(
      HALF_PROCESSED_SEASON,
      "Series",
      "series",
    );

    expect(fileSystem.snapshot()).toContain(
      "Series/House of the Dragon/tvshow.nfo",
    );
    expect(fileSystem.snapshot()).toContain(
      "Series/House of the Dragon/Season 1/season.nfo",
    );
  });

  it("gives an unprocessed episode the folder its .nfo belongs in", async () => {
    const fileSystem = await organize(
      HALF_PROCESSED_SEASON,
      "Series",
      "series",
    );

    // S01E02 has no package yet; its .nfo still goes in its own folder, which
    // is where its renditions will be published.
    expect(fileSystem.snapshot()).toContain(
      "Series/House of the Dragon/Season 1/House of the Dragon - S01E02 - The Rogue Prince/House of the Dragon - S01E02 - The Rogue Prince.nfo",
    );
  });

  it("plans nothing at all the second time", async () => {
    const fileSystem = await organize(
      HALF_PROCESSED_SEASON,
      "Series",
      "series",
    );

    const second = await planLibraryOrganization({
      fileSystem,
      rootPath: "Series",
      kind: "series",
    });

    expect(second.moves).toEqual([]);
    expect(second.directories).toEqual([]);
  });

  it("organises episodes that sit directly in the series folder", async () => {
    const fileSystem = await organize(
      [
        "Series/Ezel/Ezel - S01E01 - Bölüm 1.mp4",
        "Series/Ezel/Ezel - S01E01 - Bölüm 1.nfo",
      ],
      "Series",
      "series",
    );

    expect(fileSystem.snapshot()).toEqual([
      "Series/Ezel/Ezel - S01E01 - Bölüm 1/Ezel - S01E01 - Bölüm 1.nfo",
      "Series/Ezel/src/Ezel - S01E01 - Bölüm 1.mp4",
    ]);
  });
});

describe("planning a movie library", () => {
  it("buckets a movie's originals and leaves its .nfo at the folder root", async () => {
    const fileSystem = await organize(
      [
        "Movies/Gladiator (2000)/Gladiator (2000).mp4",
        "Movies/Gladiator (2000)/Gladiator (2000).en.srt",
        "Movies/Gladiator (2000)/Gladiator (2000).nfo",
        "Movies/Gladiator (2000)/movie.nfo",
        "Movies/Gladiator (2000)/poster.jpg",
        "Movies/Gladiator (2000)/video/1080p.mp4",
      ],
      "Movies",
      "movies",
    );

    expect(fileSystem.snapshot()).toEqual([
      "Movies/Gladiator (2000)/Gladiator (2000).nfo",
      "Movies/Gladiator (2000)/movie.nfo",
      "Movies/Gladiator (2000)/poster.jpg",
      "Movies/Gladiator (2000)/src/Gladiator (2000).en.srt",
      "Movies/Gladiator (2000)/src/Gladiator (2000).mp4",
      "Movies/Gladiator (2000)/video/1080p.mp4",
    ]);
  });

  it("gives a loose file at the library root a folder of its own", async () => {
    const fileSystem = await organize(
      ["Movies/Arrival (2016).mkv", "Movies/Arrival (2016).nfo"],
      "Movies",
      "movies",
    );

    expect(fileSystem.snapshot()).toEqual([
      "Movies/Arrival (2016)/Arrival (2016).nfo",
      "Movies/Arrival (2016)/src/Arrival (2016).mkv",
    ]);
  });

  it("keeps both cuts of one movie together in the one bucket", async () => {
    const fileSystem = await organize(
      [
        "Movies/The Matrix (1999)/The Matrix (1999) - 2160p.mkv",
        "Movies/The Matrix (1999)/The Matrix (1999) - 1080p.mkv",
      ],
      "Movies",
      "movies",
    );

    expect(fileSystem.snapshot()).toEqual([
      "Movies/The Matrix (1999)/src/The Matrix (1999) - 1080p.mkv",
      "Movies/The Matrix (1999)/src/The Matrix (1999) - 2160p.mkv",
    ]);
  });

  it("leaves trailers and extras exactly where they are", async () => {
    const fileSystem = await organize(
      [
        "Movies/Dune (2021)/Dune (2021).mp4",
        "Movies/Dune (2021)/Dune (2021)-trailer.mp4",
        "Movies/Dune (2021)/content/trailers/teaser.mp4",
        "Movies/Dune (2021)/extras/Behind the Scenes.mkv",
      ],
      "Movies",
      "movies",
    );

    expect(fileSystem.snapshot()).toEqual([
      "Movies/Dune (2021)/Dune (2021)-trailer.mp4",
      "Movies/Dune (2021)/content/trailers/teaser.mp4",
      "Movies/Dune (2021)/extras/Behind the Scenes.mkv",
      "Movies/Dune (2021)/src/Dune (2021).mp4",
    ]);
  });
});

describe("refusing to destroy anything", () => {
  it("skips a move whose destination is already taken", async () => {
    const fileSystem = createMemoryFileSystem([
      "Movies/Dune (2021)/Dune (2021).mp4",
      "Movies/Dune (2021)/src/Dune (2021).mp4",
    ]);

    const plan = await planLibraryOrganization({
      fileSystem,
      rootPath: "Movies",
      kind: "movies",
    });

    expect(plan.moves).toEqual([]);
    expect(plan.skipped).toEqual([
      {
        relativePath: "Movies/Dune (2021)/Dune (2021).mp4",
        reason: "destination-occupied",
      },
    ]);
    // And the file that was already there is still there.
    expect(fileSystem.snapshot()).toContain(
      "Movies/Dune (2021)/src/Dune (2021).mp4",
    );
  });

  it("reports a move it could not carry out instead of throwing", async () => {
    const fileSystem = createMemoryFileSystem([
      "Movies/Dune (2021)/Dune (2021).mp4",
    ]);
    const plan = await planLibraryOrganization({
      fileSystem,
      rootPath: "Movies",
      kind: "movies",
    });

    const result = await applyOrganizationPlan(
      {
        ...fileSystem,
        move: async () => {
          throw new Error("Read-only file system");
        },
      },
      plan,
    );

    expect(result.moved).toEqual([]);
    expect(result.failed).toEqual([
      { move: plan.moves[0], error: "Read-only file system" },
    ]);
  });

  it("does nothing to a book library", async () => {
    const fileSystem = createMemoryFileSystem([
      "Books/Ursula K. Le Guin/The Dispossessed.epub",
    ]);

    const plan = await planLibraryOrganization({
      fileSystem,
      rootPath: "Books",
      kind: "books",
    });

    expect(plan.moves).toEqual([]);
  });
});

/*
 * The property the whole design rests on. An item's identity comes from its
 * title folder, and organising moves no title folder — so the catalogue after
 * a reorganisation must be indistinguishable from the catalogue before it,
 * item for item.
 */
describe("organising never changes what the scanner sees", () => {
  const cases: Array<{
    name: string;
    paths: string[];
    root: string;
    kind: LibraryKind;
  }> = [
    {
      name: "a half-processed season",
      paths: HALF_PROCESSED_SEASON,
      root: "Series",
      kind: "series",
    },
    {
      name: "movie folders and a loose file",
      paths: [
        "Movies/Gladiator (2000)/Gladiator (2000).mp4",
        "Movies/Gladiator (2000)/Gladiator (2000).en.srt",
        "Movies/Arrival (2016).mkv",
      ],
      root: "Movies",
      kind: "movies",
    },
    {
      name: "a mixed root",
      paths: [
        "Media/Andor/Season 1/Andor - S01E01 - Kassa.mp4",
        "Media/Dune (2021)/Dune (2021).mp4",
        "Media/Arrival (2016).mkv",
      ],
      root: "Media",
      kind: "mixed",
    },
  ];

  for (const { name, paths, root, kind } of cases) {
    it(`keeps every source key for ${name}`, async () => {
      const before = await scanLibraryTree({
        fileSystem: createMemoryFileSystem(paths),
        rootPath: root,
        kind,
      });
      const organised = await organize(paths, root, kind);
      const after = await scanLibraryTree({
        fileSystem: organised,
        rootPath: root,
        kind,
      });

      expect(after.items.map((item) => item.sourceKey).sort()).toEqual(
        before.items.map((item) => item.sourceKey).sort(),
      );
      expect(after.items.map((item) => item.title).sort()).toEqual(
        before.items.map((item) => item.title).sort(),
      );
    });
  }
});
