import { describe, expect, it } from "vitest";
import {
  countedFailures,
  describeOverall,
  measurePercent,
  isConcluded,
  lifecycleOf,
  newerProgress,
  parseItemFailures,
  parseMaintenanceProgress,
  type MaintenanceProgress,
  type MaintenanceTaskDto,
} from "./maintenanceTasks";

/*
 * The rule under test throughout: a figure appears only when the executor
 * wrote it. Every case below that has no denominator asserts the *absence* of
 * a percentage, because a percentage nobody measured is the single failure
 * this whole surface exists to prevent.
 */

function progress(
  over: Partial<MaintenanceProgress> = {},
): MaintenanceProgress {
  return {
    revision: 1,
    phase: "reading",
    measure: { kind: "indeterminate" },
    at: "2026-09-06T10:00:00.000Z",
    ...over,
  };
}

describe("how much of a maintenance task is done", () => {
  it("turns a real fraction into a percentage", () => {
    const overall = describeOverall(
      progress({
        measure: { kind: "exact", completed: 37, total: 100, unit: "files" },
      }),
    );

    expect(overall).toEqual({
      kind: "exact",
      completed: 37,
      total: 100,
      unit: "files",
      provisionalTotal: false,
      percent: 37,
    });
  });

  it("rounds the figure, and holds it under a hundred until the count arrives", () => {
    // 199 of 356 frames: the reading that used to be published as 56 on the
    // page and 55 on the card at the same instant.
    expect(measurePercent(199, 356)).toBe(56);
    expect(measurePercent(178, 303)).toBe(59);
    // Rounding must never reach a hundred on work still running: the only
    // figure that says a job is over is the count reaching its own total.
    expect(measurePercent(999, 1_000)).toBe(99);
    expect(measurePercent(1_000, 1_000)).toBe(100);
    // Nothing to divide by is nothing known, not a hundred per cent.
    expect(measurePercent(3, 0)).toBe(0);
  });

  it("marks a denominator that is still moving as provisional", () => {
    const overall = describeOverall(
      progress({
        measure: {
          kind: "exact",
          completed: 183,
          total: 742,
          unit: "files",
          provisionalTotal: true,
        },
      }),
    );

    expect(overall).toMatchObject({ kind: "exact", provisionalTotal: true });
  });

  it("produces no percentage for a count with no denominator", () => {
    const overall = describeOverall(
      progress({ measure: { kind: "counter", counted: 4_281, unit: "files" } }),
    );

    expect(overall).toEqual({ kind: "counter", counted: 4_281, unit: "files" });
    expect(overall).not.toHaveProperty("percent");
  });

  it("produces no percentage when nothing is measurable", () => {
    expect(describeOverall(progress())).toEqual({ kind: "unknown" });
  });

  it("produces no percentage when there is no progress at all", () => {
    expect(describeOverall(null)).toEqual({ kind: "unknown" });
  });

  it("reports a phase position when the phase itself cannot be measured", () => {
    const overall = describeOverall(progress({ phaseIndex: 2, phaseCount: 5 }));

    expect(overall).toEqual({ kind: "phase", phaseIndex: 2, phaseCount: 5 });
    expect(overall).not.toHaveProperty("percent");
  });

  it("prefers the measured fraction over the phase position", () => {
    const overall = describeOverall(
      progress({
        phaseIndex: 2,
        phaseCount: 5,
        measure: { kind: "exact", completed: 1, total: 4, unit: "titles" },
      }),
    );

    expect(overall).toMatchObject({ kind: "exact", percent: 25 });
  });

  it("refuses to divide by a zero total", () => {
    const overall = describeOverall(
      progress({
        measure: { kind: "exact", completed: 0, total: 0, unit: "files" },
      }),
    );

    expect(overall).toEqual({ kind: "unknown" });
  });
});

