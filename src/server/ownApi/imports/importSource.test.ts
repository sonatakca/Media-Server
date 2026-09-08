// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  classifyFile,
  inspectSource,
  isQuiescent,
  samplesOf,
  type ImportEntry,
  type RootedReadFileSystem,
} from "./importSource";

/**
 * A tree, as nested plain objects. A string is a file of that many bytes.
 */
type Tree = { [name: string]: Tree | number | { link: true } };

function fakeFileSystem(tree: Tree, root = "/downloads"): RootedReadFileSystem {
  function at(relative: string): Tree | number | { link: true } | undefined {
    if (!relative) return tree;
    let node: Tree | number | { link: true } | undefined = tree;
    for (const segment of relative.split("/")) {
      if (typeof node !== "object" || node === null || "link" in node) {
        return undefined;
      }
      node = (node as Tree)[segment];
      if (node === undefined) return undefined;
    }
    return node;
  }

  function entryFor(
    name: string,
    node: Tree | number | { link: true },
  ): ImportEntry {
    if (typeof node === "number") {
      return {
        name,
        isDirectory: false,
        isSymbolicLink: false,
        sizeBytes: node,
        mtimeMs: 1_000,
      };
    }
    if ("link" in node) {
      return {
        name,
        isDirectory: false,
        isSymbolicLink: true,
        sizeBytes: 0,
        mtimeMs: 1_000,
      };
    }
    return {
      name,
      isDirectory: true,
      isSymbolicLink: false,
      sizeBytes: 0,
      mtimeMs: 1_000,
    };
  }

  return {
    root,
    list: async (relative) => {
      const node = at(relative);
      if (typeof node !== "object" || node === null || "link" in node) {
        throw new Error(`Not a directory: ${relative}`);
      }
      return Object.entries(node as Tree).map(([name, child]) =>
        entryFor(name, child),
      );
    },
    stat: async (relative) => {
      const node = at(relative);
      if (node === undefined) return null;
      const name = relative.split("/").at(-1) ?? relative;
      return entryFor(name, node);
    },
  };
}

const RELEASE = "Dune.Part.Two.2024.1080p.WEB-DL";

describe("what a file in a download is", () => {
  it.each([
    ["Dune.mkv", "media"],
    ["Dune.mp4", "media"],
    ["Dune.en.srt", "subtitle"],
    ["Dune.nfo", "metadata"],
    ["poster.jpg", "artwork"],
    ["Dune-sample.mkv", "sample"],
    ["Dune.trailer.mkv", "trailer"],
    ["release.rar", "ignored"],
    ["release.r00", "ignored"],
    ["release.par2", "ignored"],
    ["rules.txt", "ignored"],
    [".DS_Store", "ignored"],
    ["Thumbs.db", "ignored"],
    ["setup.exe", "unclaimed"],
    ["something.weird", "unclaimed"],
  ] as const)("reads %s as %s", (name, role) => {
    expect(classifyFile(name, 1_000)).toBe(role);
  });

  it("declines a zero-length video rather than calling it strange", () => {
    // Recognised and unusable. If it was the only candidate the import
    // complains that it found no media, which is the honest failure.
    expect(classifyFile("Dune.mkv", 0)).toBe("ignored");
    expect(classifyFile("Dune.mkv", 1)).toBe("media");
  });

  it("lets the folder decide what the file inside it is", () => {
    expect(classifyFile("Dune.mkv", 1_000, "sample")).toBe("sample");
    expect(classifyFile("Dune.mkv", 1_000, "extra")).toBe("extra");
    expect(classifyFile("Dune.en.srt", 1_000, "sample")).toBe("sample");
    expect(classifyFile("Dune.en.srt", 1_000, "subtitles")).toBe("subtitle");
  });
});

