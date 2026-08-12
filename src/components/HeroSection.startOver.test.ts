import { describe, expect, it } from "vitest";
import type { MediaItem } from "../lib/types";
import {
  HERO_START_OVER_MIN_PERCENT,
  canStartOverFromHero,
} from "./HeroSection";

function watched(percent: number | undefined, played = false): MediaItem {
  return {
    Id: "item-1",
    Name: "Dune",
    Type: "Movie",
    UserData: {
      ...(percent === undefined ? {} : { PlayedPercentage: percent }),
      Played: played,
    },
  } as MediaItem;
}

describe("offering to start over from the hero", () => {
  it("stays hidden for a title that was never started", () => {
    expect(canStartOverFromHero(watched(undefined))).toBe(false);
    expect(canStartOverFromHero(watched(0))).toBe(false);
    expect(canStartOverFromHero(undefined)).toBe(false);
  });

  it("stays hidden for a title barely begun", () => {
    // Resuming and starting over would land in the same place, so a second
    // button would only be clutter.
    //
    // Values at or below 1 are avoided deliberately: getPlayedRatio reads those
    // as a ratio rather than a percentage, so `1` already means finished.
    expect(canStartOverFromHero(watched(2))).toBe(false);
    expect(canStartOverFromHero(watched(4.9))).toBe(false);
  });

  it("appears once there is meaningfully something to skip back over", () => {
    expect(canStartOverFromHero(watched(HERO_START_OVER_MIN_PERCENT))).toBe(
      true,
    );
    expect(canStartOverFromHero(watched(40))).toBe(true);
    expect(canStartOverFromHero(watched(99))).toBe(true);
  });

  it("appears for a finished title, which is the clearest case of all", () => {
    expect(canStartOverFromHero(watched(undefined, true))).toBe(true);
  });
});
