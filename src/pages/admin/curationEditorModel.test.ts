import { describe, expect, it } from "vitest";
import { emptyCuratedList, type CuratedList } from "../../lib/curation";
import type { MediaItem } from "../../lib/types";
import {
  applyVisibleOrder,
  draftFromPool,
  entriesFromDraft,
  isDraftDirty,
  moveId,
  moveIdToIndex,
  moveIdsToBack,
  moveIdsToFront,
  toggleId,
} from "./curationEditorModel";

function item(id: string): MediaItem {
  return { Id: id, Name: id, Type: "Movie" } as MediaItem;
}

function listOf(entries: Array<[string, boolean?]>): CuratedList {
  return {
    ...emptyCuratedList("home-hero"),
    entries: entries.map(([itemId, hidden]) => ({
      itemId,
      hidden: hidden ?? false,
    })),
  };
}

describe("moveIdToIndex", () => {
  it("moves an id to the target position", () => {
    expect(moveIdToIndex(["a", "b", "c"], "c", 0)).toEqual(["c", "a", "b"]);
  });

  it("clamps a target beyond either end", () => {
    expect(moveIdToIndex(["a", "b", "c"], "a", 99)).toEqual(["b", "c", "a"]);
    expect(moveIdToIndex(["a", "b", "c"], "c", -5)).toEqual(["c", "a", "b"]);
  });

  it("returns the same array when nothing moves", () => {
    const ids = ["a", "b"];
    expect(moveIdToIndex(ids, "a", 0)).toBe(ids);
    expect(moveIdToIndex(ids, "missing", 0)).toBe(ids);
  });
});

describe("moveId", () => {
  it("steps one place in each direction", () => {
    expect(moveId(["a", "b", "c"], "b", -1)).toEqual(["b", "a", "c"]);
    expect(moveId(["a", "b", "c"], "b", 1)).toEqual(["a", "c", "b"]);
  });

  it("refuses to step off either end", () => {
    const ids = ["a", "b"];
    expect(moveId(ids, "a", -1)).toBe(ids);
    expect(moveId(ids, "b", 1)).toBe(ids);
  });
});

describe("toggleId", () => {
  it("adds then removes", () => {
    expect(toggleId([], "a")).toEqual(["a"]);
    expect(toggleId(["a"], "a")).toEqual([]);
  });
});

describe("draftFromPool", () => {
  it("seeds the whole pool in the saved order", () => {
    const draft = draftFromPool(
      [item("a"), item("b"), item("c")],
      listOf([["c"]]),
    );

    expect(draft.orderedIds).toEqual(["c", "a", "b"]);
  });

  it("keeps the pool's own order when nothing is saved", () => {
    expect(draftFromPool([item("a"), item("b")], null).orderedIds).toEqual([
      "a",
      "b",
    ]);
  });

  it("drops hidden marks for titles that have left the pool", () => {
    const draft = draftFromPool(
      [item("a")],
      listOf([
        ["a", true],
        ["departed", true],
      ]),
    );

    expect(draft.hiddenIds).toEqual(["a"]);
  });
});

describe("entriesFromDraft", () => {
  it("writes the draft order with its hidden marks", () => {
    const pool = [item("a"), item("b")];
    const draft = { orderedIds: ["b", "a"], hiddenIds: ["a"] };

    expect(entriesFromDraft(draft, pool)).toEqual([
      { itemId: "b", hidden: false },
      { itemId: "a", hidden: true },
    ]);
  });

  it("skips ids the pool no longer contains", () => {
    const entries = entriesFromDraft(
      { orderedIds: ["gone", "a"], hiddenIds: [] },
      [item("a")],
    );

    expect(entries).toEqual([{ itemId: "a", hidden: false }]);
  });
});

describe("isDraftDirty", () => {
  it("is false for a freshly loaded draft", () => {
    const pool = [item("a"), item("b")];
    const baseline = draftFromPool(pool, listOf([["b"]]));

    expect(isDraftDirty(baseline, baseline)).toBe(false);
    expect(isDraftDirty({ ...baseline }, baseline)).toBe(false);
  });

  it("notices a reorder and a hide", () => {
    const baseline = { orderedIds: ["a", "b"], hiddenIds: [] as string[] };

    expect(
      isDraftDirty({ orderedIds: ["b", "a"], hiddenIds: [] }, baseline),
    ).toBe(true);
    expect(
      isDraftDirty({ orderedIds: ["a", "b"], hiddenIds: ["a"] }, baseline),
    ).toBe(true);
  });
});

describe("applyVisibleOrder", () => {
  it("rearranges the window and leaves the tail exactly where it was", () => {
    expect(
      applyVisibleOrder(["a", "b", "c", "d", "e"], ["c", "a", "b"]),
    ).toEqual(["c", "a", "b", "d", "e"]);
  });

  it("fills a non-contiguous window's own slots, in order", () => {
    // What a search leaves behind: rows 0, 2 and 4 shown, 1 and 3 filtered out.
    expect(
      applyVisibleOrder(["a", "b", "c", "d", "e"], ["e", "c", "a"]),
    ).toEqual(["e", "b", "c", "d", "a"]);
  });

  it("changes nothing when the window is empty", () => {
    expect(applyVisibleOrder(["a", "b"], [])).toEqual(["a", "b"]);
  });
});

describe("moveIdsToFront / moveIdsToBack", () => {
  it("moves a block to either end, keeping the block in shelf order", () => {
    expect(moveIdsToFront(["a", "b", "c", "d"], ["d", "b"])).toEqual([
      "b",
      "d",
      "a",
      "c",
    ]);
    expect(moveIdsToBack(["a", "b", "c", "d"], ["c", "a"])).toEqual([
      "b",
      "d",
      "a",
      "c",
    ]);
  });

  it("ignores ids the shelf does not hold", () => {
    expect(moveIdsToFront(["a", "b"], ["gone"])).toEqual(["a", "b"]);
  });
});
