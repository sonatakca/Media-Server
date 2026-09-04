import { describe, expect, it } from "vitest";
import type {
  ProcessingEpisode,
  ProcessingSeason,
  ProcessingSeries,
} from "../../lib/processingApi";
import {
  canDeleteEpisodeSource,
  canDeleteSeasonSources,
  canDeleteSeriesSources,
  sourceDeletionTargets,
  formatSourceDeletionSize,
  sourceDeletionBytes,
} from "./processingSeriesModel";

function episode(
  id: string,
  overrides: Partial<ProcessingEpisode> = {},
): ProcessingEpisode {
  return {
    itemId: id,
    mediaFileId: `${id}-file`,
    title: id,
    sortTitle: id,
    sourceAvailable: true,
    fileCount: 1,
    probed: true,
    source: null,
    plan: {
      ladder: [1080],
      missingRungs: [],
    } as unknown as NonNullable<ProcessingEpisode["plan"]>,
    package: {
      rungs: [1080],
    } as unknown as NonNullable<ProcessingEpisode["package"]>,
    packageState: "complete",
    activeJobId: null,
    activeJobState: null,
    processable: false,
    seasonNumber: 1,
    episodeNumber: 1,
    code: "S01E01",
    ...overrides,
  };
}

function season(
  episodes: ProcessingEpisode[],
  seasonId = "season-1",
  seasonNumber = 1,
): ProcessingSeason {
  return {
    seasonId,
    seasonNumber,
    title: `Season ${seasonNumber}`,
    episodes,
    counts: {} as ProcessingSeason["counts"],
  };
}

function series(seasons: ProcessingSeason[]): ProcessingSeries {
  return {
    seriesId: "series-1",
    title: "Series",
    sortTitle: "Series",
    productionYear: 2026,
    seasonCount: seasons.length,
    episodeCount: seasons.reduce(
      (total, value) => total + value.episodes.length,
      0,
    ),
    seasons,
    counts: {} as ProcessingSeries["counts"],
  };
}

describe("TV source deletion eligibility", () => {
  it("allows a complete episode source to be removed", () => {
    expect(canDeleteEpisodeSource(episode("e1"))).toBe(true);
  });

  it("refuses an episode that still needs another rung", () => {
    expect(
      canDeleteEpisodeSource(
        episode("e1", {
          plan: {
            ladder: [2160, 1080],
            missingRungs: [2160],
          } as unknown as NonNullable<ProcessingEpisode["plan"]>,
          processable: true,
        }),
      ),
    ).toBe(false);
  });

  it("refuses an episode with an active job", () => {
    expect(
      canDeleteEpisodeSource(
        episode("e1", {
          activeJobId: "job-1",
        }),
      ),
    ).toBe(false);
  });

  it("refuses a partial package", () => {
    expect(
      canDeleteEpisodeSource(
        episode("e1", {
          packageState: "partial",
          processable: true,
        }),
      ),
    ).toBe(false);
  });

  it("allows a completely processed season", () => {
    expect(
      canDeleteSeasonSources(
        season([episode("e1"), episode("e2"), episode("e3")]),
      ),
    ).toBe(true);
  });

  it("allows a season when one complete source was removed earlier", () => {
    const episodes = [
      episode("e1", {
        sourceAvailable: false,
        source: null,
        plan: null,
      }),
      episode("e2"),
    ];

    expect(canDeleteSeasonSources(season(episodes))).toBe(true);

    expect(
      sourceDeletionTargets(episodes).map((value) => value.itemId),
    ).toEqual(["e2"]);
  });

  it("does not offer deletion when every source is already gone", () => {
    expect(
      canDeleteSeasonSources(
        season([
          episode("e1", {
            sourceAvailable: false,
            source: null,
            plan: null,
          }),
          episode("e2", {
            sourceAvailable: false,
            source: null,
            plan: null,
          }),
        ]),
      ),
    ).toBe(false);
  });

  it("refuses a season containing an unfinished episode", () => {
    expect(
      canDeleteSeasonSources(
        season([
          episode("e1"),
          episode("e2", {
            packageState: "none",
            package: null,
            processable: true,
          }),
        ]),
      ),
    ).toBe(false);
  });

  it("allows a fully processed whole show", () => {
    expect(
      canDeleteSeriesSources(
        series([
          season([episode("e1"), episode("e2")], "season-1", 1),
          season(
            [
              episode("e3", {
                sourceAvailable: false,
                source: null,
                plan: null,
              }),
              episode("e4"),
            ],
            "season-2",
            2,
          ),
        ]),
      ),
    ).toBe(true);
  });

  it("refuses whole-show deletion when one episode is incomplete", () => {
    expect(
      canDeleteSeriesSources(
        series([
          season([episode("e1")], "season-1", 1),
          season(
            [
              episode("e2", {
                packageState: "partial",
                processable: true,
              }),
            ],
            "season-2",
            2,
          ),
        ]),
      ),
    ).toBe(false);
  });

  it("formats destructive source sizes with two decimals above bytes", () => {
    expect(formatSourceDeletionSize(0)).toBe("0 B");
    expect(formatSourceDeletionSize(512)).toBe("512 B");

    expect(formatSourceDeletionSize(768 * 1024)).toBe("768.00 KB");

    expect(formatSourceDeletionSize(512 * 1024 * 1024)).toBe("512.00 MB");

    expect(formatSourceDeletionSize(1024 * 1024 * 1024)).toBe("1.00 GB");

    expect(formatSourceDeletionSize(7.84321 * 1024 * 1024 * 1024)).toBe(
      "7.84 GB",
    );
  });

  it("totals only source files that would actually be deleted", () => {
    const twoGb = episode("e-size-1", {
      source: {
        sizeBytes: 2 * 1024 * 1024 * 1024,
      } as unknown as NonNullable<ProcessingEpisode["source"]>,
    });

    const halfGb = episode("e-size-2", {
      source: {
        sizeBytes: 512 * 1024 * 1024,
      } as unknown as NonNullable<ProcessingEpisode["source"]>,
    });

    const alreadyRemoved = episode("e-size-3", {
      sourceAvailable: false,
      source: null,
      plan: null,
    });

    const bytes = sourceDeletionBytes([twoGb, halfGb, alreadyRemoved]);

    expect(bytes).toBe(2.5 * 1024 * 1024 * 1024);

    expect(formatSourceDeletionSize(bytes)).toBe("2.50 GB");
  });
});
