// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { createStorageIncidentStore } from "./storageIncidentStore";
import type { StorageHealthRecord } from "../../../renditions/processing/storageHealth";

/**
 * Exercises the incident row against a real PostgreSQL, because the defect this
 * file guards against was invisible to every other kind of test.
 *
 * The store's callers treat a failed write as survivable — a database that
 * cannot record a quarantine must not be able to undo one — so `save` logs and
 * swallows. That is right for the direction it was written for, and it is what
 * hid a statement that could never run at all: an UPDATE whose $17 appeared
 * first inside an IS NOT NULL test, which PostgreSQL refuses to parse without a
 * type. Every unit test passed, because every unit test used a fake store.
 *
 * What it cost in production: the row froze on the state it was created with.
 * An operator cleared the volume, the process that served the request updated
 * its own memory and reported success, and the worker — a separate process
 * restoring health from this row — went on holding the job and re-pausing it
 * the moment the operator resumed it.
 *
 * Skipped when no lab database is configured, so the suite still runs on a
 * machine that has never set one up.
 */

const connectionString = process.env.SEYIRLIK_LAB_DATABASE_URL;
const describeIfDatabase = connectionString ? describe : describe.skip;

describeIfDatabase("storage incident store", () => {
  let pool: Pool;
  let store: ReturnType<typeof createStorageIncidentStore>;
  const roots: string[] = [];
  /*
   * acknowledged_by carries a foreign key to native_users, so the operator has
   * to be one that exists. Read rather than invented, the same way this file's
   * neighbour reads a real item to hang a job off.
   */
  let operatorId = "";

  const rootFor = (name: string) => {
    const root = `/tmp/seyirlik-incident-test/${name}-${randomUUID()}`;
    roots.push(root);
    return root;
  };

  const health = (
    root: string,
    state: StorageHealthRecord["state"],
    overrides: Partial<StorageHealthRecord> = {},
  ): StorageHealthRecord => ({
    root,
    state,
    reason: `${state} for the test.`,
    faultCount: 0,
    firstFaultAtMs: null,
    lastFaultAtMs: null,
    changedAtMs: Date.now(),
    verifiedAtMs: null,
    missingRoots: [],
    clearedAtMs: null,
    ...overrides,
  });

  beforeAll(async () => {
    pool = new Pool({ connectionString, max: 2 });
    store = createStorageIncidentStore({
      query: (text: string, values?: unknown[]) =>
        pool.query(text, values as never),
    } as never);
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM native_users LIMIT 1`,
    );
    operatorId = rows[0]?.id ?? "";
  });

  afterAll(async () => {
    if (roots.length > 0) {
      await pool.query(
        `DELETE FROM storage_incidents WHERE storage_root = ANY($1::text[])`,
        [roots],
      );
    }
    await pool.end();
  });

  it("updates an incident that is already open", async () => {
    const root = rootFor("update");
    await store.save(health(root, "quarantined"), {});
    const opened = await store.findOpen(root);
    expect(opened?.state).toBe("quarantined");

    /*
     * The write that used to throw. No adoption, so the parameter behind the
     * identity CASE arms is null — which is exactly the shape PostgreSQL could
     * not assign a type to.
     */
    await store.save(
      health(root, "recovery-pending", { verifiedAtMs: Date.now() }),
      {},
    );

    const updated = await store.findOpen(root);
    expect(updated?.state).toBe("recovery-pending");
    expect(updated?.verifiedAtMs).not.toBeNull();
    expect(updated?.id).toBe(opened?.id);
  });

  it("closes the incident when the state reaches healthy", async () => {
    const root = rootFor("clear");
    await store.save(health(root, "recovery-pending"), {});
    expect(await store.findOpen(root)).not.toBeNull();

    const clearedAtMs = Date.now();
    await store.save(health(root, "healthy", { clearedAtMs }), {
      ...(operatorId ? { acknowledgedBy: operatorId } : {}),
    });

    /*
     * The property the worker depends on: once an operator has cleared a root,
     * a different process reading this row must not find anything holding it.
     */
    expect(await store.findOpen(root)).toBeNull();
  });

  it("records who acknowledged it", async () => {
    if (!operatorId) return; // No provisioned user on this database.
    const root = rootFor("ack");
    await store.save(health(root, "quarantined"), {});
    await store.save(health(root, "recovery-pending"), {
      acknowledgedBy: operatorId,
    });

    const { rows } = await pool.query<{ acknowledged_by: string | null }>(
      `SELECT acknowledged_by FROM storage_incidents WHERE storage_root = $1`,
      [root],
    );
    expect(rows[0]?.acknowledged_by).toBe(operatorId);
  });
});
