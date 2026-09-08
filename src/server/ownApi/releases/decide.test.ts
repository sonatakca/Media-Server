// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { IndexerRelease } from "../indexers/indexerTypes";
import { compareCandidates, selectRelease, type MediaTarget } from "./decide";
import { HEVC_PREFERENCE } from "./preferences";
import { profileFromIds } from "./qualityProfile";
import { qualityOf } from "./quality";
import { parseRelease } from "./parseRelease";

let counter = 0;
function release(
  title: string,
  extra: Partial<IndexerRelease> = {},
): IndexerRelease {
  counter += 1;
  return {
    indexerId: "ix",
    indexerName: "Indexer",
    protocol: "usenet",
    guid: `guid-${String(counter).padStart(4, "0")}`,
    title,
    downloadUrl: "https://x.invalid/get?apikey=SECRET",
    categoryIds: [2000],
    attributes: {},
    ...extra,
  };
}

const profile = profileFromIds(
  "hd",
  "HD-1080p",
  ["hdtv-1080p", "webrip-1080p", "webdl-1080p", "bluray-1080p", "remux-1080p"],
  { cutoffQualityId: "bluray-1080p" },
);

const wide = profileFromIds(
  "wide",
  "Wide",
  [
    ["webrip-1080p", "webdl-1080p", "bluray-1080p"],
    ["webrip-2160p", "webdl-2160p", "bluray-2160p"],
  ],
  { cutoffQualityId: "webrip-2160p" },
);

const movie: MediaTarget = {
  kind: "movie",
  title: "blade runner 2049",
  year: 2017,
};
const policy = { profile, preferences: [HEVC_PREFERENCE], current: null };

describe("choosing a release for a movie", () => {
  it("picks the best allowed candidate and explains the rest", () => {
    const result = selectRelease(
      movie,
      [
        release("Blade.Runner.2049.2017.1080p.WEB-DL.x264-A"),
        release("Blade.Runner.2049.2017.1080p.BluRay.x264-B"),
        release("Blade.Runner.2049.2017.720p.HDTV.x264-C"),
      ],
      policy,
    );
    expect(result.winner?.release.title).toContain("BluRay");
    expect(result.candidates).toHaveLength(3);
    const rejected = result.candidates.find((c) => !c.accepted);
    expect(rejected?.rejection).toBe("quality-not-allowed");
  });

  it("returns no winner rather than a bad one when nothing is acceptable", () => {
    const result = selectRelease(
      movie,
      [
        release("Blade.Runner.2049.2017.720p.HDTV-C"),
        release("Some.Other.Film.2019.1080p.BluRay-D"),
      ],
      policy,
    );
    expect(result.winner).toBeUndefined();
    expect(result.candidates.every((c) => !c.accepted)).toBe(true);
  });

  it("keeps every candidate, including the rejected ones", () => {
    // Nothing is silently dropped: a rejected candidate is the answer to
    // "why not that one", which is the question an operator actually asks.
    const result = selectRelease(
      movie,
      [
        release("Blade.Runner.2049.2017.1080p.BluRay-A"),
        release("Completely.Different.2020.1080p.BluRay-B"),
        release("Blade.Runner.2049.2019.1080p.BluRay-C"),
      ],
      policy,
    );
    expect(result.candidates).toHaveLength(3);
    expect(
      result.candidates
        .map((c) => c.rejection)
        .filter(Boolean)
        .sort(),
    ).toEqual(["title-mismatch", "wrong-year"]);
  });

  it.each([
    ["Completely.Different.Film.2017.1080p.BluRay-X", "title-mismatch"],
    ["Blade.Runner.2049.2011.1080p.BluRay-X", "wrong-year"],
    ["Blade.Runner.2049.2017.720p.HDTV-X", "quality-not-allowed"],
    ["Blade.Runner.2049.S01E01.1080p.BluRay-X", "wrong-kind"],
  ])("rejects %s as %s", (title, code) => {
    const result = selectRelease(movie, [release(title)], policy);
    expect(result.candidates[0]!.rejection).toBe(code);
    expect(result.winner).toBeUndefined();
  });

  it("tolerates a year that drifts by one but not by more", () => {
    // A December release is routinely tagged with the following year.
    expect(
      selectRelease(
        movie,
        [release("Blade.Runner.2049.2018.1080p.BluRay-X")],
        policy,
      ).winner,
    ).toBeDefined();
    expect(
      selectRelease(
        movie,
        [release("Blade.Runner.2049.2015.1080p.BluRay-X")],
        policy,
      ).winner,
    ).toBeUndefined();
  });

  it("does not require a year the release never stated", () => {
    expect(
      selectRelease(
        movie,
        [release("Blade.Runner.2049.1080p.BluRay-X")],
        policy,
      ).winner,
    ).toBeDefined();
  });
});

