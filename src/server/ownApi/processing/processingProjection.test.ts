/**
 * The catalogue, as the processing page must see it.
 *
 * Everything here is exercised against catalogue rows rather than a
 * filesystem, because that is the claim being made: a library with hundreds of
 * episodes in it is a database read, and no part of building this view opens a
 * media file or runs ffprobe.
 */

import { describe, expect, it, vi } from "vitest";
import type {
  MediaStreamRow,
  ProcessableTitleRow,
} from "../catalogue/catalogueRepository";
import type { HardwareReport } from "../../../renditions/hardware/detect";
import type { PackageIndexEntry } from "./packageIndex";
import { summarisePackage } from "./packageIndex";
import type { ProcessingJobRecord } from "./jobStore";
import {
  countTitles,
  episodeCode,
  packageTargetsFor,
  probeFromCatalogue,
  projectCatalogue,
  projectTitle,
} from "./processingProjection";

const HARDWARE: HardwareReport = {
  platform: "darwin",
  probedAt: new Date("2026-09-04T00:00:00.000Z").toISOString(),
  adapters: [],
  selected: {
    h264: "h264_videotoolbox",
    hevc: "hevc_videotoolbox",
    hevcTenBit: "hevc_videotoolbox",
  },
  selectedAdapter: {
    h264: "videotoolbox",
    hevc: "videotoolbox",
    hevcTenBit: "videotoolbox",
  },
} as unknown as HardwareReport;

function streams(overrides: Partial<MediaStreamRow>[] = []): MediaStreamRow[] {
  const base: MediaStreamRow = {
    streamIndex: 0,
    kind: "video",
    codec: "h264",
    profile: "High",
    level: 41,
    language: null,
    title: null,
    isDefault: true,
    isForced: false,
    isExternal: false,
    isTextSubtitle: false,
    externalRelativePath: null,
    channels: null,
    sampleRate: null,
    bitrateBps: null,
    width: 1920,
    height: 1080,
    pixelFormat: "yuv420p",
    frameRate: 24,
    videoRange: "SDR",
    colorTransfer: "bt709",
    colorPrimaries: "bt709",
    colorSpace: "bt709",
    bitDepth: 8,
  };
  return [
    base,
    {
      ...base,
      streamIndex: 1,
      kind: "audio",
      codec: "aac",
      channels: 6,
      language: "eng",
      width: null,
      height: null,
    },
    ...overrides.map((override, index) => ({
      ...base,
      streamIndex: 10 + index,
      ...override,
    })),
  ];
}

let nextId = 0;
function id(prefix: string): string {
  nextId += 1;
  return `${prefix}-${String(nextId).padStart(4, "0")}`;
}

function movieRow(
  title: string,
  overrides: Partial<ProcessableTitleRow> = {},
): ProcessableTitleRow {
  const itemId = overrides.itemId ?? id("movie");
  return {
    itemId,
    libraryId: "library-movies",
    kind: "movie",
    title,
    sortTitle: title.toLowerCase(),
    productionYear: 2021,
    runtimeMs: String(2 * 60 * 60 * 1000),
    indexNumber: null,
    itemMissingSince: null,
    seriesId: null,
    seriesTitle: null,
    seriesSortTitle: null,
    seriesYear: null,
    seasonId: null,
    seasonTitle: null,
    seasonNumber: null,
    mediaFileId: overrides.mediaFileId ?? id("file"),
    relativePath: `Movies/${title}/${title}.mp4`,
    container: "mp4",
    sizeBytes: String(20 * 1024 ** 3),
    mtimeMs: "1000",
    fingerprint: `fp-${itemId}`,
    durationMs: String(2 * 60 * 60 * 1000),
    bitrateBps: "20000000",
    probeState: "probed",
    fileMissingSince: null,
    fileCount: 1,
    videoCodec: "h264",
    videoProfile: "High",
    width: 1920,
    height: 1080,
    frameRate: 24,
    pixelFormat: "yuv420p",
    bitDepth: 8,
    videoRange: "SDR",
    colorTransfer: "bt709",
    colorPrimaries: "bt709",
    colorSpace: "bt709",
    audioTrackCount: 1,
    subtitleTrackCount: 0,
    externalSubtitleCount: 0,
    ...overrides,
  };
}