describe("walking a finished download", () => {
  it("claims the feature and leaves the rest alone", async () => {
    const inspection = await inspectSource({
      fileSystem: fakeFileSystem({
        [RELEASE]: {
          "Dune.Part.Two.2024.1080p.WEB-DL.mkv": 8_000_000_000,
          "Dune.Part.Two.2024.1080p.WEB-DL.nfo": 1_200,
          "poster.jpg": 90_000,
          "release.nzb": 40_000,
          Sample: { "sample.mkv": 30_000_000 },
        },
      }),
      relative: RELEASE,
    });

    expect(inspection.problem).toBeUndefined();
    expect(inspection.media.map((file) => file.relative)).toEqual([
      `${RELEASE}/Dune.Part.Two.2024.1080p.WEB-DL.mkv`,
    ]);
    expect(inspection.totalBytes).toBe(8_000_000_000);
    expect(inspection.metadata).toHaveLength(1);
    const roles = inspection.files.map((file) => file.role);
    expect(roles).toContain("artwork");
    expect(roles).toContain("ignored");
    expect(roles).toContain("sample");
  });

  it("finds subtitles in the folder a release actually keeps them in", async () => {
    /*
     * The scanner counts `Subs/` as an extra, because in a library a folder of
     * video beside a film would scan as more films. In a download it is where
     * the subtitles are, so the import descends into it.
     */
    const inspection = await inspectSource({
      fileSystem: fakeFileSystem({
        [RELEASE]: {
          "Dune.mkv": 8_000_000_000,
          Subs: { "2_English.srt": 90_000, "3_Turkish.srt": 95_000 },
        },
      }),
      relative: RELEASE,
    });
    expect(inspection.subtitles.map((file) => file.relative)).toEqual([
      `${RELEASE}/Subs/2_English.srt`,
      `${RELEASE}/Subs/3_Turkish.srt`,
    ]);
  });

  it("keeps a sample out of the feature even when it is a real video", async () => {
    const inspection = await inspectSource({
      fileSystem: fakeFileSystem({
        [RELEASE]: {
          "Dune.mkv": 8_000_000_000,
          Sample: { "Dune-sample.mkv": 30_000_000 },
          Extras: { "Deleted Scene.mkv": 400_000_000 },
        },
      }),
      relative: RELEASE,
    });
    expect(inspection.media).toHaveLength(1);
    expect(inspection.media[0]!.relative).toBe(`${RELEASE}/Dune.mkv`);
  });

  it("does not let a nested folder widen back into the release", async () => {
    // A folder inside Extras is still extras, however it is named.
    const inspection = await inspectSource({
      fileSystem: fakeFileSystem({
        [RELEASE]: {
          "Dune.mkv": 8_000_000_000,
          Extras: { Anything: { "Bonus.mkv": 500_000_000 } },
        },
      }),
      relative: RELEASE,
    });
    expect(inspection.media).toHaveLength(1);
  });

  it("carries a multi-file release as several media files", async () => {
    const inspection = await inspectSource({
      fileSystem: fakeFileSystem({
        Pack: {
          "Show.S01E01.mkv": 2_000_000_000,
          "Show.S01E02.mkv": 2_100_000_000,
          "Show.S01E03.mkv": 2_050_000_000,
        },
      }),
      relative: "Pack",
    });
    expect(inspection.media).toHaveLength(3);
    expect(inspection.totalBytes).toBe(6_150_000_000);
  });

  it("imports a download that is a single file", async () => {
    const inspection = await inspectSource({
      fileSystem: fakeFileSystem({ "Dune.mkv": 8_000_000_000 }),
      relative: "Dune.mkv",
    });
    expect(inspection.problem).toBeUndefined();
    expect(inspection.media[0]!.relative).toBe("Dune.mkv");
  });
});

