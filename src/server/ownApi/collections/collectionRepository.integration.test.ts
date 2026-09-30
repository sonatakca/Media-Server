// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabasePool } from "../database/databasePool";
import { runMigrations } from "../database/migrationRunner";
import { createCatalogueRepository } from "../catalogue/catalogueRepository";
import { createCatalogueScanStore } from "../catalogue/catalogueScanStore";
import { createCollectionRepository } from "./collectionRepository";

const databaseUrl = process.env.SEYIRLIK_TEST_DATABASE_URL;
(databaseUrl ? describe : describe.skip)("provider collections", () => {
  const pool = createDatabasePool({
    connectionString: databaseUrl!,
    maxConnections: 4,
  });
  const user = randomUUID();
  const library = randomUUID();
  const catalogue = createCatalogueRepository(pool);
  const collections = createCollectionRepository(pool);

  async function film(title: string, onDisk = true) {
    const id = randomUUID();
    await pool.query(
      "INSERT INTO items (id, library_id, kind, source_key, title, sort_title) VALUES ($1,$2,'movie',$3::text,$3::text,$3::text)",
      [id, library, title],
    );
    if (onDisk) {
      await pool.query(
        "INSERT INTO media_files (id,item_id,relative_path,size_bytes,mtime_ms,fingerprint) VALUES ($1,$2,$3,1024,1,'test')",
        [randomUUID(), id, `${title}.mkv`],
      );
    }
    return id;
  }

  beforeAll(async () => {
    // Runs only against an explicitly supplied disposable test database.
    await pool.query("DROP SCHEMA public CASCADE");
    await pool.query("CREATE SCHEMA public");
    await runMigrations(pool);
    await pool.query(
      "INSERT INTO native_users (id,normalized_username,display_name,password_hash) VALUES ($1,'viewer','Viewer','$argon2id$test')",
      [user],
    );
    await pool.query(
      "INSERT INTO libraries (id,slug,name,kind) VALUES ($1,'movies','Movies','movies')",
      [library],
    );
  });
  afterAll(async () => {
    await pool.end();
  });

  it("lists a collection with its films as children, and counts them", async () => {
    const first = await film("The Matrix");
    const second = await film("The Matrix Reloaded");
    const wanted = await film("The Matrix Resurrections", false);
    const ref = { providerId: "2344", name: "The Matrix Collection" };

    const collectionId = await collections.attach(first, ref);
    expect(await collections.attach(second, ref)).toBe(collectionId);
    await collections.attach(wanted, ref);

    const listed = await catalogue.listItems({
      userId: user,
      kinds: ["collection"],
      limit: 10,
    });
    expect(listed.map((row) => row.id)).toEqual([collectionId]);

    const children = await catalogue.listItems({
      userId: user,
      parentId: collectionId,
      limit: 10,
    });
    // The film with no file is a member, but not something to watch.
    expect(children.map((row) => row.id).sort()).toEqual(
      [first, second].sort(),
    );

    const counted = await pool.query<{ child_count: number }>(
      "SELECT child_count FROM items WHERE id = $1",
      [collectionId],
    );
    expect(counted.rows[0]?.child_count).toBe(3);
  });

  it("survives a library scan that finds no folder for it", async () => {
    const scanStore = createCatalogueScanStore(pool);
    const existing = await scanStore.listItems(library);
    expect(existing.some((row) => row.kind === "collection")).toBe(false);
  });

  it("removes a collection when its last film leaves", async () => {
    const lone = await film("Dune");
    const collectionId = await collections.attach(lone, {
      providerId: "726871",
      name: "Dune Collection",
    });
    await collections.detach(lone);
    const remaining = await pool.query("SELECT 1 FROM items WHERE id = $1", [
      collectionId,
    ]);
    expect(remaining.rowCount).toBe(0);
  });
});
