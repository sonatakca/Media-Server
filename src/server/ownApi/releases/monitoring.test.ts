// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  evaluateWanted,
  resolveEpisodeMonitoring,
  resolveSeasonMonitoring,
  type MonitoredSeason,
} from "./monitoring";
import { profileFromIds } from "./qualityProfile";

const series = (monitored: boolean) => ({ monitored });
const season = (
  seasonNumber: number,
  monitoring: MonitoredSeason["monitoring"],
): MonitoredSeason => ({ seasonNumber, monitoring });

const noUpgrades = profileFromIds(
  "p",
  "HD-1080p",
  ["hdtv-1080p", "webdl-1080p", "bluray-1080p"],
  { cutoffQualityId: "bluray-1080p" },
);
const upgrades = profileFromIds(
  "u",
  "Upgradable",
  ["hdtv-1080p", "webdl-1080p", "bluray-1080p"],
  { cutoffQualityId: "bluray-1080p", upgradeAllowed: true },
);

describe("resolving whether an episode is monitored", () => {
  it("lets the episode's own setting win over everything above it", () => {
    /*
     * The case three booleans cannot express: a monitored episode inside an
     * unmonitored season inside a monitored series, with no contradiction,
     * because each level records whether it has an opinion at all.
     */
    const decision = resolveEpisodeMonitoring(
      series(true),
      season(2, "unmonitored"),
      { monitoring: "monitored" },
    );
    expect(decision).toMatchObject({ monitored: true, decidedBy: "episode" });
  });

  it("lets the season decide when the episode has no opinion", () => {
    expect(
      resolveEpisodeMonitoring(series(true), season(2, "unmonitored"), {
        monitoring: "inherit",
      }),
    ).toMatchObject({ monitored: false, decidedBy: "season" });
  });

  it("falls through to the series when neither has an opinion", () => {
    for (const monitored of [true, false]) {
      expect(
        resolveEpisodeMonitoring(series(monitored), season(2, "inherit"), {
          monitoring: "inherit",
        }),
      ).toMatchObject({ monitored, decidedBy: "series" });
    }
  });

  it("falls through to the series when there are no rows at all", () => {
    expect(
      resolveEpisodeMonitoring(series(true), undefined, undefined),
    ).toMatchObject({ monitored: true, decidedBy: "series" });
  });

  it("says which level decided, so the answer can be explained", () => {
    const decision = resolveEpisodeMonitoring(
      series(true),
      season(3, "unmonitored"),
      { monitoring: "inherit" },
    );
    expect(decision.reason.detail).toContain("Season 3");
  });

  it("resolves a season the same way", () => {
    expect(
      resolveSeasonMonitoring(series(false), season(1, "monitored")),
    ).toMatchObject({ monitored: true, decidedBy: "season" });
    expect(
      resolveSeasonMonitoring(series(true), season(1, "inherit")),
    ).toMatchObject({ monitored: true, decidedBy: "series" });
  });
});

describe("deciding whether something is wanted", () => {
  it("wants nothing that is not monitored", () => {
    // An unmonitored target can never become wanted, whatever else is true.
    expect(evaluateWanted({ monitored: false }, noUpgrades)).toMatchObject({
      wanted: false,
      reason: "not-monitored",
    });
    expect(
      evaluateWanted(
        { monitored: false, currentQualityId: undefined },
        upgrades,
      ),
    ).toMatchObject({ wanted: false });
  });

  it("wants a monitored target that holds nothing", () => {
    expect(evaluateWanted({ monitored: true }, noUpgrades)).toMatchObject({
      wanted: true,
      reason: "missing",
    });
  });

  it("cannot judge without a profile", () => {
    expect(evaluateWanted({ monitored: true }, undefined)).toMatchObject({
      wanted: false,
      reason: "no-profile",
    });
  });

  it("does not call an unaired episode missing", () => {
    /*
     * Otherwise every future episode of every monitored series joins the
     * wanted list the moment the series is added.
     */
    const future = Date.UTC(2030, 0, 1);
    expect(
      evaluateWanted(
        { monitored: true, airedAtMs: future },
        noUpgrades,
        Date.UTC(2026, 0, 1),
      ),
    ).toMatchObject({ wanted: false, reason: "not-yet-aired" });
  });

  it("wants an episode that has aired and is not held", () => {
    expect(
      evaluateWanted(
        { monitored: true, airedAtMs: Date.UTC(2020, 0, 1) },
        noUpgrades,
        Date.UTC(2026, 0, 1),
      ),
    ).toMatchObject({ wanted: true, reason: "missing" });
  });

  it("treats an unknown air date as aired rather than as future", () => {
    expect(evaluateWanted({ monitored: true }, noUpgrades)).toMatchObject({
      wanted: true,
      reason: "missing",
    });
  });

  it("stops wanting anything once the cutoff is met", () => {
    expect(
      evaluateWanted(
        { monitored: true, currentQualityId: "bluray-1080p" },
        noUpgrades,
      ),
    ).toMatchObject({ wanted: false, reason: "satisfied" });
  });

  it("wants an upgrade below the cutoff only when the profile allows one", () => {
    const below = { monitored: true, currentQualityId: "webdl-1080p" };
    expect(evaluateWanted(below, upgrades)).toMatchObject({
      wanted: true,
      reason: "below-cutoff",
    });
    expect(evaluateWanted(below, noUpgrades)).toMatchObject({
      wanted: false,
      reason: "satisfied",
    });
  });

  it("reports what is held when it can read it", () => {
    const verdict = evaluateWanted(
      { monitored: true, currentQualityId: "webdl-1080p" },
      upgrades,
    );
    expect(verdict.current).toEqual({ source: "webdl", resolution: "1080p" });
  });

  it("treats an unreadable held quality as holding nothing", () => {
    // Better to look for a release than to be stuck on a value nothing can rank.
    expect(
      evaluateWanted(
        { monitored: true, currentQualityId: "not-a-quality" },
        noUpgrades,
      ),
    ).toMatchObject({ wanted: true, reason: "missing" });
  });

  it("is deterministic for the same inputs", () => {
    const input = { monitored: true, currentQualityId: "webdl-1080p" };
    expect(evaluateWanted(input, upgrades)).toEqual(
      evaluateWanted(input, upgrades),
    );
  });
});
