// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  canAcquire,
  orderCandidates,
  summarise,
  type JudgedRelease,
} from "./releaseDecisionPresentation";

function release(over: Partial<JudgedRelease> = {}): JudgedRelease {
  return {
    guid: "g1",
    indexerId: "nzbgeek",
    title: "Dune.2021.1080p.WEB-DL",
    quality: "WEB-DL 1080p",
    accepted: true,
    rank: 10,
    score: 0,
    reasons: [],
    ...over,
  };
}

const titles = (candidates: JudgedRelease[], winner: string | null = null) =>
  orderCandidates(candidates, winner).map((entry) => entry.title);

describe("the order candidates are read in", () => {
  it("puts the winner first, whatever else it would sort by", () => {
    const ordered = orderCandidates(
      [
        release({ guid: "a", title: "A", rank: 30, score: 500 }),
        release({ guid: "b", title: "B", rank: 10, score: 0 }),
      ],
      "b",
    );
    expect(ordered[0]!.title).toBe("B");
    expect(ordered[0]!.isWinner).toBe(true);
    expect(ordered[1]!.isWinner).toBe(false);
  });

  it("puts everything the profile allows above everything it does not", () => {
    /*
     * The reason this is not a sort by score: a rejected release can score well
     * on the preferences it did match, and showing it above one the server
     * would actually download reads as a recommendation.
     */
    expect(
      titles([
        release({ guid: "a", title: "Rejected", accepted: false, score: 900 }),
        release({ guid: "b", title: "Accepted", accepted: true, score: 1 }),
      ]),
    ).toEqual(["Accepted", "Rejected"]);
  });

  it("ranks by what the profile allows before how much it is liked", () => {
    // A well-liked 1080p must not outrank a 2160p when the profile prefers it.
    expect(
      titles([
        release({ guid: "a", title: "1080p", rank: 10, score: 400 }),
        release({ guid: "b", title: "2160p", rank: 30, score: 0 }),
      ]),
    ).toEqual(["2160p", "1080p"]);
  });

  it("uses the score only to break a tie in rank", () => {
    expect(
      titles([
        release({ guid: "a", title: "Lower", rank: 10, score: 10 }),
        release({ guid: "b", title: "Higher", rank: 10, score: 90 }),
      ]),
    ).toEqual(["Higher", "Lower"]);
  });

  it("sorts a release with no rank below every release that has one", () => {
    expect(
      titles([
        release({ guid: "a", title: "Unranked", rank: null, score: 900 }),
        release({ guid: "b", title: "Ranked", rank: 1, score: 0 }),
      ]),
    ).toEqual(["Ranked", "Unranked"]);
  });

  it("reads the same way twice for the same set", () => {
    // Ties fall back to the title, so the order does not wander between loads.
    const set = [
      release({ guid: "a", title: "Beta", rank: 10, score: 5 }),
      release({ guid: "b", title: "Alpha", rank: 10, score: 5 }),
    ];
    expect(titles(set)).toEqual(titles([...set].reverse()));
    expect(titles(set)).toEqual(["Alpha", "Beta"]);
  });

  it("marks nothing as the winner when the engine chose nothing", () => {
    const ordered = orderCandidates([release({ accepted: false })], null);
    expect(ordered.every((entry) => !entry.isWinner)).toBe(true);
  });

  it("does not lose or duplicate a candidate", () => {
    const set = [
      release({ guid: "a", title: "A" }),
      release({ guid: "b", title: "B", accepted: false }),
      release({ guid: "c", title: "C" }),
    ];
    const ordered = orderCandidates(set, "c");
    expect(ordered).toHaveLength(3);
    expect(new Set(ordered.map((entry) => entry.guid)).size).toBe(3);
  });
});

describe("what the set adds up to", () => {
  it("counts what was judged and what was allowed", () => {
    expect(
      summarise([
        release({ accepted: true }),
        release({ accepted: false }),
        release({ accepted: false }),
      ]),
    ).toEqual({ total: 3, accepted: 1, rejected: 2 });
  });

  it("counts an empty search as empty rather than as a failure", () => {
    expect(summarise([])).toEqual({ total: 0, accepted: 0, rejected: 0 });
  });
});

describe("what may be asked for", () => {
  it("offers only what the profile accepts", () => {
    /*
     * Offering a rejected release would put the operator and the decision
     * engine in disagreement, and the server would refuse it anyway.
     */
    expect(canAcquire(release({ accepted: true }))).toBe(true);
    expect(canAcquire(release({ accepted: false }))).toBe(false);
  });
});
