// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabasePool } from "../database/databasePool";
import { runMigrations } from "../database/migrationRunner";
import { createSubtitleExecutionRepository } from "./subtitleExecution";
import { createSubtitleRepository } from "./subtitleRepository";
import { normalizeWant } from "./subtitleState";

/*
 * The facts a subtitle search starts from, read by the execution
 * repository's own SQL: the IMDb id, the video's frame rate, and the release
 * name the file was imported under. Requires a disposable database.
 */
const databaseUrl = process.env.SEYIRLIK_TEST_DATABASE_URL;
(databaseUrl ? describe : describe.skip)("what a subtitle search knows", () => {
  const pool = createDatabasePool({
    connectionString: databaseUrl!,
    maxConnections: 4,
  });
  const repository = createSubtitleRepository(pool);
  let attemptId = "";

  beforeAll(async () => {
    await pool.query("DROP SCHEMA public CASCADE");
    await pool.query("CREATE SCHEMA public");
    await runMigrations(pool);
    const libraryId = randomUUID();
    const seriesId = randomUUID();
    const episodeId = randomUUID();
    const fileId = randomUUID();
    await pool.query(
      `INSERT INTO libraries (id, slug, name, kind) VALUES ($1, 'series', 'Series', 'series')`,
      [libraryId],
    );
    await pool.query(
      `INSERT INTO items (id, library_id, kind, source_key, title, sort_title, production_year, provider_ids)
       VALUES ($1, $2, 'series', 'series:series/chernobyl', 'Chernobyl', 'Chernobyl', 2019, '{"imdb":"tt7366338"}')`,
      [seriesId, libraryId],
    );
    await pool.query(
      `INSERT INTO items (id, library_id, kind, source_key, title, sort_title, series_id, parent_index_number, index_number)
       VALUES ($1, $2, 'episode', 'episode:series:series/chernobyl:1:2', 'Please Remain Calm', 'x', $3, 1, 2)`,
      [episodeId, libraryId, seriesId],
    );
    await pool.query(
      `INSERT INTO media_files (id, item_id, relative_path, size_bytes, mtime_ms, fingerprint)
       VALUES ($1, $2, 'Series/Chernobyl/Season 1/Chernobyl - S01E02.mkv', 1, 1, 'f')`,
      [fileId, episodeId],
    );
    await pool.query(
      `INSERT INTO media_streams (media_file_id, stream_index, kind, codec, frame_rate)
       VALUES ($1, 0, 'video', 'h264', 23.976)`,
      [fileId],
    );
    const importId = randomUUID();
    await pool.query(
      `INSERT INTO imports (id, idempotency_key, target_kind, target_item_id, target_title, source_root,
         library_root, source_relative, state)
       VALUES ($1, 'k', 'episode', $2, 'Chernobyl', 'downloads', 'Series', 'Chernobyl.S01.1080p.BluRay.x264-DON', 'complete')`,
      [importId, episodeId],
    );
    await pool.query(
      `INSERT INTO import_files (id, import_id, role, source_relative, destination_relative, state)
       VALUES ($1, $2, 'media', 'Chernobyl.S01.1080p.BluRay.x264-DON/Chernobyl.S01E02.1080p.BluRay.x264-DON.mkv',
               'Chernobyl/Season 1/Chernobyl - S01E02.mkv', 'committed')`,
      [randomUUID(), importId],
    );
    const want = await repository.ensureWant(
      fileId,
      normalizeWant({ language: "tr" }),
    );
    attemptId = (await repository.beginAttempt(want.id)).id;
  }, 60_000);

  afterAll(async () => {
    await pool.end();
  });

  it("carries the series' IMDb id, the frame rate and the imported release name", async () => {
    const query = await createSubtitleExecutionRepository(pool).withAttempt(
      attemptId,
      async (work) => work.query,
    );
    expect(query).toMatchObject({
      title: "Chernobyl",
      year: 2019,
      season: 1,
      episode: 2,
      imdbId: "tt7366338",
      releaseTitle: "Chernobyl.S01E02.1080p.BluRay.x264-DON",
    });
    expect(query?.frameRate).toBeCloseTo(23.976, 3);
  });

  it("labels the attempt with what it is for", async () => {
    const [attempt] = await repository.recentAttempts();
    expect(attempt).toMatchObject({
      title: "Chernobyl",
      seasonNumber: 1,
      episodeNumber: 2,
    });
  });
});
