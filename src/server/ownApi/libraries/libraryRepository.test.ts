import { describe, expect, it } from "vitest";
import { parseLibraryDefinitions } from "./libraryRepository";

describe("parseLibraryDefinitions", () => {
  it("returns no libraries when the variable is unset or blank", () => {
    expect(parseLibraryDefinitions(undefined)).toEqual([]);
    expect(parseLibraryDefinitions("   ")).toEqual([]);
  });

  it("parses a valid definition and normalizes root separators", () => {
    expect(
      parseLibraryDefinitions(
        JSON.stringify([
          { slug: "movies", name: " Movies ", kind: "movies", roots: ["Movies\\4K", "/Movies/"] },
        ]),
      ),
    ).toEqual([
      {
        slug: "movies",
        name: "Movies",
        kind: "movies",
        roots: ["Movies/4K", "Movies"],
        sortOrder: 0,
      },
    ]);
  });

  it("rejects malformed JSON and non-arrays", () => {
    expect(() => parseLibraryDefinitions("{")).toThrow(/valid JSON/);
    expect(() => parseLibraryDefinitions('{"slug":"a"}')).toThrow(/JSON array/);
  });

  it("rejects an unknown library kind", () => {
    expect(() =>
      parseLibraryDefinitions(
        JSON.stringify([{ slug: "x", name: "X", kind: "music", roots: ["X"] }]),
      ),
    ).toThrow(/kind must be one of/);
  });

  it("rejects a slug that is not URL safe", () => {
    expect(() =>
      parseLibraryDefinitions(
        JSON.stringify([{ slug: "My Movies", name: "X", kind: "movies", roots: ["X"] }]),
      ),
    ).toThrow(/slug must be lowercase/);
  });

  it("treats a leading slash as relative to the media root", () => {
    expect(
      parseLibraryDefinitions(
        JSON.stringify([
          { slug: "movies", name: "Movies", kind: "movies", roots: ["/Movies"] },
        ]),
      )[0]?.roots,
    ).toEqual(["Movies"]);
  });

  it("rejects drive letters, UNC paths and traversal so a misconfiguration fails at startup", () => {
    for (const root of ["C:\\Windows", "//server/share", "../outside", "Movies/../../etc"]) {
      expect(() =>
        parseLibraryDefinitions(
          JSON.stringify([
            { slug: "movies", name: "Movies", kind: "movies", roots: [root] },
          ]),
        ),
      ).toThrow(/relative to the media root/);
    }
  });

  it("rejects a library with no roots", () => {
    expect(() =>
      parseLibraryDefinitions(
        JSON.stringify([{ slug: "movies", name: "Movies", kind: "movies", roots: [] }]),
      ),
    ).toThrow(/non-empty paths/);
  });

  it("preserves declaration order as sort order", () => {
    const definitions = parseLibraryDefinitions(
      JSON.stringify([
        { slug: "movies", name: "Movies", kind: "movies", roots: ["Movies"] },
        { slug: "shows", name: "Shows", kind: "series", roots: ["Shows"] },
      ]),
    );
    expect(definitions.map((definition) => definition.sortOrder)).toEqual([0, 1]);
  });
});
