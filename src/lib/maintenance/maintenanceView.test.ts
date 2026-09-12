import { describe, expect, it } from "vitest";
import type { MaintenanceTaskDto } from "./maintenanceTasks";
import {
  applyOrderOverride,
  canReorderTask,
  elapsedSeconds,
  mergeSnapshot,
  moveBlock,
  moveItem,
  partitionMaintenanceTasks,
  queueWaitSeconds,
  runSiblings,
  sinceProgressSeconds,
} from "./maintenanceView";

function task(
  over: Partial<MaintenanceTaskDto> & { id: string },
): MaintenanceTaskDto {
  return {
    operation: "library.scan",
    status: "queued",
    reorderable: true,
    attempts: 0,
    maxAttempts: 3,
    progress: null,
    result: null,
    errorCode: null,
    queuedAt: "2026-09-06T10:00:00.000Z",
    runAfter: "2026-09-06T10:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    progressAt: null,
    ...over,
  };
}

describe("which half of the viewer a task belongs in", () => {
  it("puts the three terminal statuses in the history and the rest in progress", () => {
    const { active, concluded } = partitionMaintenanceTasks([
      task({ id: "a", status: "running" }),
      task({ id: "b", status: "queued" }),
      task({ id: "c", status: "succeeded" }),
      task({ id: "d", status: "failed" }),
      task({ id: "e", status: "cancelled" }),
    ]);

    expect(active.map((t) => t.id)).toEqual(["a", "b"]);
    expect(concluded.map((t) => t.id)).toEqual(["c", "d", "e"]);
  });

  it("keeps a row awaiting a retry in progress, because it will run again", () => {
    const { active } = partitionMaintenanceTasks([
      task({ id: "a", status: "queued", attempts: 2 }),
    ]);

    expect(active).toHaveLength(1);
  });

  it("takes reorder legality from the server rather than re-deriving it", () => {
    expect(canReorderTask({ reorderable: true })).toBe(true);
    expect(canReorderTask({ reorderable: false })).toBe(false);
  });
});

describe("the operator's arrangement over the server's", () => {
  const rows = [
    task({ id: "running", status: "running", reorderable: false }),
    task({ id: "a" }),
    task({ id: "b" }),
    task({ id: "c" }),
  ];

  it("rearranges only the rows the override names", () => {
    const applied = applyOrderOverride(rows, ["c", "a", "b"]);
    expect(applied.map((row) => row.id)).toEqual(["running", "c", "a", "b"]);
  });

  it("never sinks a row the override does not name", () => {
    const applied = applyOrderOverride(rows, ["b", "a"]);
    // "running" keeps the top slot; "c" keeps the slot it already had.
    expect(applied.map((row) => row.id)).toEqual(["running", "b", "a", "c"]);
  });

  it("is the server's order when there is no override", () => {
    expect(applyOrderOverride(rows, null).map((r) => r.id)).toEqual([
      "running",
      "a",
      "b",
      "c",
    ]);
  });
});

describe("moving one row", () => {
  const ids = ["a", "b", "c", "d"];

  it("moves the first to the last", () => {
    expect(moveItem(ids, 0, 3)).toEqual(["b", "c", "d", "a"]);
  });

  it("moves the last to the first", () => {
    expect(moveItem(ids, 3, 0)).toEqual(["d", "a", "b", "c"]);
  });

  it("inserts into the middle", () => {
    expect(moveItem(ids, 0, 2)).toEqual(["b", "c", "a", "d"]);
  });

  it("swaps two neighbours", () => {
    expect(moveItem(ids, 1, 2)).toEqual(["a", "c", "b", "d"]);
  });

  it("changes nothing when the target is where the row already is", () => {
    expect(moveItem(ids, 2, 2)).toEqual(ids);
  });

  it("changes nothing when asked to move past the ends", () => {
    expect(moveItem(ids, 0, -4)).toEqual(ids);
    expect(moveItem(ids, 3, 9)).toEqual(ids);
    expect(moveItem(ids, 9, 0)).toEqual(ids);
  });
});

describe("moving a selected block", () => {
  const ids = ["a", "b", "c", "d", "e"];

  it("takes the block to the front as one contiguous run", () => {
    expect(moveBlock(ids, ["b", "d"], "front")).toEqual([
      "b",
      "d",
      "a",
      "c",
      "e",
    ]);
  });

  it("takes the block to the back as one contiguous run", () => {
    expect(moveBlock(ids, ["b", "d"], "back")).toEqual([
      "a",
      "c",
      "e",
      "b",
      "d",
    ]);
  });

  it("keeps the block in queue order however the selection was made", () => {
    expect(moveBlock(ids, ["d", "b"], "front")).toEqual([
      "b",
      "d",
      "a",
      "c",
      "e",
    ]);
  });

  it("changes nothing when nothing in the block is in the queue", () => {
    expect(moveBlock(ids, ["z"], "front")).toEqual(ids);
  });
});

