import { describe, expect, it } from "vitest";
import { activeTabIndex, slotEdges, type TabDef } from "./useTabBar";

const tabs = ["/home", "/movies", "/shows", "/books", "/my-list"].map(
  (to) => ({ key: to, to, label: to, Glyph: () => null }) as TabDef,
);

describe("activeTabIndex", () => {
  it("lights a tab for its own path and anything below it", () => {
    expect(activeTabIndex(tabs, "/movies")).toBe(1);
    expect(activeTabIndex(tabs, "/movies/abc")).toBe(1);
    expect(activeTabIndex(tabs, "/shows/abc/season/2")).toBe(2);
  });

  it("lights nothing for a path that only shares a prefix, or no tab at all", () => {
    expect(activeTabIndex(tabs, "/moviesque")).toBe(-1);
    expect(activeTabIndex(tabs, "/collections")).toBe(-1);
  });
});

describe("slotEdges", () => {
  it("splits the row into equal slots inside the inset", () => {
    expect(slotEdges(400, 0, 5, 0)).toEqual([0, 80]);
    expect(slotEdges(408, 4, 5, 4)).toEqual([324, 404]);
  });
});
