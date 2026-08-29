// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import {
  createProcessingJobStore,
  DuplicateProcessingJobError,
} from "./jobStore";

/**
 * Exercises the parts of the job model that only PostgreSQL can prove: the
 * unique active-job index, the monotonic progress guard, and per-job event
 * sequencing.
 *
 * Skipped when no lab database is configured, so the suite still runs on a
 * machine that has never set one up.
 */

const connectionString = process.env.SEYIRLIK_LAB_DATABASE_URL;
const describeIfDatabase = connectionString ? describe : describe.skip;

describeIfDatabase("processing job store", () => {
  let pool: Pool;
  let store: ReturnType<typeof createProcessingJobStore>;
  let itemId = "";
  let fileId = "";
  const created: string[] = [];

  beforeAll(async () => {
    pool = new Pool({ connectionString, max: 2 });
    store = createProcessingJobStore({
      query: (text: string, values?: unknown[]) =>
        pool.query(text, values as never),
    } as never);
    const { rows } = await pool.query<{ item_id: string; file_id: string }>(
      `SELECT i.id AS item_id, mf.id AS file_id
         FROM items i JOIN media_files mf ON mf.item_id = i.id LIMIT 1`,
    );
    itemId = rows[0]?.item_id ?? "";
    fileId = rows[0]?.file_id ?? "";
  });

  afterAll(async () => {
    if (created.length > 0) {
      await pool.query(
        `DELETE FROM processing_jobs WHERE id = ANY($1::uuid[])`,
        [created],
      );
    }
    await pool.end();
  });

  beforeEach(async () => {
    // Each test owns the file outright; a leftover active job from the previous
    // one would make the duplicate guard fire in the wrong place.
    if (fileId) {
      await pool.query(`DELETE FROM processing_jobs WHERE media_file_id = $1`, [
        fileId,
      ]);
    }
  });

  const make = async () => {
    const job = await store.create({
      itemId,
      mediaFileId: fileId,
      sourceFingerprint: "a".repeat(64),
      profile: "test-profile",
    });
    created.push(job.id);
    return job;
  };

  it("creates a job in the pending state", async () => {
    if (!itemId) return;
    const job = await make();

    expect(job.state).toBe("pending");
    expect(job.stage).toBe("waiting");
    expect(job.overallProgress).toBe(0);
  });

  /**
   * Two workers must never process the same source, and an operator pressing
   * the button twice must not queue it twice.
   */
  it("refuses a second active job for the same file", async () => {
    if (!itemId) return;
    await make();

    await expect(make()).rejects.toBeInstanceOf(DuplicateProcessingJobError);
  });

  it("allows a new job once the previous one finished", async () => {
    if (!itemId) return;
    const first = await make();
    await store.update(first.id, {
      state: "succeeded",
      finishedAt: new Date(),
    });

    const second = await make();
    expect(second.id).not.toBe(first.id);
  });

  it("never lets stored progress move backwards", async () => {
    if (!itemId) return;
    const job = await make();
    await store.update(job.id, { overallProgress: 0.7 });
    const lowered = await store.update(job.id, { overallProgress: 0.2 });

    expect(lowered?.overallProgress).toBeCloseTo(0.7, 5);
  });

  it("numbers events per job so a reconnect can resume from one", async () => {
    if (!itemId) return;
    const job = await make();
    const first = await store.appendEvent({
      processingJobId: job.id,
      stage: "analysing",
      message: "one",
    });
    const second = await store.appendEvent({
      processingJobId: job.id,
      stage: "planning",
      message: "two",
    });

    expect(second.sequence).toBe(first.sequence + 1);
    const after = await store.listEvents(job.id, first.sequence);
    expect(after.map((entry) => entry.message)).toEqual(["two"]);
  });

  it("marks a job for cancellation only while it is still active", async () => {
    if (!itemId) return;
    const job = await make();

    expect(await store.requestCancellation(job.id)).toBe(true);
    await store.update(job.id, { state: "cancelled", finishedAt: new Date() });
    expect(await store.requestCancellation(job.id)).toBe(false);
  });
});
