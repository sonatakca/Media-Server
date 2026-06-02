import { describe, expect, it } from "vitest";
import { sortCollectionItemsForWatching } from "./collectionUtils";
import type { JellyfinItem } from "./types";

function movie(
  id: string,
  name: string,
  overrides: Partial<JellyfinItem> = {},
): JellyfinItem {
  return {
    Id: id,
    Name: name,
    Type: "Movie",
    ...overrides,
  };
}

describe("sortCollectionItemsForWatching", () => {
  it("uses premiere dates for release/watch order", () => {
    const items = [
      movie("ix", "Star Wars: Episode IX", { PremiereDate: "2019-12-20" }),
      movie("i", "Star Wars: Episode I", { PremiereDate: "1999-05-19" }),
      movie("v", "Star Wars: Episode V", { PremiereDate: "1980-05-21" }),
      movie("vii", "Star Wars: Episode VII", { PremiereDate: "2015-12-18" }),
      movie("iii", "Star Wars: Episode III", { PremiereDate: "2005-05-19" }),
      movie("iv", "Star Wars: Episode IV", { PremiereDate: "1977-05-25" }),
      movie("viii", "Star Wars: Episode VIII", { PremiereDate: "2017-12-15" }),
      movie("ii", "Star Wars: Episode II", { PremiereDate: "2002-05-16" }),
      movie("vi", "Star Wars: Episode VI", { PremiereDate: "1983-05-25" }),
    ];

    expect(
      sortCollectionItemsForWatching(items).map((item) => item.Id),
    ).toEqual(["iv", "v", "vi", "i", "ii", "iii", "vii", "viii", "ix"]);
  });

  it("preserves Jellyfin/API order when production years match", () => {
    const items = [
      movie("second-from-api", "Example Part 2", { ProductionYear: 2024 }),
      movie("first-from-api", "Example Part 1", { ProductionYear: 2024 }),
    ];

    expect(
      sortCollectionItemsForWatching(items).map((item) => item.Id),
    ).toEqual(["second-from-api", "first-from-api"]);
  });

  it("uses sequel numbers only when release metadata is missing", () => {
    const items = [
      movie("kfp-4", "Kung Fu Panda 4"),
      movie("kfp-2", "Kung Fu Panda 2"),
      movie("kfp-1", "Kung Fu Panda"),
      movie("kfp-3", "Kung Fu Panda 3"),
    ];

    expect(
      sortCollectionItemsForWatching(items).map((item) => item.Id),
    ).toEqual(["kfp-1", "kfp-2", "kfp-3", "kfp-4"]);
  });

  it("falls back to production year for Kolpacino style collections", () => {
    const items = [
      movie("four", "Kolpacino 4 4'lük", { ProductionYear: 2024 }),
      movie("bomba", "Kolpacino: Bomba", { ProductionYear: 2011 }),
      movie("three", "Kolpacino 3. Devre", { ProductionYear: 2016 }),
      movie("one", "Kolpacino", { ProductionYear: 2009 }),
    ];

    expect(
      sortCollectionItemsForWatching(items).map((item) => item.Id),
    ).toEqual(["one", "bomba", "three", "four"]);
  });
});
