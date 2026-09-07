import { describe, expect, it } from "vitest";
import type { OrganizerFileSystem } from "./organizeLibrary";
import { applyOrganizationPlan } from "./organizeLibrary";
import { planLibraryRename, type RenameCandidate } from "./renameLibrary";

/**
 * A volume held in a Set. Nothing here touches a real filesystem, and nothing
 * here is the developer's own library: renaming is the one maintenance
 * operation whose mistakes are not undoable, so its tests own their fixtures.
 */
function memoryVolume(
  paths: string[],
  options: { caseInsensitive?: boolean } = {},
) {
  const files = new Set(paths);
  const directories = new Set<string>();
  for (const path of paths) {
    const segments = path.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      directories.add(segments.slice(0, index).join("/"));
    }
  }

  const exists = (path: string): boolean =>
    options.caseInsensitive
      ? [...files].some((held) => held.toLowerCase() === path.toLowerCase())
      : files.has(path);

  const fileSystem: OrganizerFileSystem = {
    readDirectory: async (relativePath) => {
      if (!directories.has(relativePath)) throw new Error("missing");
      const prefix = `${relativePath}/`;
      const names = new Map<string, boolean>();
      for (const path of [...files, ...directories]) {
        if (!path.startsWith(prefix)) continue;
        const rest = path.slice(prefix.length);
        if (rest.includes("/")) continue;
        names.set(rest, directories.has(`${relativePath}/${rest}`));
      }
      return [...names].map(([name, isDirectory]) => ({ name, isDirectory }));
    },
    createDirectory: async (relativePath) => {
      directories.add(relativePath);
    },
    move: async (from, to) => {
      // The real adapter refuses rather than replacing, and so must this one:
      // a test volume that silently overwrote would hide the whole point.
      if (exists(to))
        throw new Error("Something is already at the destination.");
      if (!files.has(from)) throw new Error("missing source");
      files.delete(from);
      files.add(to);
    },
  };

  return { fileSystem, snapshot: () => [...files].sort() };
}

const EPISODE_DIRECTORY = "Series/Andor/Season 1";
const SERIES_KEY = "series:series/andor";

function episode(overrides: Partial<RenameCandidate> = {}): RenameCandidate {
  return {
    itemId: "item-episode",
    sourceKey: `episode:${SERIES_KEY}:1:1`,
    kind: "episode",
    title: "Kassa",
    seriesTitle: "Andor",
    seasonNumber: 1,
    indexNumber: 1,
    relativePath: `${EPISODE_DIRECTORY}/src/Andor.S01E01.1080p.WEB-DL.x265.mkv`,
    fileCount: 1,
    ...overrides,
  };
}

function movie(overrides: Partial<RenameCandidate> = {}): RenameCandidate {
  return {
    itemId: "item-movie",
    sourceKey: "movies/gladiator (2000)",
    kind: "movie",
    title: "Gladiator",
    seriesTitle: null,
    seasonNumber: null,
    indexNumber: null,
    relativePath: "Movies/Gladiator (2000)/src/Gladiator.2000.BluRay.x264.mkv",
    fileCount: 1,
    ...overrides,
  };
}