function episodeRow(
  show: { seriesId: string; title: string; sortTitle?: string },
  season: { seasonId: string; number: number; title?: string },
  episode: { number: number | null; title: string },
  overrides: Partial<ProcessableTitleRow> = {},
): ProcessableTitleRow {
  const itemId = overrides.itemId ?? id("episode");
  const code = episodeCode(season.number, episode.number);
  return {
    ...movieRow(episode.title, { itemId }),
    kind: "episode",
    title: episode.title,
    sortTitle: `${String(season.number).padStart(4, "0")}-${String(
      episode.number ?? 0,
    ).padStart(5, "0")}`,
    productionYear: null,
    indexNumber: episode.number,
    seriesId: show.seriesId,
    seriesTitle: show.title,
    seriesSortTitle: show.sortTitle ?? show.title.toLowerCase(),
    seriesYear: 2022,
    seasonId: season.seasonId,
    seasonTitle: season.title ?? `Season ${season.number}`,
    seasonNumber: season.number,
    relativePath: `Series/${show.title}/Season ${season.number}/${show.title} - ${code} - ${episode.title}.mp4`,
    ...overrides,
  };
}

function context(options: {
  rows: ProcessableTitleRow[];
  packages?: Record<string, PackageIndexEntry>;
  jobs?: ProcessingJobRecord[];
  streamsFor?: (row: ProcessableTitleRow) => MediaStreamRow[];
}) {
  const streamsByFile = new Map<string, MediaStreamRow[]>();
  for (const row of options.rows) {
    if (!row.mediaFileId) continue;
    streamsByFile.set(
      row.mediaFileId,
      options.streamsFor ? options.streamsFor(row) : streams(),
    );
  }
  return {
    hardware: HARDWARE,
    streamsByFile,
    packageFor: (mediaFileId: string) =>
      options.packages?.[mediaFileId] ?? {
        state: "none" as const,
        summary: null,
        readAt: 1,
      },
    activeJobsByFile: new Map(
      (options.jobs ?? []).map((job) => [job.mediaFileId, job]),
    ),
  };
}

function packaged(rungs: number[], overrides: Record<string, unknown> = {}) {
  const summary = summarisePackage(
    {
      schemaVersion: 1,
      profileVersion: "cmaf-hls-aligned-v2",
      sourceFingerprint: "matching",
      createdAt: new Date().toISOString(),
      sourceDurationSeconds: 3600,
      masterPlaylistPath: ".seyirlik/master.m3u8",
      video: rungs.map((height) => ({
        id: `${height}p`,
        qualityHeight: height,
        hdr: "sdr",
        mediaPath: `video/${height}p.mp4`,
        playlistPath: `.seyirlik/video/${height}p.m3u8`,
        fileSizeBytes: 1,
      })),
      audio: [{ id: "a" }],
      subtitle: [],
      storage: { totalBytes: 1024 },
      ...overrides,
    } as never,
    "matching",
  );
  return { state: "unknown" as const, summary, readAt: 1 };
}

// ------------------------------------------------------------------- probe

describe("the plan is built from the persisted probe, never from ffprobe", () => {
  it("reconstructs a probe from catalogue rows", () => {
    const row = movieRow("Dune");
    const probe = probeFromCatalogue(row, streams());
    expect(probe?.video.width).toBe(1920);
    expect(probe?.video.isHdr).toBe(false);
    expect(probe?.durationSeconds).toBe(7200);
    expect(probe?.audioTracks).toHaveLength(1);
  });

  it("reads HDR from the transfer characteristic, and from video_range", () => {
    const pq = probeFromCatalogue(
      movieRow("A", { colorTransfer: "smpte2084" }),
      streams(),
    );
    expect(pq?.video.isHdr).toBe(true);

    const ranged = probeFromCatalogue(
      movieRow("B", { colorTransfer: null, videoRange: "HDR10" }),
      streams(),
    );
    expect(ranged?.video.isHdr).toBe(true);
  });

  it("has no plan for a file that has not been probed", () => {
    const row = movieRow("Unprobed", {
      width: null,
      height: null,
      probeState: "pending",
    });
    expect(probeFromCatalogue(row, [])).toBeNull();
    const title = projectTitle(row, context({ rows: [row] }));
    expect(title.probed).toBe(false);
    expect(title.plan).toBeNull();
    expect(title.processable).toBe(false);
  });

  it("counts only container subtitles as streams the packager would copy", () => {
    const probe = probeFromCatalogue(
      movieRow("Sidecars"),
      streams([
        { kind: "subtitle", codec: "subrip", isExternal: false },
        {
          kind: "subtitle",
          codec: "subrip",
          isExternal: true,
          externalRelativePath: "Movies/X/X.tr.srt",
        },
      ]),
    );
    expect(probe?.subtitleTracks).toHaveLength(1);
  });
});

