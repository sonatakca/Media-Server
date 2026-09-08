// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseRelease } from "./parseRelease";
import {
  intrinsicRank,
  parseQualityId,
  qualityId,
  qualityLabel,
  qualityOf,
} from "./quality";
import {
  breakQualityTie,
  cutoffRank,
  evaluateQuality,
  evaluateUpgrade,
  profileFromIds,
} from "./qualityProfile";

const q = (title: string) => qualityOf(parseRelease(title));

/** Shaped like the user's own HD-1080p profile: worst first, cutoff at BluRay. */
const hd1080 = profileFromIds(
  "hd-1080p",
  "HD-1080p",
  ["hdtv-1080p", "webrip-1080p", "webdl-1080p", "bluray-1080p", "remux-1080p"],
  { cutoffQualityId: "bluray-1080p" },
);

/** Shaped like the user's `1080p-2160p x265`: grouped positions. */
const x265 = profileFromIds(
  "x265",
  "1080p-2160p x265",
  [
    ["webrip-1080p", "webdl-1080p", "bluray-1080p"],
    ["webrip-2160p", "webdl-2160p", "bluray-2160p"],
  ],
  { cutoffQualityId: "webrip-2160p", minFormatScore: 0 },
);

describe("reading a release as a quality", () => {
  it.each([
    ["Movie.2020.1080p.WEB-DL.x264-G", "webdl-1080p"],
    ["Movie.2020.2160p.BluRay.REMUX.HEVC-G", "remux-2160p"],
    ["Movie.2020.720p.HDTV.x264-G", "hdtv-720p"],
    ["Movie.2020.1080p.WEBRip.x264-G", "webrip-1080p"],
    ["Movie.1999.DVDRip.XviD-G", "dvd-480p"],
  ])("reads %s as %s", (title, expected) => {
    expect(qualityId(q(title))).toBe(expected);
  });

  it("gives a DVD with no stated resolution one anyway", () => {
    // `dvd-unknown` would match no profile entry, so the release would be
    // rejected for saying something it did in fact say.
    expect(qualityId(q("Movie.1999.DVD-G"))).toBe("dvd-480p");
  });

  it("round-trips an id", () => {
    expect(parseQualityId("webdl-2160p")).toEqual({
      source: "webdl",
      resolution: "2160p",
    });
    expect(parseQualityId("nonsense")).toBeUndefined();
    expect(parseQualityId("notasource-1080p")).toBeUndefined();
  });

  it("labels a quality for a person", () => {
    expect(qualityLabel({ source: "webdl", resolution: "2160p" })).toBe(
      "WEB-DL 2160p",
    );
    expect(qualityLabel({ source: "remux", resolution: "1080p" })).toBe(
      "Remux 1080p",
    );
  });
});

describe("judging a candidate against a profile", () => {
  it("allows a quality the profile lists, and says so", () => {
    const verdict = evaluateQuality(q("Movie.2020.1080p.WEB-DL-G"), hd1080);
    expect(verdict.allowed).toBe(true);
    expect(verdict.rank).toBe(2);
    expect(verdict.reasons.map((r) => r.code)).toContain("quality-allowed");
  });

  it("refuses a quality the profile does not list, and says which", () => {
    const verdict = evaluateQuality(q("Movie.2020.2160p.WEB-DL-G"), hd1080);
    expect(verdict.allowed).toBe(false);
    expect(verdict.rank).toBeNull();
    expect(verdict.reasons[0]).toMatchObject({ code: "quality-not-allowed" });
    expect(verdict.reasons[0]!.detail).toContain("HD-1080p");
  });

  it("refuses a release that never said what it is", () => {
    const verdict = evaluateQuality(q("Some Title With No Metadata"), hd1080);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reasons[0]).toMatchObject({ code: "quality-unknown" });
  });

  it("reports the cutoff as met at or above it, and not below", () => {
    expect(
      evaluateQuality(q("M.2020.1080p.BluRay-G"), hd1080).meetsCutoff,
    ).toBe(true);
    expect(
      evaluateQuality(q("M.2020.1080p.BluRay.REMUX-G"), hd1080).meetsCutoff,
    ).toBe(true);
    expect(
      evaluateQuality(q("M.2020.1080p.WEB-DL-G"), hd1080).meetsCutoff,
    ).toBe(false);
  });

  it("refuses a candidate below the profile's minimum score whatever its quality", () => {
    const strict = profileFromIds("s", "Strict", ["bluray-1080p"], {
      minFormatScore: 100,
    });
    const verdict = evaluateQuality(q("M.2020.1080p.BluRay-G"), strict, 0);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reasons.map((r) => r.code)).toContain("below-format-score");
  });

  it("does not call the cutoff met when the score is below the cutoff score", () => {
    const profile = profileFromIds("p", "P", ["webdl-1080p", "bluray-1080p"], {
      cutoffQualityId: "bluray-1080p",
      cutoffFormatScore: 100,
    });
    expect(
      evaluateQuality(q("M.2020.1080p.BluRay-G"), profile, 0).meetsCutoff,
    ).toBe(false);
    expect(
      evaluateQuality(q("M.2020.1080p.BluRay-G"), profile, 100).meetsCutoff,
    ).toBe(true);
  });

  it("treats a grouped position as one rank", () => {
    const a = evaluateQuality(q("M.2020.2160p.WEB-DL-G"), x265);
    const b = evaluateQuality(q("M.2020.2160p.BluRay-G"), x265);
    expect(a.rank).toBe(b.rank);
    expect(a.allowed && b.allowed).toBe(true);
  });

  it("falls back to the top of the profile when the cutoff names nothing it holds", () => {
    const profile = profileFromIds("p", "P", ["webdl-1080p", "bluray-1080p"], {
      cutoffQualityId: "remux-2160p",
    });
    expect(cutoffRank(profile)).toBe(1);
  });
});

