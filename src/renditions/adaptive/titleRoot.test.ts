import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  besideTitleRoot,
  candidateTitleRoots,
  nestedTitleRoot,
  resolveTitleRoot,
  titleManifestPath,
  titleRootFor,
  titleRootLayoutForKind,
} from "./titleRoot";

const MOVIE = "/media/Movies/Dune (2021)/Dune (2021).mp4";
const EPISODE = "/media/Series/Andor/Season 1/Andor - S01E01 - Kassa.mp4";

describe("where a title's package lives", () => {
  it("keeps a movie's package beside the movie, as it has always been", () => {
    expect(besideTitleRoot(MOVIE)).toBe("/media/Movies/Dune (2021)");
    expect(titleRootFor(MOVIE, "beside")).toBe("/media/Movies/Dune (2021)");
    expect(titleRootLayoutForKind("movie")).toBe("beside");
  });

  it("gives an episode its own folder inside the shared season folder", () => {
    expect(titleRootLayoutForKind("episode")).toBe("nested");
    expect(nestedTitleRoot(EPISODE)).toBe(
      "/media/Series/Andor/Season 1/Andor - S01E01 - Kassa",
    );
  });

  /*
   * The property that matters. Every one of these sources sits in a folder it
   * shares with other episodes, or shares a name with an episode of another
   * show. None of them may resolve to the same bytes.
   */
  it("keeps every episode of every season of every show apart", () => {
    const sources = [
      "/media/Series/Andor/Season 1/Andor - S01E01 - Kassa.mp4",
      "/media/Series/Andor/Season 1/Andor - S01E02 - That Would Be Me.mp4",
      "/media/Series/Andor/Season 2/Andor - S02E01 - One Year Later.mp4",
      "/media/Series/Arcane/Season 1/Arcane - S01E01 - Welcome.mp4",
      "/media/Series/Ezel/Season 1/Ezel - S01E01 - Episode 1.mp4",
      "/media/Series/The Sopranos/Season 1/The Sopranos - S01E01 - Pilot.mp4",
    ];
    const roots = sources.map((source) => nestedTitleRoot(source));
    expect(new Set(roots).size).toBe(sources.length);
  });

  /*
   * `.mkv` and `.mp4` of one episode are two representations of the same
   * episode, and only the canonical one is ever processed. Were both to be,
   * their roots differ only by the stem, which is the same — so they would
   * collide. The catalogue is what prevents that; this records that the path
   * layer alone does not, so nobody removes the canonical-file selection
   * believing this covers it.
   */
  it("does not, on its own, separate two containers of one episode", () => {
    const mkv = "/media/Series/House of the Dragon/Season 3/HotD - S03E05.mkv";
    const mp4 = "/media/Series/House of the Dragon/Season 3/HotD - S03E05.mp4";
    expect(nestedTitleRoot(mkv)).toBe(nestedTitleRoot(mp4));
  });

  it("offers the nested root before the shared one, and only once", () => {
    expect(candidateTitleRoots(EPISODE)).toEqual([
      "/media/Series/Andor/Season 1/Andor - S01E01 - Kassa",
      "/media/Series/Andor/Season 1",
    ]);
  });

  it("names the manifest inside whichever root it is given", () => {
    expect(titleManifestPath("/a/b")).toBe(
      path.join("/a/b", ".seyirlik", "package.json"),
    );
  });
});

describe("resolving the root a package is actually at", () => {
  const nestedManifest = titleManifestPath(nestedTitleRoot(EPISODE));
  const besideManifest = titleManifestPath(besideTitleRoot(MOVIE));

  it("finds a movie package beside its source", async () => {
    const root = await resolveTitleRoot(
      MOVIE,
      "beside",
      async (candidate) => candidate === besideManifest,
    );
    expect(root).toBe("/media/Movies/Dune (2021)");
  });

  it("finds an episode package in its nested root", async () => {
    const root = await resolveTitleRoot(
      EPISODE,
      "beside",
      async (candidate) => candidate === nestedManifest,
    );
    expect(root).toBe("/media/Series/Andor/Season 1/Andor - S01E01 - Kassa");
  });

  /*
   * A reader with no package to go on must not answer "the season folder" for
   * an episode: that is where a stray manifest belonging to nothing would be,
   * and it is where a write would collide. The fallback layout decides.
   */
  it("falls back to the layout it was told, not to the directory", async () => {
    expect(await resolveTitleRoot(EPISODE, "nested", async () => false)).toBe(
      "/media/Series/Andor/Season 1/Andor - S01E01 - Kassa",
    );
    expect(await resolveTitleRoot(MOVIE, "beside", async () => false)).toBe(
      "/media/Movies/Dune (2021)",
    );
  });

  it("prefers the nested root when both somehow hold a manifest", async () => {
    const root = await resolveTitleRoot(EPISODE, "beside", async () => true);
    expect(root).toBe("/media/Series/Andor/Season 1/Andor - S01E01 - Kassa");
  });
});

/*
 * Regression: a season-level legacy package belongs to at most one episode.
 * A catalogue-aware episode must not fall back to that shared parent merely
 * because its own nested package has not been created yet.
 */
import {
  besideTitleRoot as regressionBesideTitleRoot,
  nestedTitleRoot as regressionNestedTitleRoot,
  resolveTitleRoot as regressionResolveTitleRoot,
  titleManifestPath as regressionTitleManifestPath,
} from "./titleRoot";

describe("strict nested title resolution", () => {
  it("strict nested titles never inherit a sibling package", async () => {
    const source =
      "/media/Series/Arcane/Season 1/Arcane - S01E02 - Some Mysteries Are Better Left Unsolved.mp4";

    const besideManifest = regressionTitleManifestPath(
      regressionBesideTitleRoot(source),
    );

    const checked: string[] = [];

    const resolved = await regressionResolveTitleRoot(
      source,
      "nested",
      async (candidate) => {
        checked.push(candidate);

        // Simulate the exact broken Arcane state:
        // no S01E02 package, but Season 1/.seyirlik/package.json exists.
        return candidate === besideManifest;
      },
    );

    expect(resolved).toBe(regressionNestedTitleRoot(source));

    // Catalogue-aware episode resolution does not even ask whether the
    // ambiguous season-level manifest exists.
    expect(checked).toEqual([]);
  });
});