describe("choosing a release for television", () => {
  const episode: MediaTarget = {
    kind: "episode",
    title: "the expanse",
    season: 5,
    episode: 3,
  };
  const season: MediaTarget = {
    kind: "season",
    title: "the expanse",
    season: 5,
  };

  it("accepts the exact episode", () => {
    const result = selectRelease(
      episode,
      [release("The.Expanse.S05E03.1080p.WEB-DL.x264-NTb")],
      policy,
    );
    expect(result.winner).toBeDefined();
  });

  it("rejects the wrong episode and the wrong season, distinctly", () => {
    expect(
      selectRelease(
        episode,
        [release("The.Expanse.S05E04.1080p.WEB-DL-X")],
        policy,
      ).candidates[0]!.rejection,
    ).toBe("wrong-episode");
    expect(
      selectRelease(
        episode,
        [release("The.Expanse.S04E03.1080p.WEB-DL-X")],
        policy,
      ).candidates[0]!.rejection,
    ).toBe("wrong-season");
  });

  it("accepts a season pack as containing the episode", () => {
    const result = selectRelease(
      episode,
      [release("The.Expanse.S05.1080p.WEB-DL.x264-NTb")],
      policy,
    );
    expect(result.winner).toBeDefined();
    expect(result.winner?.facts.isSeasonPack).toBe(true);
  });

  it("accepts a pack for a season, and refuses a single episode for one", () => {
    expect(
      selectRelease(season, [release("The.Expanse.S05.1080p.WEB-DL-X")], policy)
        .winner,
    ).toBeDefined();
    expect(
      selectRelease(
        season,
        [release("The.Expanse.S05E03.1080p.WEB-DL-X")],
        policy,
      ).candidates[0]!.rejection,
    ).toBe("wrong-kind");
  });

  it("matches a series title with an article in only one of the two", () => {
    const result = selectRelease(
      { kind: "episode", title: "expanse", season: 5, episode: 3 },
      [release("The.Expanse.S05E03.1080p.WEB-DL-X")],
      policy,
    );
    expect(result.winner).toBeDefined();
  });
});

describe("preferring one acceptable release over another", () => {
  it("prefers the better profile rank before anything else", () => {
    const result = selectRelease(
      movie,
      [
        release("Blade.Runner.2049.2017.1080p.WEB-DL.x265-A"),
        release("Blade.Runner.2049.2017.1080p.BluRay.x264-B"),
      ],
      policy,
    );
    // BluRay outranks WEB-DL even though the WEB-DL scores 100 for HEVC.
    expect(result.winner?.release.title).toContain("BluRay");
  });

  it("prefers the higher score when the rank is equal", () => {
    const result = selectRelease(
      movie,
      [
        release("Blade.Runner.2049.2017.2160p.WEB-DL.x264-A"),
        release("Blade.Runner.2049.2017.2160p.WEB-DL.x265-B"),
      ],
      { ...policy, profile: wide },
    );
    expect(result.winner?.score).toBe(100);
    expect(result.winner?.release.title).toContain("x265");
  });

  it("prefers a PROPER over the release it replaces", () => {
    const result = selectRelease(
      movie,
      [
        release("Blade.Runner.2049.2017.1080p.BluRay.x264-A"),
        release("Blade.Runner.2049.2017.PROPER.1080p.BluRay.x264-A"),
      ],
      policy,
    );
    expect(result.winner?.facts.proper).toBe(true);
  });

  it("separates qualities the profile grouped together", () => {
    const result = selectRelease(
      movie,
      [
        release("Blade.Runner.2049.2017.2160p.WEBRip.x264-A"),
        release("Blade.Runner.2049.2017.2160p.BluRay.x264-B"),
      ],
      { ...policy, profile: wide },
    );
    expect(result.winner?.release.title).toContain("BluRay");
  });

  it("prefers the larger file when everything else is identical", () => {
    const result = selectRelease(
      movie,
      [
        release("Blade.Runner.2049.2017.1080p.BluRay.x264-A", {
          sizeBytes: 1_000,
        }),
        release("Blade.Runner.2049.2017.1080p.BluRay.x264-A", {
          sizeBytes: 9_000,
        }),
      ],
      policy,
    );
    expect(result.winner?.release.sizeBytes).toBe(9_000);
  });
});