// --------------------------------------------------------------- hierarchy

describe("the series hierarchy", () => {
  const show = { seriesId: "series-andor", title: "Andor" };
  const s1 = { seasonId: "season-andor-1", number: 1 };
  const s2 = { seasonId: "season-andor-2", number: 2 };

  it("builds series → season → episode from catalogue relations", () => {
    const rows = [
      episodeRow(show, s1, { number: 1, title: "Kassa" }),
      episodeRow(show, s1, { number: 2, title: "That Would Be Me" }),
      episodeRow(show, s2, { number: 1, title: "One Year Later" }),
    ];
    const view = projectCatalogue(rows, context({ rows }));

    expect(view.movies).toEqual([]);
    expect(view.series).toHaveLength(1);
    const series = view.series[0]!;
    expect(series.title).toBe("Andor");
    expect(series.seasonCount).toBe(2);
    expect(series.episodeCount).toBe(3);
    expect(series.seasons.map((season) => season.seasonNumber)).toEqual([1, 2]);
    expect(series.seasons[0]!.episodes.map((entry) => entry.code)).toEqual([
      "S01E01",
      "S01E02",
    ]);
  });

  /*
   * The regression this exists for: a lexicographic sort puts episode 10
   * before episode 2, which is what every naive listing of a season does.
   */
  it("orders episodes numerically, so E2 comes before E10", () => {
    const rows = [10, 2, 1, 11, 3].map((number) =>
      episodeRow(show, s1, { number, title: `Episode ${number}` }),
    );
    const view = projectCatalogue(rows, context({ rows }));
    expect(
      view.series[0]!.seasons[0]!.episodes.map((entry) => entry.episodeNumber),
    ).toEqual([1, 2, 3, 10, 11]);
  });

  it("orders seasons numerically, so season 2 comes before season 10", () => {
    const rows = [10, 2, 1].map((number) =>
      episodeRow(
        show,
        { seasonId: `season-${number}`, number },
        { number: 1, title: "Premiere" },
      ),
    );
    const view = projectCatalogue(rows, context({ rows }));
    expect(view.series[0]!.seasons.map((s) => s.seasonNumber)).toEqual([
      1, 2, 10,
    ]);
  });

  it("keeps S01E01 and S02E01 distinct", () => {
    const rows = [
      episodeRow(show, s1, { number: 1, title: "Kassa" }),
      episodeRow(show, s2, { number: 1, title: "One Year Later" }),
    ];
    const view = projectCatalogue(rows, context({ rows }));
    const codes = view.series[0]!.seasons.flatMap((season) =>
      season.episodes.map((entry) => entry.code),
    );
    expect(codes).toEqual(["S01E01", "S02E01"]);
    expect(new Set(codes).size).toBe(2);
  });

  it("sorts series by the catalogue's own sort title", () => {
    const rows = [
      episodeRow(
        {
          seriesId: "s-sopranos",
          title: "The Sopranos",
          sortTitle: "sopranos",
        },
        { seasonId: "sop-1", number: 1 },
        { number: 1, title: "Pilot" },
      ),
      episodeRow(
        { seriesId: "s-andor", title: "Andor", sortTitle: "andor" },
        { seasonId: "andor-1", number: 1 },
        { number: 1, title: "Kassa" },
      ),
      episodeRow(
        { seriesId: "s-ezel", title: "Ezel", sortTitle: "ezel" },
        { seasonId: "ezel-1", number: 1 },
        { number: 1, title: "Episode 1" },
      ),
    ];
    const view = projectCatalogue(rows, context({ rows }));
    expect(view.series.map((entry) => entry.title)).toEqual([
      "Andor",
      "Ezel",
      "The Sopranos",
    ]);
  });

  /*
   * `House of the Dragon - S03E05` ships as both `.mkv` and `.mp4`. The
   * catalogue treats those as two representations of one episode and hands
   * this layer a single row carrying the canonical file, so the episode must
   * appear once — and must say that it has an alternate, because that is the
   * difference between "one file" and "one of two".
   */
  it("shows an episode with two containers once, as one canonical source", () => {
    const rows = [
      episodeRow(
        { seriesId: "s-hotd", title: "House of the Dragon" },
        { seasonId: "hotd-3", number: 3 },
        { number: 5, title: "Unbowed and Unbent" },
        { fileCount: 2 },
      ),
    ];
    const view = projectCatalogue(rows, context({ rows }));
    const episodes = view.series[0]!.seasons[0]!.episodes;
    expect(episodes).toHaveLength(1);
    expect(episodes[0]!.code).toBe("S03E05");
    expect(episodes[0]!.fileCount).toBe(2);
  });

  it("drops an episode the catalogue has not yet placed in a season", () => {
    const rows = [
      episodeRow(show, s1, { number: 1, title: "Kassa" }, { seasonId: null }),
    ];
    expect(projectCatalogue(rows, context({ rows })).series).toEqual([]);
  });

  it("keeps films and shows in separate parts of the view", () => {
    const rows = [
      movieRow("Dune"),
      episodeRow(show, s1, { number: 1, title: "Kassa" }),
    ];
    const view = projectCatalogue(rows, context({ rows }));
    expect(view.movies.map((movie) => movie.title)).toEqual(["Dune"]);
    expect(view.series.map((entry) => entry.title)).toEqual(["Andor"]);
  });
});

