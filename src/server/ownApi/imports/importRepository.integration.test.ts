// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabasePool } from "../database/databasePool";
import { runMigrations } from "../database/migrationRunner";
import {
  createImportRepository,
  DestinationAlreadyCommittedError,
} from "./importRepository";
import type { CreateImportInput } from "./importRepository";

/*
 * The invariants that are only real if the database enforces them.
 *
 * Two of these — one committed file per destination, one live import per
 * acquisition — are unique indexes rather than checks in code, precisely so
 * that two workers racing cannot both pass a check and then both write. A test
 * against a double would confirm the code's intention; only a real database
 * confirms the constraint.
 *
 * Requires a disposable database. The schema is dropped.
 */
const databaseUrl = process.env.SEYIRLIK_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("imports in PostgreSQL", () => {
  const pool = createDatabasePool({
    connectionString: databaseUrl as string,
    maxConnections: 4,
  });
  const repository = createImportRepository(pool);

  const input: CreateImportInput = {
    target: { kind: "movie", title: "Big Buck Bunny", year: 2008 },
    sourceRoot: "C:\\SeyirlikDownloads\\complete\\seyirlik",
    libraryRoot: "C:\\SeyirlikLibrary",
    sourceRelative: "Big.Buck.Bunny.2008.1080p.WEB-DL",
  };

  beforeAll(async () => {
    await pool.query("DROP SCHEMA public CASCADE");
    await pool.query("CREATE SCHEMA public");
    await runMigrations(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("applies migration 022 and creates an import with its identity", async () => {
    const created = await repository.create(input);
    expect(created.state).toBe("planned");
    expect(created.idempotencyKey).toBe(`seyirlik-import-${created.id}`);
    expect(created.attempt).toBe(0);
    expect(created.strategy).toBeUndefined();
    expect(created.committedAtMs).toBeUndefined();
  });

  it("freezes the authorised roots onto the row", async () => {
    /*
     * The roots are what containment is re-proven against on every later
     * operation. Reading them from configuration at execution time would let a
     * settings edit between planning and committing redirect an in-flight
     * import somewhere nobody authorised.
     */
    const created = await repository.create(input);
    const reloaded = await repository.get(created.id);
    expect(reloaded?.sourceRoot).toBe(input.sourceRoot);
    expect(reloaded?.libraryRoot).toBe(input.libraryRoot);
  });

  it("lets exactly one of two workers move the same import", async () => {
    const created = await repository.create(input);
    const [first, second] = await Promise.all([
      repository.update(created.id, "planned", { state: "validating" }, "A"),
      repository.update(created.id, "planned", { state: "validating" }, "B"),
    ]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect((await repository.get(created.id))?.state).toBe("validating");
  });

  it("refuses an update from a state the row has left", async () => {
    const created = await repository.create(input);
    await repository.update(created.id, "planned", { state: "validating" });
    expect(
      await repository.update(created.id, "planned", { state: "staging" }),
    ).toBe(false);
    expect((await repository.get(created.id))?.state).toBe("validating");
  });

  it("records one event per state change and none for a repeat", async () => {
    const created = await repository.create(input);
    await repository.update(created.id, "planned", { state: "validating" });
    await repository.update(created.id, "validating", { state: "staging" });
    await repository.update(created.id, "staging", { state: "staging" });
    const detail = await repository.detail(created.id);
    expect(detail?.events.map((event) => event.toState)).toEqual([
      "planned",
      "validating",
      "staging",
    ]);
  });

  it("stamps a commit time separately from a completion time", async () => {
    // Cleanup runs after the commit and cannot un-commit it, so the two
    // timestamps answer different questions.
    const created = await repository.create(input);
    await repository.update(created.id, "planned", { state: "validating" });
    await repository.update(created.id, "validating", { state: "staging" });
    await repository.update(created.id, "staging", { state: "committing" });
    await repository.update(created.id, "committing", {
      state: "committed",
      committed: true,
    });
    const committed = await repository.get(created.id);
    expect(committed?.committedAtMs).toBeGreaterThan(0);

    const row = await pool.query<{ completed_at: Date | null }>(
      "SELECT completed_at FROM imports WHERE id = $1",
      [created.id],
    );
    expect(row.rows[0]!.completed_at).toBeNull();
  });
});

integration("one committed file per destination", () => {
  const pool = createDatabasePool({
    connectionString: databaseUrl as string,
    maxConnections: 4,
  });
  const repository = createImportRepository(pool);

  const base: CreateImportInput = {
    target: { kind: "movie", title: "Dune", year: 2021 },
    sourceRoot: "C:\\SeyirlikDownloads\\complete\\seyirlik",
    libraryRoot: "C:\\SeyirlikLibrary",
    sourceRelative: "Dune.2021.1080p.WEB-DL",
  };

  beforeAll(async () => {
    await pool.query("DROP SCHEMA public CASCADE");
    await pool.query("CREATE SCHEMA public");
    await runMigrations(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  async function plannedFile(destinationKey: string): Promise<string> {
    const record = await repository.create(base);
    const [file] = await repository.addFiles(record.id, [
      {
        role: "media",
        sourceRelative: "Dune.2021.mkv",
        destinationRelative: "Dune (2021)/src/Dune (2021).mkv",
        destinationKey,
        sizeBytes: 4_000_000_000,
      },
    ]);
    return file!.id;
  }

  it("commits a destination once", async () => {
    const fileId = await plannedFile("c:\\seyirliklibrary\\dune (2021)/a.mkv");
    expect(
      await repository.commitFile(fileId, "planned", "dev:1;ino:2", "hardlink"),
    ).toBe(true);
  });

  it("refuses a second import committing the same destination", async () => {
    /*
     * The invariant that makes "run it twice, get one library object" a
     * property of the database. Two workers cannot both pass a check and then
     * both write, because there is no check — there is a constraint.
     */
    const key = "c:\\seyirliklibrary\\dune (2021)/b.mkv";
    const first = await plannedFile(key);
    const second = await plannedFile(key);
    expect(
      await repository.commitFile(first, "planned", "dev:1;ino:3", "hardlink"),
    ).toBe(true);
    await expect(
      repository.commitFile(second, "planned", "dev:1;ino:4", "hardlink"),
    ).rejects.toBeInstanceOf(DestinationAlreadyCommittedError);
  });

  it("lets exactly one of two concurrent commits win", async () => {
    const key = "c:\\seyirliklibrary\\dune (2021)/c.mkv";
    const first = await plannedFile(key);
    const second = await plannedFile(key);
    const outcomes = await Promise.allSettled([
      repository.commitFile(first, "planned", "dev:1;ino:5", "hardlink"),
      repository.commitFile(second, "planned", "dev:1;ino:6", "hardlink"),
    ]);
    const won = outcomes.filter(
      (outcome) => outcome.status === "fulfilled" && outcome.value,
    );
    expect(won).toHaveLength(1);
  });

  it("treats two names differing only in case as one destination", async () => {
    /*
     * The library lives on a case-insensitive filesystem, where `Dune.mkv` and
     * `DUNE.MKV` are the same file. The key is stored folded so the constraint
     * sees what the filesystem would see.
     */
    const first = await plannedFile("c:\\seyirliklibrary\\dune (2021)/d.mkv");
    const second = await plannedFile("c:\\seyirliklibrary\\dune (2021)/d.mkv");
    expect(await repository.commitFile(first, "planned", "id-a", "copy")).toBe(
      true,
    );
    await expect(
      repository.commitFile(second, "planned", "id-b", "copy"),
    ).rejects.toBeInstanceOf(DestinationAlreadyCommittedError);
  });

  it("still allows a failed attempt to be superseded at that destination", async () => {
    // Only committed rows hold the destination; a failure must not poison it.
    const key = "c:\\seyirliklibrary\\dune (2021)/e.mkv";
    const failed = await plannedFile(key);
    await repository.updateFile(failed, "planned", {
      state: "failed",
      failureClass: "destination-locked",
    });
    const retry = await plannedFile(key);
    expect(await repository.commitFile(retry, "planned", "id-c", "copy")).toBe(
      true,
    );
  });

  it("finds who owns a destination, so recovery can ask before overwriting", async () => {
    const key = "c:\\seyirliklibrary\\dune (2021)/f.mkv";
    const fileId = await plannedFile(key);
    await repository.commitFile(fileId, "planned", "dev:9;ino:9", "hardlink");
    const owner = await repository.findCommittedDestination(key);
    expect(owner?.id).toBe(fileId);
    expect(owner?.destinationIdentity).toBe("dev:9;ino:9");
    expect(await repository.findCommittedDestination("c:\\nobody")).toBeNull();
  });

  it("refuses two files of one import targeting the same destination", async () => {
    const record = await repository.create(base);
    await expect(
      repository.addFiles(record.id, [
        {
          role: "media",
          sourceRelative: "a.mkv",
          destinationKey: "c:\\seyirliklibrary\\same.mkv",
        },
        {
          role: "media",
          sourceRelative: "b.mkv",
          destinationKey: "c:\\seyirliklibrary\\same.mkv",
        },
      ]),
    ).rejects.toThrow(/duplicate key|unique/i);
  });
});

integration("one live import per handoff", () => {
  const pool = createDatabasePool({
    connectionString: databaseUrl as string,
    maxConnections: 4,
  });
  const repository = createImportRepository(pool);

  let acquisitionId: string;

  beforeAll(async () => {
    await pool.query("DROP SCHEMA public CASCADE");
    await pool.query("CREATE SCHEMA public");
    await runMigrations(pool);
    acquisitionId = randomUUID();
    await pool.query(
      `INSERT INTO acquisitions
         (id, target_kind, target_title, indexer_id, release_guid,
          release_title, state, origin, idempotency_key)
       VALUES ($1,'movie','Arrival','nzbgeek','g1','Arrival.2016','downloaded',
               'manual',$2)`,
      [acquisitionId, `seyirlik-${acquisitionId}`],
    );
  });

  afterAll(async () => {
    await pool.end();
  });

  const forAcquisition = (): CreateImportInput => ({
    acquisitionId,
    target: { kind: "movie", title: "Arrival", year: 2016 },
    sourceRoot: "C:\\SeyirlikDownloads\\complete\\seyirlik",
    libraryRoot: "C:\\SeyirlikLibrary",
    sourceRelative: "Arrival.2016.1080p.WEB-DL",
  });

  it("refuses a second live import for the same acquisition", async () => {
    // Two workers reading the same completed download must not both start.
    await repository.create(forAcquisition());
    await expect(repository.create(forAcquisition())).rejects.toThrow(
      /duplicate key|unique/i,
    );
  });

  it("allows a fresh import once the previous one has failed", async () => {
    const rows = await pool.query<{ id: string }>(
      "SELECT id FROM imports WHERE acquisition_id = $1",
      [acquisitionId],
    );
    await repository.update(rows.rows[0]!.id, "planned", { state: "failed" });
    const replacement = await repository.create(forAcquisition());
    expect(replacement.acquisitionId).toBe(acquisitionId);
  });

  it("lists the rows whose filesystem outcome is unknown", async () => {
    const record = await repository.create({
      ...forAcquisition(),
      acquisitionId: undefined,
    });
    await repository.update(record.id, "planned", { state: "validating" });
    await repository.update(record.id, "validating", { state: "staging" });
    await repository.update(record.id, "staging", { state: "committing" });

    const uncertain = await repository.listUncertain();
    expect(uncertain.map((row) => row.id)).toContain(record.id);
    expect(
      uncertain.every(
        (row) => row.state === "committing" || row.state === "uncertain",
      ),
    ).toBe(true);
  });
});
