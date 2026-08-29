import { describe, expect, it } from "vitest";
import { casedTitleRoot, resolveTitleRoot } from "./titleRoot";

/**
 * The regression these guard against: `source_key` is lower-cased, real paths
 * are not, and a plain `startsWith` between them is false for every title that
 * contains a capital letter — which silently sent all title artwork to the
 * content-addressed store instead of the title's own content/ folder.
 */
describe("finding a title's folder as the filesystem spells it", () => {
  it("recovers the cased folder from the file beneath it", () => {
    expect(
      casedTitleRoot(
        "movies/dune (2021)",
        "Movies/Dune (2021)/Dune (2021) [438631].mp4",
      ),
    ).toBe("Movies/Dune (2021)");
  });

  it("resolves a movie from its own primary file", () => {
    expect(
      resolveTitleRoot({
        kind: "movie",
        sourceKey: "movie:movies/ford v ferrari (2019)",
        primaryRelativePath:
          "Movies/Ford v Ferrari (2019)/Ford v Ferrari (2019) [359724].mp4",
      }),
    ).toBe("Movies/Ford v Ferrari (2019)");
  });

  /** A series owns no file of its own; its episodes sit two levels down. */
  it("resolves a series from a descendant episode", () => {
    expect(
      resolveTitleRoot({
        kind: "series",
        sourceKey: "series:series/andor",
        primaryRelativePath: null,
        descendantRelativePath:
          "Series/Andor/Season 1/Andor - S01E01 - Kassa.mp4",
      }),
    ).toBe("Series/Andor");
  });

  it("gives nothing rather than a plausible wrong folder", () => {
    expect(
      casedTitleRoot("movies/dune (2021)", "Movies/Dune (1984)/Dune.mp4"),
    ).toBeUndefined();
    expect(casedTitleRoot("movies/dune (2021)", null)).toBeUndefined();
    expect(
      casedTitleRoot(undefined, "Movies/Dune (2021)/x.mp4"),
    ).toBeUndefined();
  });

  /** A path that stops at the root names no file inside it. */
  it("rejects a path that does not reach past the root", () => {
    expect(casedTitleRoot("movies/dune (2021)", "Movies/Dune (2021)")).toBe(
      undefined,
    );
  });

  it("returns nothing when the key carries no matching kind prefix", () => {
    expect(
      resolveTitleRoot({
        kind: "movie",
        sourceKey: "series:series/andor",
        primaryRelativePath: "Series/Andor/x.mp4",
      }),
    ).toBeUndefined();
  });
});
