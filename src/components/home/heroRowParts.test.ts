import { describe, expect, it } from "vitest";
import { heroRoundCount, heroRowParts } from "./HeroActions";

const resumed = { canStartOver: true, hasOverview: true, isFilm: false };

describe("the hero's action row", () => {
  it("keeps a phone's home row to three rounds, starting over on the title's page", () => {
    const parts = heroRowParts({
      ...resumed,
      compact: true,
      onTitlePage: false,
    });
    expect(parts.startOver).toBe(false);
    expect(heroRoundCount(parts)).toBe(3);
  });

  it("keeps starting over on a phone's title page, where details are below", () => {
    const parts = heroRowParts({
      ...resumed,
      compact: true,
      onTitlePage: true,
    });
    expect(parts.startOver).toBe(true);
    expect(parts.details).toBeNull();
    expect(parts.overview).toBe(false);
  });

  it("gives a full row start over beside the Details pill", () => {
    const parts = heroRowParts({
      ...resumed,
      compact: false,
      onTitlePage: false,
    });
    expect(parts).toMatchObject({
      startOver: true,
      details: "pill",
      overview: true,
    });
    expect(heroRoundCount(parts)).toBe(3);
  });
});
