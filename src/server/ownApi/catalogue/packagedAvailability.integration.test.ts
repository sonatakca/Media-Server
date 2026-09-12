// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabasePool } from "../database/databasePool";
import { runMigrations } from "../database/migrationRunner";
import { createCatalogueScanStore } from "./catalogueScanStore";
import { createLibraryAdminRepository } from "./libraryAdmin";

/*
 * A fully processed title whose source packaging removed. The scanner proves
 * the package is complete and records it; the title must then read as held,
 * not as a failed probe and so as merely wanted. Requires a disposable database.
 */
const databaseUrl = process.env.SEYIRLIK_TEST_DATABASE_URL;
(databaseUrl ? describe : describe.skip)("a packaged title", () => {
  const pool = createDatabasePool({
    connectionString: databaseUrl!,
    maxConnections: 2,
  });
  const library = randomUUID();

  async function film(title: string, probeState: string, error?: string) {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO items (id, library_id, kind, source_key, title, sort_title, desired)
       VALUES ($1, $2, 'movie', $3, $4, $4, true)`,
      [id, library, `movie:movies/${title.toLowerCase()}`, title],
    );
    const fileId = randomUUID();
    await pool.query(
      `INSERT INTO media_files (id, item_id, relative_path, size_bytes, mtime_ms, fingerprint, probe_state, probe_error)
       VALUES ($1, $2, $3, 1000, 1, 'f', $4, $5)`,
      [fileId, id, `Movies/${title}/${title}.mp4`, probeState, error ?? null],
    );
    return { id, fileId };
  }

  beforeAll(async () => {
    // Only ever an explicitly supplied, disposable test database.
    await pool.query("DROP SCHEMA public CASCADE");
    await pool.query("CREATE SCHEMA public");
    await runMigrations(pool);
    await pool.query(
      `INSERT INTO libraries (id, slug, name, kind) VALUES ($1, 'movies', 'Movies', 'movies')`,
      [library],
    );
  });
  afterAll(async () => {
    await pool.end();
  });

  it("reads as held once the scanner records its package", async () => {
    const dune = await film("Dune", "failed", "No such file or directory");
    const repository = createLibraryAdminRepository(pool);
    const before = (await repository.listTitles("movie")).find(
      (title) => title.id === dune.id,
    );
    expect(before).toMatchObject({ status: "wanted", hasMedia: false });

    await createCatalogueScanStore(pool).markPackaged([dune.fileId]);

    const after = (await repository.listTitles("movie")).find(
      (title) => title.id === dune.id,
    );
    expect(after).toMatchObject({ status: "downloaded", hasMedia: true });
    const row = await pool.query<{ probe_state: string; probe_error: string }>(
      "SELECT probe_state, probe_error FROM media_files WHERE id = $1",
      [dune.fileId],
    );
    expect(row.rows[0]).toEqual({ probe_state: "packaged", probe_error: null });
  });

  it("keeps a probe that succeeded, and leaves a damaged file refused", async () => {
    const probed = await film("Heat", "probed");
    await createCatalogueScanStore(pool).markPackaged([probed.fileId]);
    const row = await pool.query<{ probe_state: string }>(
      "SELECT probe_state FROM media_files WHERE id = $1",
      [probed.fileId],
    );
    expect(row.rows[0]!.probe_state).toBe("probed");

    // Not packaged: a file the prober rejected stays unavailable.
    const damaged = await film("Ezel", "failed", "Invalid data found");
    const title = (
      await createLibraryAdminRepository(pool).listTitles("movie")
    ).find((candidate) => candidate.id === damaged.id);
    expect(title?.hasMedia).toBe(false);
  });
});
