import { describe, expect, it, vi } from "vitest";
import type { DatabasePool } from "../database/databasePool";
import { createJobQueue } from "./jobQueue";

/**
 * The queue's write paths, at the point where an out-of-order writer would do
 * damage.
 *
 * All three claims here are properties of the SQL rather than of a caller, and
 * that is the point: a guard a caller has to remember is a guard that is
 * eventually forgotten, and the failures it prevents — a job that is running
 * again reported as finished, a counter walking backwards — are invisible
 * until somebody is reading the page during an incident.
 */

function poolThatRecords() {
  const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
  return { pool: { query } as unknown as DatabasePool, query };
}

/** The statement of the call that matches, with its parameters. */
function statement(query: ReturnType<typeof vi.fn>, matching: RegExp) {
  const call = query.mock.calls.find(([sql]) =>
    matching.test(String(sql).replace(/\s+/g, " ")),
  );
  if (!call) throw new Error(`no statement matching ${matching}`);
  return {
    sql: String(call[0]).replace(/\s+/g, " "),
    values: call[1] as unknown[],
  };
}

describe("concluding an attempt", () => {
  it("lets only the worker still holding the lease record success", async () => {
    const { pool, query } = poolThatRecords();
    await createJobQueue(pool).complete("job", "worker-a", { moved: 3 });

    const { sql, values } = statement(query, /status = 'succeeded'/);
    expect(sql).toContain("status = 'running'");
    expect(sql).toContain("lease_owner = $2");
    expect(values).toEqual(["job", "worker-a", { moved: 3 }]);
  });

  it("lets only that worker record a failure, and keeps the phase it died in", async () => {
    const { pool, query } = poolThatRecords();
    await createJobQueue(pool).fail("job", "worker-a", "It broke.", true);

    const { sql, values } = statement(query, /safe_error = \$3/);
    expect(sql).toContain("status = 'running'");
    expect(sql).toContain("lease_owner = $2");
    // The structured snapshot is deliberately not cleared on a failure.
    expect(sql).not.toContain("progress_detail = NULL");
    expect(values.slice(0, 2)).toEqual(["job", "worker-a"]);
  });

  it("records being told to stop as its own thing, not as success", async () => {
    const { pool, query } = poolThatRecords();
    await createJobQueue(pool).concludeCancelled("job", "worker-a");

    const { sql } = statement(query, /status = 'cancelled'/);
    expect(sql).toContain("status = 'running'");
    expect(sql).toContain("lease_owner = $2");
  });
});

describe("a fresh attempt", () => {
  it("starts with no story carried over from the last one", async () => {
    const { pool, query } = poolThatRecords();
    await createJobQueue(pool).claim("worker-a", 60_000);

    const { sql } = statement(query, /status = 'running'/);
    expect(sql).toContain("progress_detail = NULL");
    expect(sql).toContain("FOR UPDATE SKIP LOCKED");
  });
});

describe("reporting structured progress", () => {
  it("stores a snapshot only when its revision exceeds the stored one", async () => {
    const { pool, query } = poolThatRecords();
    await createJobQueue(pool).reportProgress("job", 0.5, "Reading", {
      revision: 7,
      phase: "reading",
      measure: { kind: "counter", counted: 12, unit: "files" },
      at: "2026-09-06T10:00:00.000Z",
    });

    const { sql, values } = statement(query, /progress_detail = CASE/);
    expect(sql).toContain("(progress_detail ->> 'revision')::int");
    expect(sql).toContain("< ($4::jsonb ->> 'revision')::int");
    expect(sql).toContain("status = 'running'");
    expect(JSON.parse(String(values[3]))).toMatchObject({ revision: 7 });
  });

  it("leaves the stored snapshot alone when a handler reports no structure", async () => {
    const { pool, query } = poolThatRecords();
    await createJobQueue(pool).reportProgress("job", 0.5, "Reading");

    const { sql, values } = statement(query, /progress_detail = CASE/);
    expect(sql).toContain("WHEN $4::jsonb IS NULL THEN progress_detail");
    expect(values[3]).toBeNull();
  });
});

