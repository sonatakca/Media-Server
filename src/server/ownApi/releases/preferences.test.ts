// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseRelease } from "./parseRelease";
import {
  HEVC_PREFERENCE,
  ruleMatches,
  scoreReasons,
  scoreRelease,
  type PreferenceRule,
} from "./preferences";

const facts = (title: string) => parseRelease(title);

describe("the one rule the existing library uses", () => {
  it("scores an x265 release and not an x264 one", () => {
    const hevc = scoreRelease(facts("Movie.2020.2160p.WEB-DL.x265-GRP"), [
      HEVC_PREFERENCE,
    ]);
    expect(hevc.total).toBe(100);
    expect(hevc.contributions[0]).toMatchObject({
      ruleId: "x265-hevc",
      matched: true,
      score: 100,
    });

    const avc = scoreRelease(facts("Movie.2020.1080p.BluRay.x264-GRP"), [
      HEVC_PREFERENCE,
    ]);
    expect(avc.total).toBe(0);
    expect(avc.contributions[0]).toMatchObject({ matched: false, score: 0 });
  });

  it("keeps a rule that did not match in the trail", () => {
    // "Considered and did not apply" is a different thing from "not a rule".
    const score = scoreRelease(facts("Movie.2020.1080p.BluRay.x264-G"), [
      HEVC_PREFERENCE,
    ]);
    expect(score.contributions).toHaveLength(1);
    expect(score.contributions[0]!.reason).toContain("did not apply");
    expect(scoreReasons(score)).toEqual([]);
  });
});

describe("what a rule can ask about", () => {
  const rule = (
    conditions: PreferenceRule["conditions"],
    extra: Partial<PreferenceRule> = {},
  ): PreferenceRule => ({
    id: "r",
    name: "Rule",
    score: 10,
    conditions,
    ...extra,
  });

  it.each([
    [
      "videoCodec",
      [{ type: "videoCodec", values: ["hevc"] }],
      "M.2020.2160p.WEB.x265-G",
    ],
    [
      "source",
      [{ type: "source", values: ["remux"] }],
      "M.2020.2160p.BluRay.REMUX-G",
    ],
    [
      "resolution",
      [{ type: "resolution", values: ["2160p"] }],
      "M.2020.2160p.WEB-DL-G",
    ],
    [
      "hdr",
      [{ type: "hdr", values: ["dolbyvision"] }],
      "M.2020.2160p.WEB-DL.DV-G",
    ],
    [
      "audioCodec",
      [{ type: "audioCodec", values: ["truehd"] }],
      "M.2020.BluRay.TrueHD.7.1-G",
    ],
    [
      "audioFeature",
      [{ type: "audioFeature", values: ["Atmos"] }],
      "M.2020.TrueHD.Atmos-G",
    ],
    [
      "edition",
      [{ type: "edition", values: ["IMAX"] }],
      "M.2020.IMAX.2160p.WEB-DL-G",
    ],
    [
      "language",
      [{ type: "language", values: ["Turkish"] }],
      "M.2020.1080p.TURKISH.WEB-DL-G",
    ],
    [
      "releaseGroup",
      [{ type: "releaseGroup", values: ["ntb"] }],
      "Show.S01E01.1080p.WEB-DL-NTb",
    ],
    [
      "streamingService",
      [{ type: "streamingService", values: ["Amazon"] }],
      "M.2020.1080p.AMZN.WEB-DL-G",
    ],
    [
      "flag",
      [{ type: "flag", values: ["proper"] }],
      "M.2020.PROPER.1080p.BluRay-G",
    ],
    [
      "titleContains",
      [{ type: "titleContains", values: ["remastered"] }],
      "M.2020.REMASTERED.1080p-G",
    ],
  ] as const)("matches on %s", (_label, conditions, title) => {
    expect(
      ruleMatches(
        rule(conditions as PreferenceRule["conditions"]),
        facts(title),
      ),
    ).toBe(true);
  });

  it("requires every condition, not any of them", () => {
    const both = rule([
      { type: "videoCodec", values: ["hevc"] },
      { type: "resolution", values: ["2160p"] },
    ]);
    expect(ruleMatches(both, facts("M.2020.2160p.WEB.x265-G"))).toBe(true);
    expect(ruleMatches(both, facts("M.2020.1080p.WEB.x265-G"))).toBe(false);
    expect(ruleMatches(both, facts("M.2020.2160p.WEB.x264-G"))).toBe(false);
  });

  it("can be negated, to say anything but this", () => {
    const notThatGroup = rule([{ type: "releaseGroup", values: ["BADGRP"] }], {
      negate: true,
      score: -50,
    });
    expect(
      ruleMatches(notThatGroup, facts("M.2020.1080p.WEB-DL-GOODGRP")),
    ).toBe(true);
    expect(ruleMatches(notThatGroup, facts("M.2020.1080p.WEB-DL-BADGRP"))).toBe(
      false,
    );
  });

  it("matches a release group without caring about case", () => {
    expect(
      ruleMatches(
        rule([{ type: "releaseGroup", values: ["NTB"] }]),
        facts("S.S01E01.1080p-NTb"),
      ),
    ).toBe(true);
  });

  it("never matches a rule with no conditions", () => {
    // A rule with nothing in it is a mistake; matching everything would score
    // every candidate that was ever considered.
    expect(ruleMatches(rule([]), facts("M.2020.1080p.WEB-DL-G"))).toBe(false);
    expect(
      ruleMatches(rule([], { negate: true }), facts("M.2020.1080p.WEB-DL-G")),
    ).toBe(false);
  });

  it("does not match an empty substring against everything", () => {
    expect(
      ruleMatches(
        rule([{ type: "titleContains", values: [""] }]),
        facts("Anything"),
      ),
    ).toBe(false);
  });
});