describe("planning canonical filenames", () => {
  it("names an episode from catalogue facts, not from the name it replaces", async () => {
    const volume = memoryVolume([
      `${EPISODE_DIRECTORY}/src/Andor.S01E01.1080p.WEB-DL.x265.mkv`,
    ]);

    const plan = await planLibraryRename({
      fileSystem: volume.fileSystem,
      candidates: [episode()],
    });

    expect(plan.moves).toEqual([
      {
        from: `${EPISODE_DIRECTORY}/src/Andor.S01E01.1080p.WEB-DL.x265.mkv`,
        to: `${EPISODE_DIRECTORY}/src/Andor - S01E01 - Kassa.mkv`,
        reason: "rename",
      },
    ]);
  });

  it("names a movie after the folder that already carries its identity", async () => {
    const volume = memoryVolume([
      "Movies/Gladiator (2000)/src/Gladiator.2000.BluRay.x264.mkv",
    ]);

    const plan = await planLibraryRename({
      fileSystem: volume.fileSystem,
      candidates: [movie({ sourceKey: "movie:movies/gladiator (2000)" })],
    });

    expect(plan.moves[0]?.to).toBe(
      "Movies/Gladiator (2000)/src/Gladiator (2000).mkv",
    );
  });

  it("keeps the extension and the subtitle language, forced and default suffixes", async () => {
    const volume = memoryVolume([
      `${EPISODE_DIRECTORY}/src/Andor.S01E01.1080p.mkv`,
      `${EPISODE_DIRECTORY}/src/Andor.S01E01.1080p.tr.forced.srt`,
      `${EPISODE_DIRECTORY}/src/Andor.S01E01.1080p.en.srt`,
      // Somebody else's subtitle: it matches no source and is left alone.
      `${EPISODE_DIRECTORY}/src/Unrelated.tr.srt`,
    ]);

    const plan = await planLibraryRename({
      fileSystem: volume.fileSystem,
      candidates: [
        episode({
          relativePath: `${EPISODE_DIRECTORY}/src/Andor.S01E01.1080p.mkv`,
        }),
      ],
    });

    expect(plan.moves.map((move) => move.to).sort()).toEqual([
      `${EPISODE_DIRECTORY}/src/Andor - S01E01 - Kassa.en.srt`,
      `${EPISODE_DIRECTORY}/src/Andor - S01E01 - Kassa.mkv`,
      `${EPISODE_DIRECTORY}/src/Andor - S01E01 - Kassa.tr.forced.srt`,
    ]);
  });

  it("plans nothing the second time, so the action is a no-op once it has run", async () => {
    const volume = memoryVolume([
      `${EPISODE_DIRECTORY}/src/Andor - S01E01 - Kassa.mkv`,
    ]);

    const plan = await planLibraryRename({
      fileSystem: volume.fileSystem,
      candidates: [
        episode({
          relativePath: `${EPISODE_DIRECTORY}/src/Andor - S01E01 - Kassa.mkv`,
        }),
      ],
    });

    expect(plan.moves).toEqual([]);
    expect(plan.skipped).toEqual([]);
  });

  it("changes only the basename, never the folder", async () => {
    const volume = memoryVolume([`${EPISODE_DIRECTORY}/Andor.S01E01.mkv`]);

    const plan = await planLibraryRename({
      fileSystem: volume.fileSystem,
      candidates: [
        episode({ relativePath: `${EPISODE_DIRECTORY}/Andor.S01E01.mkv` }),
      ],
    });

    for (const move of plan.moves) {
      expect(move.to.slice(0, move.to.lastIndexOf("/"))).toBe(
        move.from.slice(0, move.from.lastIndexOf("/")),
      );
    }
    expect(plan.directories).toEqual([]);
  });
});

describe("what renaming refuses to guess at", () => {
  it("skips a movie whose own filename is its catalogue identity", async () => {
    const volume = memoryVolume(["Movies/Gladiator.2000.x264.mkv"]);

    const plan = await planLibraryRename({
      fileSystem: volume.fileSystem,
      candidates: [
        movie({
          relativePath: "Movies/Gladiator.2000.x264.mkv",
          // Loose in a container: the scanner keys it by folder *and* stem.
          sourceKey: "movie:movies/gladiator.2000.x264",
        }),
      ],
    });

    expect(plan.moves).toEqual([]);
    expect(plan.skipped).toEqual([
      {
        relativePath: "Movies/Gladiator.2000.x264.mkv",
        reason: "identity-derived-from-name",
      },
    ]);
  });

  it("skips an episode the scanner identified by path rather than by number", async () => {
    const path = `${EPISODE_DIRECTORY}/src/who knows.mkv`;
    const volume = memoryVolume([path]);

    const plan = await planLibraryRename({
      fileSystem: volume.fileSystem,
      candidates: [
        episode({
          relativePath: path,
          sourceKey: `episode:${SERIES_KEY}:${path.toLowerCase()}`,
        }),
      ],
    });

    expect(plan.skipped[0]?.reason).toBe("identity-derived-from-name");
  });

  it("skips a title with several files rather than deciding which cut is which", async () => {
    const volume = memoryVolume([
      "Movies/Gladiator (2000)/src/Gladiator.2000.Extended.mkv",
    ]);

    const plan = await planLibraryRename({
      fileSystem: volume.fileSystem,
      candidates: [
        movie({
          sourceKey: "movie:movies/gladiator (2000)",
          relativePath:
            "Movies/Gladiator (2000)/src/Gladiator.2000.Extended.mkv",
          fileCount: 2,
        }),
      ],
    });

    expect(plan.moves).toEqual([]);
    expect(plan.skipped[0]?.reason).toBe("multiple-files");
  });

  it("skips an episode whose series is not identified", async () => {
    const path = `${EPISODE_DIRECTORY}/src/Andor.S01E01.mkv`;
    const volume = memoryVolume([path]);

    const plan = await planLibraryRename({
      fileSystem: volume.fileSystem,
      candidates: [episode({ relativePath: path, seriesTitle: null })],
    });

    expect(plan.skipped[0]?.reason).toBe("insufficient-facts");
  });

  it("never overwrites an occupied destination, case-insensitively", async () => {
    const volume = memoryVolume([
      `${EPISODE_DIRECTORY}/src/Andor.S01E01.mkv`,
      `${EPISODE_DIRECTORY}/src/andor - s01e01 - kassa.mkv`,
    ]);

    const plan = await planLibraryRename({
      fileSystem: volume.fileSystem,
      candidates: [
        episode({ relativePath: `${EPISODE_DIRECTORY}/src/Andor.S01E01.mkv` }),
      ],
    });

    expect(plan.moves).toEqual([]);
    expect(plan.skipped[0]?.reason).toBe("destination-occupied");
  });

  it("skips a rename that differs only in case", async () => {
    const path = `${EPISODE_DIRECTORY}/src/andor - s01e01 - kassa.mkv`;
    const volume = memoryVolume([path], { caseInsensitive: true });

    const plan = await planLibraryRename({
      fileSystem: volume.fileSystem,
      candidates: [episode({ relativePath: path })],
    });

    expect(plan.moves).toEqual([]);
    expect(plan.skipped[0]?.reason).toBe("case-only");
  });

  it("strips characters a filesystem cannot carry", async () => {
    const path = `${EPISODE_DIRECTORY}/src/Andor.S01E01.mkv`;
    const volume = memoryVolume([path]);

    const plan = await planLibraryRename({
      fileSystem: volume.fileSystem,
      candidates: [episode({ relativePath: path, title: 'Ka/ss\\a: "one"?' })],
    });

    expect(plan.moves[0]?.to).toBe(
      `${EPISODE_DIRECTORY}/src/Andor - S01E01 - Kassa one.mkv`,
    );
  });
});

