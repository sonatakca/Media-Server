// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabasePool } from "../database/databasePool";
import { runMigrations } from "../database/migrationRunner";
import { createMonitoringRepository } from "./monitoringRepository";

/*
 * Monitoring is inheritance, and inheritance is only correct if the rows and
 * the resolver agree. A double could confirm neither: the tri-state is a
 * PostgreSQL enum, the upserts are what make concurrent edits safe, and both
 * only exist in the database.
 *
 * Requires a disposable database. The schema is dropped.
 */
const databaseUrl = process.env.SEYIRLIK_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("monitoring in PostgreSQL", () => {
  const pool = createDatabasePool({
    connectionString: databaseUrl as string,
    maxConnections: 4,
  });
  const repository = createMonitoringRepository(pool);
  let libraryId: string;
  let seriesId: string;

  beforeAll(async () => {
    await pool.query("DROP SCHEMA public CASCADE");
    await pool.query("CREATE SCHEMA public");
    await runMigrations(pool);

    libraryId = randomUUID();
    await pool.query(
      `INSERT INTO libraries (id, slug, name, kind) VALUES ($1,'series','Series','series')`,
      [libraryId],
    );
    seriesId = randomUUID();
    await pool.query(
      `INSERT INTO items (id, library_id, kind, source_key, title, sort_title)
       VALUES ($1,$2,'series','series:dragon','House of the Dragon','house of the dragon')`,
      [seriesId, libraryId],
    );
  });

  afterAll(async () => {
    await pool.end();
  });

  it("treats a title nobody has set as unmonitored", async () => {
    /*
     * The default matters: monitored-by-default would mean that cataloguing a
     * library instructed Seyirlik to go and acquire all of it.
     */
    expect(await repository.readTitle(seriesId)).toBeNull();
    const series = await repository.readSeries(seriesId);
    expect(series?.title.monitored).toBe(false);
  });

  it("sets and reads a title's own state", async () => {
    const saved = await repository.setTitle(seriesId, { monitored: true });
    expect(saved.monitored).toBe(true);
    expect((await repository.readTitle(seriesId))?.monitored).toBe(true);
  });

  it("inherits a season from the title when the season has no opinion", async () => {
    await repository.setTitle(seriesId, { monitored: true });
    await repository.setSeason(seriesId, 1, "inherit");
    const series = await repository.readSeries(seriesId);
    const season = series!.seasons.find((s) => s.seasonNumber === 1)!;
    expect(season.effective.monitored).toBe(true);
    expect(season.effective.decidedBy).toBe("series");
  });

  it("lets a season override an unmonitored title", async () => {
    await repository.setTitle(seriesId, { monitored: false });
    await repository.setSeason(seriesId, 2, "monitored");
    const series = await repository.readSeries(seriesId);
    const season = series!.seasons.find((s) => s.seasonNumber === 2)!;
    expect(season.effective.monitored).toBe(true);
    expect(season.effective.decidedBy).toBe("season");
  });

  it("lets an episode override its season, which overrides the title", async () => {
    // The case three booleans cannot express.
    await repository.setTitle(seriesId, { monitored: true });
    await repository.setSeason(seriesId, 3, "unmonitored");
    await repository.setEpisode(seriesId, 3, 5, "monitored");

    const series = await repository.readSeries(seriesId);
    const episode = series!.episodes.find(
      (e) => e.seasonNumber === 3 && e.episodeNumber === 5,
    )!;
    expect(episode.effective.monitored).toBe(true);
    expect(episode.effective.decidedBy).toBe("episode");

    await repository.setEpisode(seriesId, 3, 6, "inherit");
    const reread = await repository.readSeries(seriesId);
    const inherited = reread!.episodes.find(
      (e) => e.seasonNumber === 3 && e.episodeNumber === 6,
    )!;
    expect(inherited.effective.monitored).toBe(false);
    expect(inherited.effective.decidedBy).toBe("season");
  });

  it("clears an override back to inherit", async () => {
    await repository.setTitle(seriesId, { monitored: true });
    await repository.setSeason(seriesId, 4, "unmonitored");
    let series = await repository.readSeries(seriesId);
    expect(
      series!.seasons.find((s) => s.seasonNumber === 4)!.effective.monitored,
    ).toBe(false);

    await repository.setSeason(seriesId, 4, "inherit");
    series = await repository.readSeries(seriesId);
    const season = series!.seasons.find((s) => s.seasonNumber === 4)!;
    expect(season.monitoring).toBe("inherit");
    expect(season.effective.monitored).toBe(true);
    expect(season.effective.decidedBy).toBe("series");
  });

  it("survives two writers setting the same season at once", async () => {
    /*
     * The upsert is one statement, so there is no read-then-write for a second
     * writer to interleave with. Both succeed and the row holds one of the two
     * values rather than neither.
     */
    await Promise.all([
      repository.setSeason(seriesId, 7, "monitored"),
      repository.setSeason(seriesId, 7, "unmonitored"),
    ]);
    const series = await repository.readSeries(seriesId);
    const season = series!.seasons.find((s) => s.seasonNumber === 7)!;
    expect(["monitored", "unmonitored"]).toContain(season.monitoring);
  });

  it("survives two writers setting the same title at once", async () => {
    await Promise.all([
      repository.setTitle(seriesId, { monitored: true }),
      repository.setTitle(seriesId, { monitored: false }),
    ]);
    expect(await repository.readTitle(seriesId)).not.toBeNull();
  });

  it("says nothing for an identity it does not know", async () => {
    const absent = "00000000-0000-4000-8000-000000000000";
    expect(await repository.readTitle(absent)).toBeNull();
    expect(await repository.readSeries(absent)).toBeNull();
  });

  it("keeps what it stored across a new connection", async () => {
    // Restart persistence: a second pool sees what the first one wrote.
    await repository.setTitle(seriesId, { monitored: true });
    await repository.setSeason(seriesId, 9, "unmonitored");

    const second = createDatabasePool({
      connectionString: databaseUrl as string,
      maxConnections: 2,
    });
    try {
      const reread = createMonitoringRepository(second);
      const series = await reread.readSeries(seriesId);
      expect(series!.title.monitored).toBe(true);
      expect(
        series!.seasons.find((s) => s.seasonNumber === 9)!.monitoring,
      ).toBe("unmonitored");
    } finally {
      await second.end();
    }
  });

  it("lists the titles the acquisition side should act on", async () => {
    await repository.setTitle(seriesId, { monitored: true });
    const monitored = await repository.listMonitoredTitles();
    expect(monitored.map((row) => row.itemId)).toContain(seriesId);

    await repository.setTitle(seriesId, { monitored: false });
    const after = await repository.listMonitoredTitles();
    expect(after.map((row) => row.itemId)).not.toContain(seriesId);
  });

  it("keeps a profile association when a later write does not mention one", async () => {
    const profileId = randomUUID();
    await pool.query(
      `INSERT INTO quality_profiles (id, name, items, cutoff_quality_id)
       VALUES ($1, 'HD-1080p', $2::jsonb, 'webdl-1080p')`,
      [profileId, JSON.stringify([["webdl-1080p"]])],
    );
    await repository.setTitle(seriesId, { monitored: true, profileId });
    await repository.setTitle(seriesId, { monitored: false });
    expect((await repository.readTitle(seriesId))?.profileId).toBe(profileId);
  });
});