describe("invariants the engine must not break", () => {
  const candidates = [
    release("Blade.Runner.2049.2017.1080p.WEB-DL.x265-A", { sizeBytes: 5_000 }),
    release("Blade.Runner.2049.2017.1080p.BluRay.x264-B", { sizeBytes: 8_000 }),
    release("Blade.Runner.2049.2017.720p.HDTV-C", { sizeBytes: 2_000 }),
    release("Other.Film.2020.1080p.BluRay-D", { sizeBytes: 3_000 }),
    release("Blade.Runner.2049.2017.1080p.BluRay.x264-B", { sizeBytes: 8_000 }),
  ];

  it("picks the same winner whatever order the candidates arrive in", () => {
    /*
     * An indexer returns results in whatever order it likes. A comparison that
     * returned 0 for two different releases would quietly hand the choice to
     * that order, which is why the ladder ends in a stable identifier.
     */
    const forward = selectRelease(movie, candidates, policy).winner;
    const backward = selectRelease(
      movie,
      [...candidates].reverse(),
      policy,
    ).winner;
    const shuffled = selectRelease(
      movie,
      [
        candidates[2]!,
        candidates[4]!,
        candidates[0]!,
        candidates[3]!,
        candidates[1]!,
      ],
      policy,
    ).winner;
    expect(forward?.release.guid).toBe(backward?.release.guid);
    expect(forward?.release.guid).toBe(shuffled?.release.guid);
  });

  it("never returns zero for two different releases", () => {
    const decided = selectRelease(movie, candidates, policy).candidates;
    for (const left of decided) {
      for (const right of decided) {
        if (left.release.guid === right.release.guid) continue;
        expect(compareCandidates(left, right)).not.toBe(0);
      }
    }
  });

  it("orders antisymmetrically", () => {
    const decided = selectRelease(movie, candidates, policy).candidates;
    for (const left of decided) {
      for (const right of decided) {
        // `+ 0` normalises -0, which Object.is distinguishes from 0.
        expect(Math.sign(compareCandidates(left, right)) + 0).toBe(
          -Math.sign(compareCandidates(right, left)) + 0,
        );
      }
    }
  });

  it("never lets a rejected candidate win", () => {
    const result = selectRelease(movie, candidates, policy);
    expect(result.winner?.accepted).toBe(true);
    for (const candidate of result.candidates) {
      if (!candidate.accepted) {
        expect(candidate.release.guid).not.toBe(result.winner?.release.guid);
      }
    }
  });

  it("is deterministic", () => {
    const first = selectRelease(movie, candidates, policy);
    const second = selectRelease(movie, candidates, policy);
    expect(first.winner?.release.guid).toBe(second.winner?.release.guid);
    expect(first.candidates.map((c) => c.release.guid)).toEqual(
      second.candidates.map((c) => c.release.guid),
    );
  });

  it("cannot want an upgrade when the profile forbids one", () => {
    const held = {
      quality: qualityOf(parseRelease("M.2017.1080p.WEB-DL-X")),
      formatScore: 0,
    };
    const result = selectRelease(
      movie,
      [release("Blade.Runner.2049.2017.1080p.BluRay.x264-A")],
      { ...policy, current: held },
    );
    expect(result.winner).toBeUndefined();
    expect(result.candidates[0]!.rejection).toBe("upgrade-not-wanted");
  });

  it("survives candidates with no optional provider fields at all", () => {
    const bare: IndexerRelease = {
      indexerId: "ix",
      indexerName: "Indexer",
      protocol: "usenet",
      guid: "g",
      title: "Blade.Runner.2049.2017.1080p.BluRay.x264-A",
      downloadUrl: "https://x.invalid/get",
      categoryIds: [],
      attributes: {},
    };
    expect(() => selectRelease(movie, [bare], policy)).not.toThrow();
    expect(selectRelease(movie, [bare], policy).winner).toBeDefined();
  });

  it("decides nothing at all for an empty candidate list", () => {
    const result = selectRelease(movie, [], policy);
    expect(result.winner).toBeUndefined();
    expect(result.candidates).toEqual([]);
  });

  it("never carries the credential-bearing URL into a reason", () => {
    const result = selectRelease(movie, candidates, policy);
    const trail = JSON.stringify(result.candidates.map((c) => c.reasons));
    expect(trail).not.toContain("apikey");
    expect(trail).not.toContain("SECRET");
  });
});