// ----------------------------------------------------------- title states

describe("what each title reports about its own work", () => {
  const show = { seriesId: "series-x", title: "Show" };
  const season = { seasonId: "season-x-1", number: 1 };

  it("a source with no package is processable and lists the whole ladder", () => {
    const row = episodeRow(show, season, { number: 1, title: "Pilot" });
    const title = projectTitle(row, context({ rows: [row] }));
    expect(title.packageState).toBe("none");
    expect(title.processable).toBe(true);
    expect(title.plan?.missingRungs).toEqual(title.plan?.ladder);
    expect(title.plan?.ladder).toContain(1080);
  });

  it("a partly packaged source reports what is there and what is left", () => {
    const row = episodeRow(show, season, { number: 1, title: "Pilot" });
    const title = projectTitle(
      row,
      context({
        rows: [row],
        packages: { [row.mediaFileId!]: packaged([1080, 720]) },
      }),
    );
    expect(title.package?.rungs).toEqual([1080, 720]);
    expect(title.plan?.missingRungs).not.toContain(1080);
    expect(title.plan?.missingRungs).toContain(480);
    expect(title.processable).toBe(true);
  });

  it("a fully packaged source has nothing left and is not processable", () => {
    const row = episodeRow(show, season, {
      number: 1,
      title: "Pilot",
    });
    const full = packaged([1080, 720, 480, 360, 240, 144]);
    const title = projectTitle(
      row,
      context({
        rows: [row],
        packages: {
          [row.mediaFileId!]: { ...full, state: "complete" as const },
        },
      }),
    );
    expect(title.packageState).toBe("complete");
    expect(title.plan?.missingRungs).toEqual([]);
    expect(title.processable).toBe(false);
  });

  /*
   * The case the movie page already handles and television must handle the
   * same way: the source is gone, the package is not, and the title stays
   * visible as a finished one that cannot be started.
   */
  it("keeps a title whose source is gone but whose package remains", () => {
    const row = episodeRow(
      show,
      season,
      { number: 1, title: "Pilot" },
      { fileMissingSince: new Date("2026-08-01T00:00:00.000Z") },
    );
    const full = packaged([1080, 720, 480, 360, 240, 144]);
    const title = projectTitle(
      row,
      context({
        rows: [row],
        packages: {
          [row.mediaFileId!]: { ...full, state: "complete" as const },
        },
      }),
    );
    expect(title.sourceAvailable).toBe(false);
    expect(title.processable).toBe(false);
    expect(title.package?.rungs).toContain(1080);
  });

  it("does not offer a title that already has a job", () => {
    const row = episodeRow(show, season, { number: 1, title: "Pilot" });
    const title = projectTitle(
      row,
      context({
        rows: [row],
        jobs: [
          {
            id: "job-1",
            itemId: row.itemId,
            mediaFileId: row.mediaFileId!,
            state: "running",
          } as unknown as ProcessingJobRecord,
        ],
      }),
    );
    expect(title.activeJobId).toBe("job-1");
    expect(title.activeJobState).toBe("running");
    expect(title.processable).toBe(false);
  });

  /*
   * An index that has not read a title yet knows nothing about it, and "I have
   * not looked" must never be shown or counted as "there is nothing there".
   */
  it("treats an unread package as unknown, and still offers the title", () => {
    const row = episodeRow(show, season, { number: 1, title: "Pilot" });
    const title = projectTitle(
      row,
      context({
        rows: [row],
        packages: {
          [row.mediaFileId!]: { state: "unknown", summary: null, readAt: 0 },
        },
      }),
    );
    expect(title.packageState).toBe("unknown");
    expect(title.processable).toBe(true);
  });
});