describe("deciding whether to replace what is already held", () => {
  const upgradable = profileFromIds(
    "u",
    "Upgradable",
    ["hdtv-1080p", "webdl-1080p", "bluray-1080p", "remux-1080p"],
    { cutoffQualityId: "remux-1080p", upgradeAllowed: true },
  );

  it("is not an upgrade when nothing is held", () => {
    const verdict = evaluateUpgrade(
      evaluateQuality(q("M.2020.1080p.WEB-DL-G"), upgradable),
      null,
      upgradable,
    );
    expect(verdict.wanted).toBe(true);
    expect(verdict.reasons[0]).toMatchObject({ code: "no-current-release" });
  });

  it("refuses every upgrade when the profile disallows them", () => {
    /*
     * Every profile in the library this replaces has upgrades off, so this is
     * the case that actually runs. An upgrade is a second download and a
     * second import of something the user already has.
     */
    const verdict = evaluateUpgrade(
      evaluateQuality(q("M.2020.1080p.BluRay.REMUX-G"), hd1080),
      { quality: q("M.2020.1080p.HDTV-G"), formatScore: 0 },
      hd1080,
    );
    expect(verdict.wanted).toBe(false);
    expect(verdict.reasons[0]).toMatchObject({ code: "upgrades-disabled" });
  });

  it("wants a better quality when upgrades are allowed", () => {
    const verdict = evaluateUpgrade(
      evaluateQuality(q("M.2020.1080p.BluRay-G"), upgradable),
      { quality: q("M.2020.1080p.HDTV-G"), formatScore: 0 },
      upgradable,
      0,
    );
    expect(verdict.wanted).toBe(true);
    expect(verdict.reasons[0]).toMatchObject({ code: "is-an-upgrade" });
  });

  it("does not want a worse or equal quality", () => {
    for (const title of ["M.2020.1080p.HDTV-G", "M.2020.1080p.WEB-DL-G"]) {
      const verdict = evaluateUpgrade(
        evaluateQuality(q(title), upgradable),
        { quality: q("M.2020.1080p.WEB-DL-G"), formatScore: 0 },
        upgradable,
        0,
      );
      expect(verdict.wanted).toBe(false);
      expect(verdict.reasons[0]).toMatchObject({ code: "not-an-upgrade" });
    }
  });

  it("stops wanting anything once the cutoff is satisfied", () => {
    const verdict = evaluateUpgrade(
      evaluateQuality(q("M.2020.1080p.BluRay-G"), upgradable),
      { quality: q("M.2020.1080p.BluRay.REMUX-G"), formatScore: 0 },
      upgradable,
    );
    expect(verdict.wanted).toBe(false);
    expect(verdict.reasons[0]).toMatchObject({ code: "cutoff-already-met" });
  });

  it("treats a better score at equal quality as an upgrade", () => {
    const verdict = evaluateUpgrade(
      evaluateQuality(q("M.2020.1080p.WEB-DL.x265-G"), upgradable, 100),
      { quality: q("M.2020.1080p.WEB-DL-G"), formatScore: 0 },
      upgradable,
      100,
    );
    expect(verdict.wanted).toBe(true);
  });

  it("never wants a candidate the profile refuses", () => {
    const verdict = evaluateUpgrade(
      evaluateQuality(q("M.2020.2160p.WEB-DL-G"), upgradable),
      { quality: q("M.2020.1080p.HDTV-G"), formatScore: 0 },
      upgradable,
    );
    expect(verdict.wanted).toBe(false);
  });
});

describe("breaking a tie between equally ranked qualities", () => {
  it("prefers the higher resolution, then the better source", () => {
    expect(
      breakQualityTie(q("M.2160p.WEB-DL-G"), q("M.1080p.BluRay-G")),
    ).toBeLessThan(0);
    expect(
      breakQualityTie(q("M.2020.1080p.BluRay-G"), q("M.2020.1080p.WEB-DL-G")),
    ).toBeLessThan(0);
  });

  it("is antisymmetric, so it cannot leave the order to chance", () => {
    const pairs: Array<[string, string]> = [
      ["M.2020.2160p.WEB-DL-G", "M.2020.1080p.BluRay-G"],
      ["M.2020.1080p.BluRay-G", "M.2020.1080p.WEB-DL-G"],
      ["M.2020.720p.HDTV-G", "M.1999.DVDRip-G"],
    ];
    for (const [left, right] of pairs) {
      expect(Math.sign(breakQualityTie(q(left), q(right)))).toBe(
        -Math.sign(breakQualityTie(q(right), q(left))),
      );
    }
  });

  it("ranks resolution above source", () => {
    expect(
      intrinsicRank({ source: "webrip", resolution: "2160p" }),
    ).toBeGreaterThan(intrinsicRank({ source: "remux", resolution: "1080p" }));
  });
});