describe("reading a stored progress document back", () => {
  it("keeps a well-formed snapshot", () => {
    expect(
      parseMaintenanceProgress({
        revision: 4,
        phase: "moving",
        measure: { kind: "exact", completed: 2, total: 9, unit: "moves" },
        counters: { moved: 2, movesFailed: 0 },
        current: { label: "Interstellar" },
        at: "2026-09-06T10:00:00.000Z",
      }),
    ).toMatchObject({
      revision: 4,
      phase: "moving",
      counters: { moved: 2, movesFailed: 0 },
      current: { label: "Interstellar" },
    });
  });

  it("rejects a phase it does not recognise", () => {
    expect(
      parseMaintenanceProgress({
        revision: 1,
        phase: "vibing",
        measure: { kind: "indeterminate" },
        at: "2026-09-06T10:00:00.000Z",
      }),
    ).toBeNull();
  });

  it("degrades a numerator past its denominator to a bare count", () => {
    const parsed = parseMaintenanceProgress({
      revision: 1,
      phase: "reading",
      measure: { kind: "exact", completed: 812, total: 742, unit: "files" },
      at: "2026-09-06T10:00:00.000Z",
    });

    expect(parsed?.measure).toEqual({
      kind: "counter",
      counted: 812,
      unit: "files",
    });
  });

  it("drops a phase position that is missing its other half", () => {
    const parsed = parseMaintenanceProgress({
      revision: 1,
      phase: "reading",
      phaseIndex: 3,
      measure: { kind: "indeterminate" },
      at: "2026-09-06T10:00:00.000Z",
    });

    expect(parsed).not.toHaveProperty("phaseIndex");
  });

  it("drops counters it has no word for", () => {
    const parsed = parseMaintenanceProgress({
      revision: 1,
      phase: "reading",
      measure: { kind: "indeterminate" },
      counters: { moved: 3, gremlins: 7 },
      at: "2026-09-06T10:00:00.000Z",
    });

    expect(parsed?.counters).toEqual({ moved: 3 });
  });

  it("refuses a document with no revision, which could not be ordered", () => {
    expect(
      parseMaintenanceProgress({
        phase: "reading",
        measure: { kind: "indeterminate" },
        at: "2026-09-06T10:00:00.000Z",
      }),
    ).toBeNull();
  });

  it("refuses anything that is not a document", () => {
    expect(parseMaintenanceProgress("73%")).toBeNull();
    expect(parseMaintenanceProgress(null)).toBeNull();
    expect(parseMaintenanceProgress([1, 2])).toBeNull();
  });
});

describe("ordering two snapshots of one attempt", () => {
  it("keeps the higher revision when an older one arrives late", () => {
    const held = progress({ revision: 40 });
    expect(newerProgress(held, progress({ revision: 31 }))).toBe(held);
  });

  it("takes the newer revision", () => {
    const arriving = progress({ revision: 41 });
    expect(newerProgress(progress({ revision: 40 }), arriving)).toBe(arriving);
  });

  it("keeps what it holds when a duplicate arrives", () => {
    const held = progress({ revision: 40 });
    expect(newerProgress(held, progress({ revision: 40 }))).toBe(held);
  });

  it("keeps what it holds when nothing arrives", () => {
    const held = progress({ revision: 2 });
    expect(newerProgress(held, null)).toBe(held);
  });
});

describe("what lifecycle a queue row is in", () => {
  const now = Date.parse("2026-09-06T10:00:00.000Z");
  const base: Pick<MaintenanceTaskDto, "status" | "attempts" | "runAfter"> = {
    status: "queued",
    attempts: 0,
    runAfter: "2026-09-06T09:59:00.000Z",
  };

  it("calls a claimable untried row queued", () => {
    expect(lifecycleOf(base, now)).toBe("queued");
  });

  it("calls an untried row with a future run time scheduled", () => {
    expect(
      lifecycleOf({ ...base, runAfter: "2026-09-06T10:05:00.000Z" }, now),
    ).toBe("scheduled");
  });

  it("calls a failed row inside its backoff a retry", () => {
    expect(
      lifecycleOf(
        { ...base, attempts: 2, runAfter: "2026-09-06T10:05:00.000Z" },
        now,
      ),
    ).toBe("retry-waiting");
  });

  it("calls a failed row past its backoff queued again", () => {
    expect(lifecycleOf({ ...base, attempts: 2 }, now)).toBe("queued");
  });

  it("passes through every status that is not queued", () => {
    for (const status of [
      "running",
      "succeeded",
      "failed",
      "cancelled",
    ] as const) {
      expect(lifecycleOf({ ...base, status }, now)).toBe(status);
    }
  });

  it("treats exactly the three terminal statuses as concluded", () => {
    expect(isConcluded({ status: "succeeded" })).toBe(true);
    expect(isConcluded({ status: "failed" })).toBe(true);
    expect(isConcluded({ status: "cancelled" })).toBe(true);
    expect(isConcluded({ status: "queued" })).toBe(false);
    expect(isConcluded({ status: "running" })).toBe(false);
  });
});

describe("failures kept beside the work that succeeded", () => {
  it("keeps entries whose phase and reason are both known", () => {
    expect(
      parseItemFailures([
        {
          phase: "moving",
          reason: "permission-denied",
          subject: { label: "Dune" },
        },
        { phase: "moving", reason: "who-knows" },
        { phase: "vibing", reason: "unknown" },
        "not a failure",
      ]),
    ).toEqual([
      {
        phase: "moving",
        reason: "permission-denied",
        subject: { label: "Dune" },
      },
    ]);
  });

  it("counts the failure counters and nothing else", () => {
    expect(
      countedFailures({ moved: 900, movesFailed: 3, renamesFailed: 1 }),
    ).toBe(4);
    expect(countedFailures({ moved: 900 })).toBe(0);
  });
});