describe("rewriting the waiting line", () => {
  it("refuses in the statement, so a claimed or concluded row cannot move", async () => {
    const { pool, query } = poolThatRecords();
    await createJobQueue(pool).reorderQueue(["a", "b"], {
      excludeJobTypes: ["media.process"],
    });

    const { sql, values } = statement(query, /UPDATE jobs SET priority/);
    expect(sql).toContain("jobs.status = 'queued'");
    expect(sql).toContain("job_type <> ALL");
    expect(sql).toContain("RETURNING jobs.id");
    expect(values).toEqual(["a", 0, "b", 1, ["media.process"]]);
  });

  it("rebases on the priority the named rows already hold", async () => {
    const { pool, query } = poolThatRecords();
    await createJobQueue(pool).reorderQueue(["a", "b"]);

    const { sql } = statement(query, /UPDATE jobs SET priority/);
    // Not a constant base: these rows carry priorities that mean something,
    // and rewriting onto a fixed one would promote the whole set past jobs
    // nobody dragged.
    expect(sql).toContain("MIN(jobs.priority)");
    expect(sql).toContain("base.priority + ordering.slot");
  });

  it("does nothing at all for an empty order", async () => {
    const { pool, query } = poolThatRecords();
    expect(await createJobQueue(pool).reorderQueue([])).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });
});

describe("listing the maintenance lane", () => {
  it("orders the waiting rows by the expression the claim itself uses", async () => {
    const { pool, query } = poolThatRecords();
    await createJobQueue(pool).listActive({
      excludeJobTypes: ["media.process"],
      limit: 200,
    });

    const { sql, values } = statement(
      query,
      /status IN \('queued', 'running'\)/,
    );
    // Running first because it is happening; everything else in claim order,
    // so a position on the page predicts what the worker will do next.
    expect(sql).toContain(
      "ORDER BY (status = 'running') DESC, priority, run_after, queued_at",
    );
    // The offset rides along as the third value; the first page is zero.
    expect(values).toEqual([200, ["media.process"], 0]);
  });

  it("pages a later screenful without changing the claim order", async () => {
    const { pool, query } = poolThatRecords();
    await createJobQueue(pool).listActive({
      excludeJobTypes: ["media.process"],
      limit: 200,
      offset: 400,
    });

    const { sql, values } = statement(
      query,
      /status IN \('queued', 'running'\)/,
    );
    expect(sql).toContain(
      "ORDER BY (status = 'running') DESC, priority, run_after, queued_at",
    );
    expect(values).toEqual([200, ["media.process"], 400]);
  });

  it("lists concluded rows most recently finished first", async () => {
    const { pool, query } = poolThatRecords();
    await createJobQueue(pool).listConcluded({ limit: 50 });

    const { sql } = statement(
      query,
      /status IN \('succeeded', 'failed', 'cancelled'\)/,
    );
    expect(sql).toContain("ORDER BY COALESCE(finished_at, queued_at) DESC");
  });

  /*
   * Both figures from one statement, because two counts read a moment apart
   * are two moments, and a page that adds them up would be describing a queue
   * that never existed.
   */
  it("counts both tabs in a single statement", async () => {
    const { pool, query } = poolThatRecords();
    await createJobQueue(pool).countTasks({
      excludeJobTypes: ["media.process"],
    });

    expect(query).toHaveBeenCalledOnce();
    const { sql, values } = statement(query, /count\(\*\) FILTER/);
    expect(sql).toContain("FILTER (WHERE status IN ('queued', 'running'))");
    expect(sql).toContain("'succeeded', 'failed', 'cancelled'");
    expect(values).toEqual([["media.process"]]);
  });
});

it("reads active plus interval completions with stable bounded pagination and intersected filters", async () => {
  const { pool, query } = poolThatRecords();
  const since = "2026-09-06T10:00:00.000Z";
  const afterId = "00000000-0000-4000-8000-000000000001";
  await createJobQueue(pool).list({
    observe: true,
    since,
    afterId,
    status: "succeeded",
    jobType: "library.rename",
    limit: 200,
  });
  const { sql, values } = statement(query, /SELECT/);
  expect(sql).toContain(
    "status IN ('queued', 'running') OR COALESCE(finished_at, started_at, queued_at) >= $2::timestamptz",
  );
  expect(sql).toContain("id > $3::uuid");
  expect(sql).toContain("job_type = $4 AND status = $5");
  expect(sql).toContain("ORDER BY id ASC LIMIT $1");
  expect(values).toEqual([200, since, afterId, "library.rename", "succeeded"]);
});
