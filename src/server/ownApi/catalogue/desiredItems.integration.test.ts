// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabasePool } from "../database/databasePool";
import { runMigrations } from "../database/migrationRunner";
import { createDesiredItemRepository } from "./desiredItems";

/* Requires a disposable database. The schema is dropped. */
const databaseUrl = process.env.SEYIRLIK_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

/**
 * Written because the unit tests could not have caught what went wrong.
 *
 * The first version read the new row back through a data-modifying CTE, and a
 * CTE's insert is not visible to the SELECT beside it. Every genuinely new
 * title — the only case this repository exists for — returned no row and threw,
 * after the insert had already happened. Only a real database says that.
 */
integration("desired items in PostgreSQL", () => {
  const pool = createDatabasePool({
    connectionString: databaseUrl as string,
    maxConnections: 4,
  });
  const repository = createDesiredItemRepository(pool);
  const libraryId = randomUUID();

  beforeAll(async () => {
    await pool.query("DROP SCHEMA public CASCADE");
    await pool.query("CREATE SCHEMA public");
    await runMigrations(pool);
    await pool.query(
      `INSERT INTO libraries (id, slug, name, kind) VALUES ($1, 'movies', 'Movies', 'movies')`,
      [libraryId],
    );
  });

  afterAll(async () => {
    await pool.end();
  });

  it("creates a title nobody has yet, and returns it", async () => {
    const created = await repository.desire({
      libraryId,
      libraryRoot: "Movies",
      kind: "movie",
      title: "Oppenheimer",
      year: 2023,
    });
    expect(created.desired).toBe(true);
    expect(created.hasMedia).toBe(false);
    expect(created.sourceKey).toBe("movie:movies/oppenheimer (2023)");
  });

  it("is idempotent, and does not duplicate the title", async () => {
    const again = await repository.desire({
      libraryId,
      libraryRoot: "Movies",
      kind: "movie",
      title: "Oppenheimer",
      year: 2023,
    });
    const all = await repository.list(libraryId);
    expect(
      all.filter((item) => item.sourceKey === again.sourceKey),
    ).toHaveLength(1);
  });

  it("lists it as still missing until media exists", async () => {
    const missing = await repository.listMissing();
    expect(missing.map((item) => item.title)).toContain("Oppenheimer");
  });

  it("stops calling it missing once a file is attached to the same row", async () => {
    const [item] = await repository.list(libraryId);
    await pool.query(
      `INSERT INTO media_files
         (id, item_id, relative_path, container, size_bytes, mtime_ms, fingerprint, is_primary)
       VALUES ($1, $2, $3, 'mkv', 1, 1, 'fp', true)`,
      [
        randomUUID(),
        item!.id,
        "Movies/Oppenheimer (2023)/Oppenheimer (2023).mkv",
      ],
    );
    const missing = await repository.listMissing();
    expect(missing.map((title) => title.title)).not.toContain("Oppenheimer");

    // Still desired: acquiring it did not discard the intent.
    const listed = await repository.list(libraryId);
    expect(listed[0]!.desired).toBe(true);
    expect(listed[0]!.hasMedia).toBe(true);
  });
});