describe("carrying a rename plan out", () => {
  it("records what succeeded and reports what failed, and stays retryable", async () => {
    const volume = memoryVolume([
      `${EPISODE_DIRECTORY}/src/Andor.S01E01.mkv`,
      `${EPISODE_DIRECTORY}/src/Andor.S01E02.mkv`,
    ]);
    const plan = await planLibraryRename({
      fileSystem: volume.fileSystem,
      candidates: [
        episode({ relativePath: `${EPISODE_DIRECTORY}/src/Andor.S01E01.mkv` }),
        episode({
          itemId: "item-episode-2",
          sourceKey: `episode:${SERIES_KEY}:1:2`,
          indexNumber: 2,
          title: "That Would Be Me",
          relativePath: `${EPISODE_DIRECTORY}/src/Andor.S01E02.mkv`,
        }),
      ],
    });

    // One of the two moves is made impossible after planning — a file opened
    // by something else, a permission — and must not take the other with it.
    const flaky: OrganizerFileSystem = {
      ...volume.fileSystem,
      move: async (from, to) => {
        if (from.endsWith("S01E02.mkv")) throw new Error("device is busy");
        await volume.fileSystem.move(from, to);
      },
    };

    const applied = await applyOrganizationPlan(flaky, plan);

    expect(applied.moved).toHaveLength(1);
    expect(applied.failed).toHaveLength(1);
    expect(volume.snapshot()).toEqual([
      `${EPISODE_DIRECTORY}/src/Andor - S01E01 - Kassa.mkv`,
      `${EPISODE_DIRECTORY}/src/Andor.S01E02.mkv`,
    ]);

    // Re-planning from the volume as it actually is: the finished one is done,
    // the failed one is still there to try again.
    const retry = await planLibraryRename({
      fileSystem: volume.fileSystem,
      candidates: [
        episode({
          relativePath: `${EPISODE_DIRECTORY}/src/Andor - S01E01 - Kassa.mkv`,
        }),
        episode({
          itemId: "item-episode-2",
          sourceKey: `episode:${SERIES_KEY}:1:2`,
          indexNumber: 2,
          title: "That Would Be Me",
          relativePath: `${EPISODE_DIRECTORY}/src/Andor.S01E02.mkv`,
        }),
      ],
    });
    expect(retry.moves.map((move) => move.to)).toEqual([
      `${EPISODE_DIRECTORY}/src/Andor - S01E02 - That Would Be Me.mkv`,
    ]);
  });

  it("is a no-op when run again after it succeeded", async () => {
    const volume = memoryVolume([`${EPISODE_DIRECTORY}/src/Andor.S01E01.mkv`]);
    const candidates = [
      episode({ relativePath: `${EPISODE_DIRECTORY}/src/Andor.S01E01.mkv` }),
    ];

    const first = await planLibraryRename({
      fileSystem: volume.fileSystem,
      candidates,
    });
    await applyOrganizationPlan(volume.fileSystem, first);

    const second = await planLibraryRename({
      fileSystem: volume.fileSystem,
      candidates: [
        episode({
          relativePath: `${EPISODE_DIRECTORY}/src/Andor - S01E01 - Kassa.mkv`,
        }),
      ],
    });
    const applied = await applyOrganizationPlan(volume.fileSystem, second);

    expect(second.moves).toEqual([]);
    expect(applied.moved).toEqual([]);
    expect(volume.snapshot()).toEqual([
      `${EPISODE_DIRECTORY}/src/Andor - S01E01 - Kassa.mkv`,
    ]);
  });
});