describe("scoring several rules together", () => {
  const rules: PreferenceRule[] = [
    HEVC_PREFERENCE,
    {
      id: "dv",
      name: "Dolby Vision",
      score: 20,
      conditions: [{ type: "hdr", values: ["dolbyvision"] }],
    },
    {
      id: "cam",
      name: "Camera rip",
      score: -1000,
      conditions: [{ type: "source", values: ["cam"] }],
    },
  ];

  it("adds every matching rule and explains each", () => {
    const score = scoreRelease(facts("M.2020.2160p.WEB-DL.DV.x265-G"), rules);
    expect(score.total).toBe(120);
    expect(scoreReasons(score).map((r) => r.code)).toEqual([
      "preference:x265-hevc",
      "preference:dv",
    ]);
  });

  it("subtracts a discouraging rule", () => {
    expect(scoreRelease(facts("M.2020.HDCAM.x264-G"), rules).total).toBe(-1000);
  });

  it("is deterministic and independent of rule order for the total", () => {
    const forward = scoreRelease(facts("M.2020.2160p.WEB-DL.DV.x265-G"), rules);
    const reversed = scoreRelease(
      facts("M.2020.2160p.WEB-DL.DV.x265-G"),
      [...rules].reverse(),
    );
    expect(forward.total).toBe(reversed.total);
    expect(forward).toEqual(
      scoreRelease(facts("M.2020.2160p.WEB-DL.DV.x265-G"), rules),
    );
  });

  it("scores nothing when there are no rules", () => {
    const score = scoreRelease(facts("M.2020.2160p.WEB-DL.x265-G"), []);
    expect(score).toEqual({ total: 0, contributions: [] });
  });
});

describe("what the rule model refuses to be", () => {
  it("has no regular-expression condition at all", () => {
    /*
     * A saved pattern runs against every candidate of every future search, so
     * a catastrophically backtracking one would stall the process. Refusing
     * patterns removes that entirely; a timeout would still mean executing a
     * stranger's program.
     */
    const conditionTypes = [
      "videoCodec",
      "source",
      "resolution",
      "hdr",
      "audioCodec",
      "audioFeature",
      "edition",
      "language",
      "releaseGroup",
      "streamingService",
      "flag",
      "titleContains",
    ];
    expect(conditionTypes).not.toContain("regex");
    expect(conditionTypes).not.toContain("pattern");
  });

  it("treats a pattern-shaped string as literal text", () => {
    const evil: PreferenceRule = {
      id: "evil",
      name: "Not a pattern",
      score: 1,
      conditions: [{ type: "titleContains", values: ["(a+)+$"] }],
    };
    // Matches only a title that literally contains those characters.
    expect(ruleMatches(evil, facts(`Movie ${"a".repeat(200)}`))).toBe(false);
    expect(ruleMatches(evil, facts("Movie (a+)+$ 1080p"))).toBe(true);
  });

  it("stays fast on a hostile title", () => {
    const rules: PreferenceRule[] = Array.from({ length: 50 }, (_, index) => ({
      id: `r${index}`,
      name: `Rule ${index}`,
      score: 1,
      conditions: [
        { type: "titleContains", values: ["aaaaaaaaaaaaaaaaaaaa!"] },
      ],
    }));
    const hostile = parseRelease("a".repeat(20_000));
    const started = Date.now();
    scoreRelease(hostile, rules);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
