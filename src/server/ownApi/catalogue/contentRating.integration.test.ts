// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabasePool } from "../database/databasePool";
import { runMigrations } from "../database/migrationRunner";
import { createCatalogueRepository } from "./catalogueRepository";

const databaseUrl = process.env.SEYIRLIK_TEST_DATABASE_URL;
(databaseUrl ? describe : describe.skip)("parental controls", () => {
  const pool = createDatabasePool({
    connectionString: databaseUrl!,
    maxConnections: 4,
  });
  const child = randomUUID();
  const library = randomUUID();
  const catalogue = createCatalogueRepository(pool);
  const ids: Record<string, string> = {};

  async function title(
    name: string,
    rating: string | null,
    kind = "movie",
    seriesId: string | null = null,
  ) {
    const id = randomUUID();
    ids[name] = id;
    await pool.query(
      "INSERT INTO items (id, library_id, kind, source_key, title, sort_title, official_rating, series_id) VALUES ($1,$2,$3,$4::text,$4::text,$4::text,$5,$6)",
      [id, library, kind, name, rating, seriesId],
    );
    await pool.query(
      "INSERT INTO media_files (id,item_id,relative_path,size_bytes,mtime_ms,fingerprint) VALUES ($1,$2,$3,1024,1,'test')",
      [randomUUID(), id, `${name}.mkv`],
    );
    return id;
  }

  beforeAll(async () => {
    // Runs only against an explicitly supplied disposable test database.
    await pool.query("DROP SCHEMA public CASCADE");
    await pool.query("CREATE SCHEMA public");
    await runMigrations(pool);
    await pool.query(
      "INSERT INTO native_users (id,normalized_username,display_name,password_hash,max_content_age) VALUES ($1,'child','Child','$argon2id$test',13)",
      [child],
    );
    await pool.query(
      "INSERT INTO libraries (id,slug,name,kind) VALUES ($1,'all','All','mixed')",
      [library],
    );
    await title("Paddington", "7+");
    await title("Spider-Man", "PG-13");
    await title("Fight Club", "18+");
    await title("Joker", "R");
    await title("Home Movie", null);
    const sopranos = randomUUID();
    ids.Sopranos = sopranos;
    await pool.query(
      "INSERT INTO items (id, library_id, kind, source_key, title, sort_title, official_rating) VALUES ($1,$2,'series','Sopranos','Sopranos','Sopranos','TV-MA')",
      [sopranos, library],
    );
    await title("Pilot", null, "episode", sopranos);
  });
  afterAll(async () => {
    await pool.end();
  });

  it("reads the ages the boards write", async () => {
    const ages = await pool.query<{ rating: string; age: number | null }>(
      `SELECT rating, seyirlik_rating_age(rating) AS age FROM unnest($1::text[]) AS rating`,
      [
        [
          "G",
          "7+",
          "PG",
          "PG-13",
          "TV-14",
          "R",
          "TV-MA",
          "18+",
          "FSK 16",
          "Genel İzleyici",
          "NR",
          "",
        ],
      ],
    );
    expect(
      Object.fromEntries(ages.rows.map((row) => [row.rating, row.age])),
    ).toEqual({
      G: 0,
      "7+": 7,
      PG: 10,
      "PG-13": 13,
      "TV-14": 14,
      R: 17,
      "TV-MA": 17,
      "18+": 18,
      "FSK 16": 16,
      "Genel İzleyici": 0,
      NR: null,
      "": null,
    });
  });

  it("shows a limited viewer only what is rated for them", async () => {
    const listed = await catalogue.listItems({ userId: child, limit: 50 });
    expect(listed.map((row) => row.title).sort()).toEqual([
      "Paddington",
      "Spider-Man",
    ]);
    // The episode follows its series' TV-MA, not its own missing rating.
    expect(await catalogue.canUserAccessItem(child, ids.Pilot!)).toBe(false);
    expect(await catalogue.canUserAccessItem(child, ids["Fight Club"]!)).toBe(
      false,
    );
  });

  it("admits unrated titles only when the viewer allows them", async () => {
    await pool.query(
      "UPDATE native_users SET allow_unrated_content = true WHERE id = $1",
      [child],
    );
    expect(await catalogue.canUserAccessItem(child, ids["Home Movie"]!)).toBe(
      true,
    );
    // An episode with a rated series is still judged by the series.
    expect(await catalogue.canUserAccessItem(child, ids.Pilot!)).toBe(false);
  });
});