describe("merging an arriving snapshot onto the one on screen", () => {
  const at = (revision: number) => ({
    revision,
    phase: "reading" as const,
    measure: {
      kind: "counter" as const,
      counted: revision * 10,
      unit: "files" as const,
    },
    at: "2026-09-06T10:00:00.000Z",
  });

  it("takes the arriving snapshot wholesale on a first read", () => {
    const arriving = [task({ id: "a" })];
    expect(mergeSnapshot([], arriving)).toEqual(arriving);
  });

  it("keeps the higher revision when a slow response walks a counter backwards", () => {
    const merged = mergeSnapshot(
      [task({ id: "a", status: "running", progress: at(40) })],
      [task({ id: "a", status: "running", progress: at(31) })],
    );

    expect(merged[0]?.progress?.revision).toBe(40);
  });

  it("takes the arriving progress when it is genuinely newer", () => {
    const merged = mergeSnapshot(
      [task({ id: "a", status: "running", progress: at(40) })],
      [task({ id: "a", status: "running", progress: at(41) })],
    );

    expect(merged[0]?.progress?.revision).toBe(41);
  });

  it("does not carry an old attempt's progress into a new one", () => {
    const merged = mergeSnapshot(
      [task({ id: "a", status: "running", attempts: 1, progress: at(40) })],
      [task({ id: "a", status: "running", attempts: 2, progress: at(1) })],
    );

    expect(merged[0]?.progress?.revision).toBe(1);
  });

  it("does not hold a finished task's row open with a running snapshot", () => {
    const merged = mergeSnapshot(
      [task({ id: "a", status: "running", progress: at(40) })],
      [task({ id: "a", status: "succeeded", progress: null })],
    );

    expect(merged[0]?.status).toBe("succeeded");
    expect(merged[0]?.progress).toBeNull();
  });

  it("drops a task the server no longer lists", () => {
    const merged = mergeSnapshot(
      [task({ id: "a" }), task({ id: "b" })],
      [task({ id: "b" })],
    );

    expect(merged.map((t) => t.id)).toEqual(["b"]);
  });
});

describe("the clocks on a row", () => {
  const now = Date.parse("2026-09-06T10:10:00.000Z");

  it("has no elapsed time for a task that never started", () => {
    expect(elapsedSeconds(task({ id: "a" }), now)).toBeNull();
  });

  it("measures a running task against now", () => {
    expect(
      elapsedSeconds(
        task({ id: "a", startedAt: "2026-09-06T10:05:00.000Z" }),
        now,
      ),
    ).toBe(300);
  });

  it("measures a finished task against when it finished", () => {
    expect(
      elapsedSeconds(
        task({
          id: "a",
          startedAt: "2026-09-06T10:05:00.000Z",
          finishedAt: "2026-09-06T10:06:00.000Z",
        }),
        now,
      ),
    ).toBe(60);
  });

  it("measures a queued task's wait against now, and a claimed one's against its start", () => {
    expect(queueWaitSeconds(task({ id: "a" }), now)).toBe(600);
    expect(
      queueWaitSeconds(
        task({ id: "a", startedAt: "2026-09-06T10:02:00.000Z" }),
        now,
      ),
    ).toBe(120);
  });

  it("says how long a running task has been quiet", () => {
    expect(
      sinceProgressSeconds(
        task({ id: "a", progressAt: "2026-09-06T10:08:00.000Z" }),
        now,
      ),
    ).toBe(120);
    expect(sinceProgressSeconds(task({ id: "a" }), now)).toBeNull();
  });
});

describe("the tasks of one run", () => {
  it("collects only the tasks that carry the same run id, oldest first", () => {
    const tasks = [
      task({ id: "b", runId: "run", queuedAt: "2026-09-06T10:02:00.000Z" }),
      task({ id: "a", runId: "run", queuedAt: "2026-09-06T10:01:00.000Z" }),
      task({ id: "other", runId: "elsewhere" }),
      task({ id: "loose" }),
    ];

    expect(runSiblings(tasks, "run").map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("never folds a task with no run into somebody else's", () => {
    expect(runSiblings([task({ id: "loose" })], undefined)).toEqual([]);
  });
});
