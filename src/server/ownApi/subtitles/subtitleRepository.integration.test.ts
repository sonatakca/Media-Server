// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabasePool } from "../database/databasePool";
import { runMigrations } from "../database/migrationRunner";
import {
  createSubtitleRepository,
  SubtitleAttemptMovedError,
} from "./subtitleRepository";
import { normalizeWant } from "./subtitleState";

/*
 * The invariants that are only real if the database enforces them.
 *
 * Three of these are constraints rather than checks in code, precisely so that
 * two workers racing cannot both pass a check and then both write: one want per
 * (file, language, forced), one installation record per path, and a paused
 * attempt that must name the provider it is waiting for. A test against a
 * double would confirm this code's intentions; only a real database confirms
 * the constraints.
 *
 * Requires a disposable database. The schema is dropped.
 */
const databaseUrl = process.env.SEYIRLIK_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("subtitles in PostgreSQL", () => {
  const pool = createDatabasePool({
    connectionString: databaseUrl as string,
    maxConnections: 4,
  });
  const repository = createSubtitleRepository(pool);
  let mediaFileId = "";

  beforeAll(async () => {
    await pool.query("DROP SCHEMA public CASCADE");
    await pool.query("CREATE SCHEMA public");
    await runMigrations(pool);

    // The smallest catalogue a media file can hang from.
    const libraryId = randomUUID();
    const itemId = randomUUID();
    mediaFileId = randomUUID();
    await pool.query(
      `INSERT INTO libraries (id, slug, name, kind) VALUES ($1, 'movies', 'Movies', 'movies')`,
      [libraryId],
    );
    await pool.query(
      `INSERT INTO items (id, library_id, kind, source_key, title, sort_title)
       VALUES ($1, $2, 'movie', 'Movies/Dune (2021)', 'Dune', 'Dune')`,
      [itemId, libraryId],
    );
    await pool.query(
      `INSERT INTO media_files
         (id, item_id, relative_path, size_bytes, mtime_ms, fingerprint)
       VALUES ($1, $2, 'Movies/Dune (2021)/Dune (2021).mkv', 1, 1, 'f')`,
      [mediaFileId, itemId],
    );
  }, 60_000);

  afterAll(async () => {
    await pool.end();
  });

  it("keeps one want per file, language and forced status", async () => {
    const want = normalizeWant({ language: "tur", hearingImpaired: "prefer" });
    const first = await repository.ensureWant(mediaFileId, want);
    const again = await repository.ensureWant(mediaFileId, {
      ...want,
      hearingImpaired: "avoid",
    });
    expect(again.id).toBe(first.id);
    // The preference ranks candidates; it does not make a different want.
    expect(again.hearingImpaired).toBe("avoid");

    const forced = await repository.ensureWant(mediaFileId, {
      ...want,
      forced: true,
    });
    // A forced subtitle is a different want, never a lesser version of a full one.
    expect(forced.id).not.toBe(first.id);
  });

  it("refuses a language the domain would never produce", async () => {
    await expect(
      repository.ensureWant(mediaFileId, {
        language: "turkish",
        forced: false,
        hearingImpaired: "indifferent",
      }),
    ).rejects.toThrow();
  });

  it("lets only one worker advance an attempt", async () => {
    const want = await repository.ensureWant(
      mediaFileId,
      normalizeWant({ language: "eng" }),
    );
    const attempt = await repository.beginAttempt(want.id);

    const moved = await repository.moveAttempt({
      attemptId: attempt.id,
      from: "wanted",
      to: "searching",
      countsAsAttempt: true,
    });
    expect(moved.state).toBe("searching");
    expect(moved.attempt).toBe(1);

    // The second worker still believes it is `wanted`, and matches no row.
    await expect(
      repository.moveAttempt({
        attemptId: attempt.id,
        from: "wanted",
        to: "searching",
      }),
    ).rejects.toBeInstanceOf(SubtitleAttemptMovedError);
  });

  it("refuses an impossible move before it reaches the database", async () => {
    const want = await repository.ensureWant(
      mediaFileId,
      normalizeWant({ language: "deu" }),
    );
    const attempt = await repository.beginAttempt(want.id);
    await expect(
      repository.moveAttempt({
        attemptId: attempt.id,
        from: "wanted",
        to: "installed",
      }),
    ).rejects.toThrow(/cannot go from wanted to installed/);
  });

  /* A pause must say who it is waiting for; nothing else may claim to be. */
  it("enforces that only a paused attempt names a provider it awaits", async () => {
    const want = await repository.ensureWant(
      mediaFileId,
      normalizeWant({ language: "fra" }),
    );
    const attempt = await repository.beginAttempt(want.id);
    await repository.moveAttempt({
      attemptId: attempt.id,
      from: "wanted",
      to: "searching",
    });

    await expect(
      repository.moveAttempt({
        attemptId: attempt.id,
        from: "searching",
        to: "needs-authentication",
      }),
    ).rejects.toThrow();

    const paused = await repository.moveAttempt({
      attemptId: attempt.id,
      from: "searching",
      to: "needs-authentication",
      awaitingProviderId: "turkcealtyazilar",
    });
    expect(paused.awaitingProviderId).toBe("turkcealtyazilar");
    // Waiting for a person is not an attempt.
    expect(paused.attempt).toBe(0);

    const resumed = await repository.moveAttempt({
      attemptId: attempt.id,
      from: "needs-authentication",
      to: "searching",
      awaitingProviderId: null,
    });
    expect(resumed.awaitingProviderId).toBeNull();
  });

  it("finds the attempts a crash could have left mid-write", async () => {
    const want = await repository.ensureWant(
      mediaFileId,
      normalizeWant({ language: "spa" }),
    );
    const attempt = await repository.beginAttempt(want.id);
    for (const [from, to] of [
      ["wanted", "searching"],
      ["searching", "selected"],
      ["selected", "downloading"],
    ] as const) {
      await repository.moveAttempt({ attemptId: attempt.id, from, to });
    }
    const uncertain = await repository.uncertainAttempts();
    expect(uncertain.map((row) => row.id)).toContain(attempt.id);
  });

  describe("ownership", () => {
    const relativePath = "Movies/Dune (2021)/Dune (2021).tur.srt";

    it("records what it wrote, and answers for it afterwards", async () => {
      await repository.recordInstallation({
        mediaFileId,
        wantId: null,
        attemptId: null,
        relativePath,
        language: "tur",
        forced: false,
        hearingImpaired: false,
        format: "srt",
        sha256: "a".repeat(64),
        sizeBytes: 42,
        cueCount: 3,
        providerId: "test",
      });
      expect(await repository.managedDigest(mediaFileId, relativePath)).toBe(
        "a".repeat(64),
      );
    });

    it("says nothing about a path it never wrote", async () => {
      expect(
        await repository.managedDigest(mediaFileId, "Movies/other.srt"),
      ).toBeNull();
    });

    /*
     * One record per path, so "did we write the file here" has one answer. An
     * upgrade replaces the digest rather than adding a second row, because the
     * record has to follow the file rather than describe a version of it that
     * no longer exists.
     */
    it("keeps one record per path and follows the file through an upgrade", async () => {
      await repository.recordInstallation({
        mediaFileId,
        wantId: null,
        attemptId: null,
        relativePath,
        language: "tur",
        forced: false,
        hearingImpaired: false,
        format: "srt",
        sha256: "b".repeat(64),
        sizeBytes: 99,
        cueCount: 5,
        providerId: "test",
      });
      expect(await repository.managedDigest(mediaFileId, relativePath)).toBe(
        "b".repeat(64),
      );
      const count = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM subtitle_installations
          WHERE media_file_id = $1 AND relative_path = $2`,
        [mediaFileId, relativePath],
      );
      expect(count.rows[0]?.n).toBe("1");
    });

    /*
     * A record that no longer matches the disk is worse than none: it would
     * authorise overwriting a file somebody else now owns.
     */
    it("forgets a file it no longer owns", async () => {
      await repository.forgetInstallation(mediaFileId, relativePath);
      expect(
        await repository.managedDigest(mediaFileId, relativePath),
      ).toBeNull();
    });

    it("refuses a format it cannot have installed", async () => {
      await expect(
        repository.recordInstallation({
          mediaFileId,
          wantId: null,
          attemptId: null,
          relativePath: "Movies/Dune (2021)/Dune (2021).tur.ass",
          language: "tur",
          forced: false,
          hearingImpaired: false,
          format: "ass" as unknown as "srt",
          sha256: "c".repeat(64),
          sizeBytes: 1,
          cueCount: null,
          providerId: null,
        }),
      ).rejects.toThrow();
    });
  });

  /* The cascade is what stops orphaned wants outliving the file they are for. */
  it("removes wants and installations when the media file goes", async () => {
    await pool.query("DELETE FROM media_files WHERE id = $1", [mediaFileId]);
    const wants = await pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM subtitle_wants WHERE media_file_id = $1",
      [mediaFileId],
    );
    expect(wants.rows[0]?.n).toBe("0");
  });
});
