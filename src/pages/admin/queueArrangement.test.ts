/**
 * The one-press arrangements of the waiting queue.
 *
 * Asserted as orders rather than through the page, because an order is what
 * they are: the page's part is knowing which rows are waiting, and these
 * functions' part is deciding what the waiting rows should read as.
 */

import { describe, expect, it } from "vitest";
import {
  arrangeByShowAndEpisode,
  moveBlock,
  moveToBack,
  moveToFront,
  placeOf,
  type QueueTitleFacts,
} from "./queueArrangement";

/** The queue the operator described, in the order they found it in. */
const MIXED: Record<string, QueueTitleFacts> = {
  "arcane-1": { seriesTitle: "Arcane", seasonNumber: 1, episodeNumber: 1 },
  "house-5": {
    seriesTitle: "House of the Dragon",
    seasonNumber: 1,
    episodeNumber: 5,
  },
  "arcane-3": { seriesTitle: "Arcane", seasonNumber: 1, episodeNumber: 3 },
  "arcane-2": { seriesTitle: "Arcane", seasonNumber: 1, episodeNumber: 2 },
  "house-4": {
    seriesTitle: "House of the Dragon",
    seasonNumber: 1,
    episodeNumber: 4,
  },
};

const lookup =
  (facts: Record<string, QueueTitleFacts>) =>
  (id: string): QueueTitleFacts | undefined =>
    facts[id];

describe("where an episode sits in its show", () => {
  it("prefers the numbers the server gave outright", () => {
    expect(
      placeOf({ seasonNumber: 2, episodeNumber: 7, code: "S09E09" }),
    ).toEqual({ season: 2, episode: 7 });
  });

  it("falls back to the code, for a server that predates the numbers", () => {
    expect(placeOf({ code: "S03E11" })).toEqual({ season: 3, episode: 11 });
    expect(placeOf({ code: "S03" })).toEqual({ season: 3, episode: null });
  });

  it("says it does not know rather than guessing", () => {
    expect(placeOf({ code: "special" })).toEqual({
      season: null,
      episode: null,
    });
    expect(placeOf(undefined)).toEqual({ season: null, episode: null });
    expect(placeOf({ seriesTitle: "Arcane" })).toEqual({
      season: null,
      episode: null,
    });
  });
});

describe("grouping the queue by show and episode", () => {
  it("gathers each show under the place it already held", () => {
    expect(
      arrangeByShowAndEpisode(
        ["arcane-1", "house-5", "arcane-3", "arcane-2", "house-4"],
        lookup(MIXED),
      ),
    ).toEqual(["arcane-1", "arcane-2", "arcane-3", "house-4", "house-5"]);
  });

  it("keeps the shows in the order the queue put them, not alphabetical", () => {
    // The same five rows with the second show in front. Nothing about the
    // titles has changed, so a pass that sorted by name would return the same
    // answer to both of these — and be wrong about one of them.
    expect(
      arrangeByShowAndEpisode(
        ["house-5", "arcane-3", "house-4", "arcane-1"],
        lookup(MIXED),
      ),
    ).toEqual(["house-4", "house-5", "arcane-1", "arcane-3"]);
  });

  it("orders by season before episode", () => {
    const facts: Record<string, QueueTitleFacts> = {
      s2e1: { seriesTitle: "Show", seasonNumber: 2, episodeNumber: 1 },
      s1e9: { seriesTitle: "Show", seasonNumber: 1, episodeNumber: 9 },
      s1e10: { seriesTitle: "Show", seasonNumber: 1, episodeNumber: 10 },
    };
    expect(
      arrangeByShowAndEpisode(["s2e1", "s1e9", "s1e10"], lookup(facts)),
    ).toEqual(["s1e9", "s1e10", "s2e1"]);
  });

  it("leaves a film where it stands, between the shows", () => {
    const facts: Record<string, QueueTitleFacts> = {
      ...MIXED,
      dune: {},
      blade: {},
    };
    expect(
      arrangeByShowAndEpisode(
        ["arcane-3", "dune", "house-5", "blade", "arcane-1"],
        lookup(facts),
      ),
    ).toEqual(["arcane-1", "arcane-3", "dune", "house-5", "blade"]);
  });

  it("puts an episode nobody can place after the ones it can, in the order it was in", () => {
    const facts: Record<string, QueueTitleFacts> = {
      special: { seriesTitle: "Show", code: "Special" },
      e2: { seriesTitle: "Show", code: "S01E02" },
      extra: { seriesTitle: "Show" },
      e1: { seriesTitle: "Show", code: "S01E01" },
    };
    expect(
      arrangeByShowAndEpisode(["special", "e2", "extra", "e1"], lookup(facts)),
    ).toEqual(["e1", "e2", "special", "extra"]);
  });

  it("returns the same list when there is nothing to gather", () => {
    expect(arrangeByShowAndEpisode([], lookup({}))).toEqual([]);
    expect(arrangeByShowAndEpisode(["arcane-1"], lookup(MIXED))).toEqual([
      "arcane-1",
    ]);
  });
});

describe("moving a selection", () => {
  const queue = ["a", "b", "c", "d", "e"];

  it("lifts the chosen rows to the front, in the order they were in", () => {
    expect(moveToFront(queue, ["d", "b"])).toEqual(["b", "d", "a", "c", "e"]);
  });

  it("drops the chosen rows to the back, in the order they were in", () => {
    expect(moveToBack(queue, ["b", "d"])).toEqual(["a", "c", "e", "b", "d"]);
  });

  it("changes nothing when nothing is chosen", () => {
    expect(moveToFront(queue, [])).toEqual(queue);
    expect(moveToBack(queue, [])).toEqual(queue);
    expect(moveBlock(queue, [], 2)).toEqual(queue);
  });

  it("ignores a row the queue no longer holds", () => {
    expect(moveToFront(queue, ["b", "gone"])).toEqual([
      "b",
      "a",
      "c",
      "d",
      "e",
    ]);
  });

  it("gathers a scattered block and drops it where the pointer says", () => {
    // The block is lifted out first, so the index names a place in what is
    // left on screen rather than in the list it came from.
    expect(moveBlock(queue, ["a", "d"], 1)).toEqual(["b", "a", "d", "c", "e"]);
    expect(moveBlock(queue, ["a", "d"], 0)).toEqual(["a", "d", "b", "c", "e"]);
  });

  it("clamps a drop past either end instead of refusing it", () => {
    expect(moveBlock(queue, ["a", "b"], 99)).toEqual(["c", "d", "e", "a", "b"]);
    expect(moveBlock(queue, ["d", "e"], -4)).toEqual(["d", "e", "a", "b", "c"]);
  });
});
