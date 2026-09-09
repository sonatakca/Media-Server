// @vitest-environment node
import { describe, expect, it } from "vitest";
import { desiredFolderName, desiredSourceKey } from "./desiredItems";
import { scanLibraryTree } from "../scanner/libraryScan";
import type { ScannerFileSystem } from "../scanner/libraryScan";

/**
 * The identity a desired title reserves has to be the identity the scanner
 * will derive once the media arrives. If the two disagree the import creates a
 * second row and the monitoring, the profile and the wait are stranded on the
 * first — which is worse than having no desired items at all.
 */
function fileSystemWith(files: Record<string, number>): ScannerFileSystem {
  const directories = new Set<string>();
  for (const file of Object.keys(files)) {
    const parts = file.split("/");
    for (let i = 1; i < parts.length; i += 1) {
      directories.add(parts.slice(0, i).join("/"));
    }
  }
  return {
    readDirectory: async (directory: string) => {
      const prefix = directory === "" ? "" : `${directory}/`;
      const names = new Set<string>();
      for (const candidate of [...Object.keys(files), ...directories]) {
        if (!candidate.startsWith(prefix)) continue;
        const rest = candidate.slice(prefix.length);
        if (rest === "" || rest.includes("/")) continue;
        names.add(rest);
      }
      return [...names].map((name) => ({
        name,
        isDirectory: directories.has(prefix + name),
        isFile: files[prefix + name] !== undefined,
      }));
    },
    statFile: async (relativePath: string) => {
      const size = files[relativePath];
      if (size === undefined) throw new Error(`missing ${relativePath}`);
      return { size, mtimeMs: 1_700_000_000_000 };
    },
    readTextFile: async () => {
      throw new Error("not a text file");
    },
  } as unknown as ScannerFileSystem;
}

describe("the identity a desired title reserves", () => {
  it("matches the key the scanner derives once the film is there", async () => {
    const title = "Night of the Living Dead";
    const year = 1968;
    const folder = desiredFolderName(title, year);
    expect(folder).toBe("Night of the Living Dead (1968)");

    const scan = await scanLibraryTree({
      fileSystem: fileSystemWith({
        [`Movies/${folder}/${folder}.mp4`]: 1_616_466_922,
      }),
      rootPath: "Movies",
      kind: "movies",
    });

    const movie = scan.items.find((item) => item.kind === "movie");
    expect(movie).toBeDefined();
    expect(
      desiredSourceKey({ kind: "movie", libraryRoot: "Movies", title, year }),
    ).toBe(movie!.sourceKey);
  });

  it("keeps the year, because it is what separates two films of a name", () => {
    expect(
      desiredSourceKey({
        kind: "movie",
        libraryRoot: "Movies",
        title: "Dune",
        year: 1984,
      }),
    ).not.toBe(
      desiredSourceKey({
        kind: "movie",
        libraryRoot: "Movies",
        title: "Dune",
        year: 2021,
      }),
    );
  });

  it("lower-cases, so a difference of case cannot make a duplicate", () => {
    expect(
      desiredSourceKey({
        kind: "movie",
        libraryRoot: "Movies",
        title: "GLADIATOR",
        year: 2000,
      }),
    ).toBe(
      desiredSourceKey({
        kind: "movie",
        libraryRoot: "Movies",
        title: "Gladiator",
        year: 2000,
      }),
    );
  });

  it("names a series without a year, as its folders are", () => {
    expect(
      desiredSourceKey({
        kind: "series",
        libraryRoot: "Series",
        title: "Andor",
      }),
    ).toBe("series:series/andor");
  });

  it("strips what a filesystem would refuse from the folder name", () => {
    // The importer will create this directory; a name it cannot create would
    // reserve a key nothing can ever match.
    expect(desiredFolderName('A: "Quoted" / Title', 2011)).not.toMatch(/[:"/]/);
  });
});