describe("what it refuses", () => {
  it("says so when the download is not where the handoff said", async () => {
    const inspection = await inspectSource({
      fileSystem: fakeFileSystem({}),
      relative: "gone",
    });
    expect(inspection.problem).toBe("source-missing");
  });

  it("refuses a handoff that is itself a link", async () => {
    /*
     * Containment would catch a link pointing outside the root, but a link
     * pointing inside it is still not the thing SABnzbd said it downloaded.
     */
    const inspection = await inspectSource({
      fileSystem: fakeFileSystem({ [RELEASE]: { link: true } }),
      relative: RELEASE,
    });
    expect(inspection.problem).toBe("source-not-regular");
  });

  it("never claims a link found inside a download", async () => {
    const inspection = await inspectSource({
      fileSystem: fakeFileSystem({
        [RELEASE]: {
          "Dune.mkv": 8_000_000_000,
          "elsewhere.mkv": { link: true },
        },
      }),
      relative: RELEASE,
    });
    expect(inspection.media).toHaveLength(1);
    const link = inspection.files.find((file) =>
      file.relative.endsWith("elsewhere.mkv"),
    );
    expect(link?.role).toBe("unclaimed");
  });

  it("complains when there is nothing it would move", async () => {
    const inspection = await inspectSource({
      fileSystem: fakeFileSystem({
        [RELEASE]: { "release.rar": 5_000_000, "readme.txt": 200 },
      }),
      relative: RELEASE,
    });
    expect(inspection.problem).toBe("no-media-found");
  });

  it("refuses to walk a tree deeper than it will walk", async () => {
    // An importer that will walk anything can be made to walk forever.
    let deep: Tree = { "Dune.mkv": 1_000 };
    for (let level = 0; level < 12; level += 1) deep = { [`d${level}`]: deep };
    const inspection = await inspectSource({
      fileSystem: fakeFileSystem({ [RELEASE]: deep }),
      relative: RELEASE,
      maxDepth: 4,
    });
    expect(inspection.problem).toBe("no-media-found");
  });

  it("refuses a download with more entries than it will examine", async () => {
    const many: Tree = {};
    for (let index = 0; index < 60; index += 1) many[`f${index}.txt`] = 10;
    const inspection = await inspectSource({
      fileSystem: fakeFileSystem({ [RELEASE]: many }),
      relative: RELEASE,
      maxEntries: 20,
    });
    expect(inspection.problem).toBe("no-media-found");
  });
});

describe("deciding the bytes have stopped moving", () => {
  const a = [{ relative: "a.mkv", sizeBytes: 100, mtimeMs: 5 }];

  it("agrees when nothing changed", () => {
    expect(isQuiescent(a, [...a])).toBe(true);
  });

  it("refuses a file that is still growing", () => {
    expect(
      isQuiescent(a, [{ relative: "a.mkv", sizeBytes: 200, mtimeMs: 5 }]),
    ).toBe(false);
  });

  it("refuses a file rewritten at the same size", () => {
    // Same length, new contents: an unpack that replaced it in place.
    expect(
      isQuiescent(a, [{ relative: "a.mkv", sizeBytes: 100, mtimeMs: 9 }]),
    ).toBe(false);
  });

  it("refuses when a file appeared or vanished between the samples", () => {
    expect(isQuiescent(a, [])).toBe(false);
    expect(
      isQuiescent(a, [...a, { relative: "b.mkv", sizeBytes: 10, mtimeMs: 5 }]),
    ).toBe(false);
  });

  it("watches only the files it would move", async () => {
    /*
     * A metadata file being rewritten beside a finished film is not a reason
     * to refuse the film.
     */
    const inspection = await inspectSource({
      fileSystem: fakeFileSystem({
        [RELEASE]: { "Dune.mkv": 8_000_000_000, "Dune.nfo": 1_200 },
      }),
      relative: RELEASE,
    });
    expect(samplesOf(inspection)).toEqual([
      {
        relative: `${RELEASE}/Dune.mkv`,
        sizeBytes: 8_000_000_000,
        mtimeMs: 1_000,
      },
    ]);
  });
});
