import { randomUUID } from "node:crypto";
import type { DatabasePool } from "../database/databasePool";

/**
 * Durable job queue backed by PostgreSQL.
 *
 * PostgreSQL is the only correctness-bearing store here on purpose: a lease
 * with an expiry means a worker that crashes mid-scan releases its job without
 * anyone noticing, and no broker has to be installed next to the media volume.
 */

export type JobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface JobRecord {
  id: string;
  jobType: string;
  payload: Record<string, unknown>;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  progress: number;
  progressMessage: string | null;
  safeError: string | null;
  result: Record<string, unknown> | null;
  cancellationRequested: boolean;
  queuedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

export interface EnqueueOptions {
  jobType: string;
  payload?: Record<string, unknown>;
  priority?: number;
  maxAttempts?: number;
  runAfter?: Date;
  /**
   * Collapses this job onto an existing queued/running job with the same key,
   * so repeatedly pressing "scan library" cannot flood the worker.
   */
  dedupeKey?: string;
}

export interface JobQueue {
  enqueue(options: EnqueueOptions): Promise<string>;
  claim(leaseOwner: string, leaseMs: number): Promise<JobRecord | null>;
  heartbeat(
    jobId: string,
    leaseOwner: string,
    leaseMs: number,
  ): Promise<boolean>;
  reportProgress(
    jobId: string,
    progress: number,
    message?: string,
  ): Promise<void>;
  complete(jobId: string, result?: Record<string, unknown>): Promise<void>;
  fail(jobId: string, safeError: string, retry: boolean): Promise<void>;
  requestCancellation(jobId: string): Promise<boolean>;
  isCancellationRequested(jobId: string): Promise<boolean>;
  get(jobId: string): Promise<JobRecord | null>;
  /**
   * The attempt of this type that is still executable, found by what it is
   * *for* rather than by an id somebody wrote down.
   *
   * A durable operation outlives its attempts — a processing job can be
   * queued, parked for storage, and queued again — so the id stored beside it
   * names the last attempt, not necessarily a live one. Asking the queue
   * "is anything still due to run for this?" is the only question whose answer
   * cannot be stale, and it is what stops a second attempt being created for
   * work that already has one.
   */
  findActive(options: {
    jobType: string;
    /** Payload fields the attempt must carry, matched by containment. */
    payload: Record<string, unknown>;
  }): Promise<JobRecord | null>;
  list(options: {
    jobType?: string;
    status?: JobStatus;
    limit: number;
  }): Promise<JobRecord[]>;
  /** Returns leases that expired so a crashed worker's jobs are retried. */
  reclaimExpiredLeases(): Promise<number>;
}

interface RawJobRow {
  id: string;
  job_type: string;
  payload: Record<string, unknown>;
  status: JobStatus;
  attempts: number;
  max_attempts: number;
  progress: number;
  progress_message: string | null;
  safe_error: string | null;
  result: Record<string, unknown> | null;
  cancellation_requested: boolean;
  queued_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

const JOB_COLUMNS = `
  id, job_type, payload, status, attempts, max_attempts, progress,
  progress_message, safe_error, result, cancellation_requested,
  queued_at, started_at, finished_at
`;

function toRecord(row: RawJobRow): JobRecord {
  return {
    id: row.id,
    jobType: row.job_type,
    payload: row.payload ?? {},
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    progress: row.progress,
    progressMessage: row.progress_message,
    safeError: row.safe_error,
    result: row.result,
    cancellationRequested: row.cancellation_requested,
    queuedAt: row.queued_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

/**
 * Rejects a payload value that cannot survive the round trip through JSONB.
 *
 * A payload is `Record<string, unknown>`, so the compiler accepts anything —
 * including a Promise from a forgotten `await`. `JSON.stringify` turns one into
 * `{}` without complaint, and the job then runs with the field simply *missing*,
 * taking whatever default the reader has. That is how a batch of episodes came
 * to publish into their season folder instead of their own: the destination was
 * an un-awaited `resolveTitleRoot`, so every job carried `titleRoot: {}` and
 * fell back to the directory beside the source, over its neighbours.
 *
 * The value that reaches the database must therefore be JSON that means what
 * the caller wrote. Anything else is a defect at the call site and is raised
 * there, before a row exists, rather than discovered as missing content later.
 */
function assertJsonPayload(
  payload: Record<string, unknown>,
  jobType: string,
): void {
  const describe = (value: unknown): string => {
    if (typeof value === "function") return "a function";
    if (typeof value === "bigint") return "a bigint";
    if (typeof value === "symbol") return "a symbol";
    if (typeof value === "object" && value !== null) {
      if (typeof (value as { then?: unknown }).then === "function") {
        return "a Promise (missing `await`?)";
      }
      return `a ${value.constructor?.name ?? "object"}`;
    }
    return `a ${typeof value}`;
  };

  const walk = (value: unknown, path: string, seen: Set<object>): void => {
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean"
    ) {
      return;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        throw new Error(
          `Job payload for "${jobType}" has a non-finite number at ${path}. ` +
            `JSON cannot carry it and the field would arrive as null.`,
        );
      }
      return;
    }
    if (typeof value !== "object") {
      throw new Error(
        `Job payload for "${jobType}" has ${describe(value)} at ${path}. ` +
          `Only JSON values survive the queue.`,
      );
    }
    /*
     * Plain objects and arrays only. A Date, a Buffer, a Map — and above all a
     * Promise — all stringify into something the reader will not recognise, so
     * the caller must convert deliberately rather than by accident.
     */
    const prototype = Object.getPrototypeOf(value);
    const isPlain =
      Array.isArray(value) ||
      prototype === Object.prototype ||
      prototype === null;
    if (!isPlain) {
      throw new Error(
        `Job payload for "${jobType}" has ${describe(value)} at ${path}. ` +
          `Only JSON values survive the queue.`,
      );
    }
    if (seen.has(value as object)) {
      throw new Error(`Job payload for "${jobType}" is circular at ${path}.`);
    }
    seen.add(value as object);
    for (const [key, child] of Object.entries(value as object)) {
      if (child === undefined) continue;
      walk(child, `${path}.${key}`, seen);
    }
    seen.delete(value as object);
  };

  walk(payload, "payload", new Set<object>());
}

export function createJobQueue(pool: DatabasePool): JobQueue {
  return {
    enqueue: async ({
      jobType,
      payload = {},
      priority = 100,
      maxAttempts = 3,
      runAfter,
      dedupeKey,
    }) => {
      assertJsonPayload(payload, jobType);
      const id = randomUUID();
      const result = await pool.query<{ id: string }>(
        `INSERT INTO jobs (id, job_type, payload, priority, max_attempts, run_after, dedupe_key)
         VALUES ($1, $2, $3, $4, $5, COALESCE($6, now()), $7)
         ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('queued', 'running')
         DO NOTHING
         RETURNING id`,
        [
          id,
          jobType,
          payload,
          priority,
          maxAttempts,
          runAfter ?? null,
          dedupeKey ?? null,
        ],
      );

      const inserted = result.rows[0]?.id;
      if (inserted) return inserted;

      // Collapsed onto an in-flight job; return that job's id so the caller can
      // still poll a real task.
      const existing = await pool.query<{ id: string }>(
        `SELECT id FROM jobs
         WHERE dedupe_key = $1 AND status IN ('queued', 'running')
         ORDER BY queued_at DESC LIMIT 1`,
        [dedupeKey],
      );
      const row = existing.rows[0];
      if (!row) throw new Error("Job enqueue returned no row.");
      return row.id;
    },

    claim: async (leaseOwner, leaseMs) => {
      // SKIP LOCKED lets several workers claim different jobs concurrently
      // without serialising on the queue head.
      const result = await pool.query<RawJobRow>(
        `UPDATE jobs SET
           status = 'running',
           attempts = attempts + 1,
           lease_owner = $1,
           lease_expires_at = now() + make_interval(secs => $2),
           started_at = COALESCE(started_at, now())
         WHERE id = (
           SELECT id FROM jobs
           WHERE status = 'queued' AND run_after <= now()
           ORDER BY priority, run_after, queued_at
           FOR UPDATE SKIP LOCKED
           LIMIT 1
         )
         RETURNING ${JOB_COLUMNS}`,
        [leaseOwner, Math.max(1, Math.round(leaseMs / 1_000))],
      );
      const row = result.rows[0];
      return row ? toRecord(row) : null;
    },

    heartbeat: async (jobId, leaseOwner, leaseMs) => {
      const result = await pool.query(
        `UPDATE jobs SET lease_expires_at = now() + make_interval(secs => $3)
         WHERE id = $1 AND lease_owner = $2 AND status = 'running'`,
        [jobId, leaseOwner, Math.max(1, Math.round(leaseMs / 1_000))],
      );
      return (result.rowCount ?? 0) > 0;
    },

    reportProgress: async (jobId, progress, message) => {
      await pool.query(
        `UPDATE jobs SET progress = $2, progress_message = $3
         WHERE id = $1 AND status = 'running'`,
        [
          jobId,
          Math.min(1, Math.max(0, progress)),
          message?.slice(0, 300) ?? null,
        ],
      );
    },

    complete: async (jobId, result) => {
      await pool.query(
        `UPDATE jobs SET
           status = 'succeeded', progress = 1, finished_at = now(),
           lease_owner = NULL, lease_expires_at = NULL, result = $2
         WHERE id = $1`,
        [jobId, result ?? null],
      );
    },

    fail: async (jobId, safeError, retry) => {
      await pool.query(
        `UPDATE jobs SET
           status = CASE
             WHEN $3 AND attempts < max_attempts THEN 'queued'
             ELSE 'failed' END,
           -- Exponential-ish backoff keeps a permanently broken file from
           -- spinning the worker.
           run_after = CASE
             WHEN $3 AND attempts < max_attempts
               THEN now() + make_interval(secs => least(300, power(2, attempts)::int * 15))
             ELSE run_after END,
           safe_error = $2,
           lease_owner = NULL,
           lease_expires_at = NULL,
           finished_at = CASE
             WHEN $3 AND attempts < max_attempts THEN NULL ELSE now() END
         WHERE id = $1`,
        [jobId, safeError.slice(0, 500), retry],
      );
    },

    requestCancellation: async (jobId) => {
      const result = await pool.query(
        `UPDATE jobs SET
           cancellation_requested = true,
           status = CASE WHEN status = 'queued' THEN 'cancelled' ELSE status END,
           finished_at = CASE WHEN status = 'queued' THEN now() ELSE finished_at END
         WHERE id = $1 AND status IN ('queued', 'running')`,
        [jobId],
      );
      return (result.rowCount ?? 0) > 0;
    },

    isCancellationRequested: async (jobId) => {
      const result = await pool.query<{ cancellation_requested: boolean }>(
        `SELECT cancellation_requested FROM jobs WHERE id = $1`,
        [jobId],
      );
      return result.rows[0]?.cancellation_requested === true;
    },

    get: async (jobId) => {
      const result = await pool.query<RawJobRow>(
        `SELECT ${JOB_COLUMNS} FROM jobs WHERE id = $1`,
        [jobId],
      );
      const row = result.rows[0];
      return row ? toRecord(row) : null;
    },

    findActive: async ({ jobType, payload }) => {
      /*
       * `queued` and `running` are exactly the statuses from which work can
       * still happen, and they are the same two the dedupe index is built on,
       * so this answer and the collapse an `enqueue` performs cannot disagree.
       * The newest is returned because that is the one an `enqueue` would have
       * collapsed onto.
       */
      const result = await pool.query<RawJobRow>(
        `SELECT ${JOB_COLUMNS} FROM jobs
         WHERE job_type = $1 AND status IN ('queued', 'running')
           AND payload @> $2::jsonb
         ORDER BY queued_at DESC
         LIMIT 1`,
        [jobType, JSON.stringify(payload)],
      );
      const row = result.rows[0];
      return row ? toRecord(row) : null;
    },

    list: async ({ jobType, status, limit }) => {
      const values: unknown[] = [limit];
      const conditions: string[] = [];
      if (jobType) {
        values.push(jobType);
        conditions.push(`job_type = $${values.length}`);
      }
      if (status) {
        values.push(status);
        conditions.push(`status = $${values.length}`);
      }

      const result = await pool.query<RawJobRow>(
        `SELECT ${JOB_COLUMNS} FROM jobs
         ${conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""}
         ORDER BY queued_at DESC
         LIMIT $1`,
        values,
      );
      return result.rows.map(toRecord);
    },

    reclaimExpiredLeases: async () => {
      const result = await pool.query(
        `UPDATE jobs SET
           status = CASE WHEN attempts < max_attempts THEN 'queued' ELSE 'failed' END,
           safe_error = CASE
             WHEN attempts < max_attempts THEN safe_error
             ELSE 'The job did not complete before its lease expired.' END,
           lease_owner = NULL,
           lease_expires_at = NULL,
           finished_at = CASE
             WHEN attempts < max_attempts THEN NULL
             ELSE now()
           END
         WHERE status = 'running' AND lease_expires_at < now()`,
      );
      return result.rowCount ?? 0;
    },
  };
}