// ---------------------------------------------------------------- counts

describe("series and season aggregates", () => {
  it("derives every count from the episodes, never from its own state", () => {
    const show = { seriesId: "series-c", title: "Counted" };
    const s1 = { seasonId: "c-1", number: 1 };
    const s2 = { seasonId: "c-2", number: 2 };
    const rows = [
      episodeRow(show, s1, { number: 1, title: "A" }),
      episodeRow(show, s1, { number: 2, title: "B" }),
      episodeRow(show, s2, { number: 1, title: "C" }),
      episodeRow(
        show,
        s2,
        { number: 2, title: "D" },
        { fileMissingSince: new Date() },
      ),
    ];
    const complete = {
      ...packaged([1080, 720, 480, 360, 240, 144]),
      state: "complete" as const,
    };
    const view = projectCatalogue(
      rows,
      context({
        rows,
        packages: {
          [rows[0]!.mediaFileId!]: complete,
          [rows[1]!.mediaFileId!]: { ...packaged([1080]), state: "partial" },
          [rows[3]!.mediaFileId!]: complete,
        },
      }),
    );

    const series = view.series[0]!;
    expect(series.counts.total).toBe(4);
    expect(series.counts.complete).toBe(2);
    expect(series.counts.partial).toBe(1);
    expect(series.counts.unprocessed).toBe(1);
    expect(series.counts.unavailable).toBe(1);

    expect(series.seasons[0]!.counts.total).toBe(2);
    expect(series.seasons[0]!.counts.complete).toBe(1);
    expect(series.seasons[1]!.counts.unavailable).toBe(1);

    // The season totals are exactly the series total, by construction.
    const summed = series.seasons.reduce(
      (total, season) => total + season.counts.total,
      0,
    );
    expect(summed).toBe(series.counts.total);
  });

  it("counts an empty list without inventing anything", () => {
    expect(countTitles([])).toMatchObject({ total: 0, eligible: 0 });
  });
});

// ------------------------------------------------------------ performance

describe("a large library stays a catalogue operation", () => {
  it("projects a show with 6 seasons and 86 episodes without touching disk", () => {
    const show = { seriesId: "series-sopranos", title: "The Sopranos" };
    const perSeason = [13, 13, 13, 13, 21, 13];
    const rows: ProcessableTitleRow[] = [];
    perSeason.forEach((count, index) => {
      const seasonNumber = index + 1;
      for (let episode = 1; episode <= count; episode += 1) {
        rows.push(
          episodeRow(
            show,
            { seasonId: `sopranos-${seasonNumber}`, number: seasonNumber },
            { number: episode, title: `Episode ${episode}` },
          ),
        );
      }
    });
    expect(rows).toHaveLength(86);

    /*
     * The package lookup is counted rather than mocked away. One read per
     * title and no more is the whole property: a per-episode directory scan
     * would show up here as a multiple of it.
     */
    const packageFor = vi.fn(() => ({
      state: "none" as const,
      summary: null,
      readAt: 1,
    }));
    const view = projectCatalogue(rows, {
      ...context({ rows }),
      packageFor,
    });

    const series = view.series[0]!;
    expect(series.seasonCount).toBe(6);
    expect(series.episodeCount).toBe(86);
    expect(packageFor).toHaveBeenCalledTimes(86);
    expect(series.seasons[4]!.episodes).toHaveLength(21);
    expect(series.seasons[4]!.episodes[0]!.code).toBe("S05E01");
  });

  it("names one index target per title, keyed by the canonical file", () => {
    const rows = [
      movieRow("Dune"),
      episodeRow(
        { seriesId: "s", title: "Andor" },
        { seasonId: "s1", number: 1 },
        { number: 1, title: "Kassa" },
      ),
      movieRow("No file", { mediaFileId: null, relativePath: null }),
    ];
    const targets = packageTargetsFor(rows, "/media");
    expect(targets).toHaveLength(2);
    expect(targets[1]!.kind).toBe("episode");
    expect(targets[1]!.sourcePath).toContain("Series/Andor/Season 1/");
  });
});

describe("episode codes", () => {
  it("pads both numbers, and copes with an unnumbered episode", () => {
    expect(episodeCode(1, 1)).toBe("S01E01");
    expect(episodeCode(2, 12)).toBe("S02E12");
    expect(episodeCode(12, 345)).toBe("S12E345");
    expect(episodeCode(1, null)).toBe("S01");
  });
});
