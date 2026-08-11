import { describe, expect, it } from "vitest";
import type { TaskDto } from "../../api/ownApi/dto";
import {
  describeTask,
  getTaskTitleKey,
  selectChangedTasks,
  summariseResult,
} from "./taskNotifications";

function task(overrides: Partial<TaskDto> = {}): TaskDto {
  return {
    id: "task-1",
    type: "library.scan",
    status: "running",
    progress: 42,
    progressMessage: null,
    attempts: 1,
    maxAttempts: 3,
    error: null,
    result: null,
    queuedAt: "2026-08-11T00:00:00Z",
    startedAt: "2026-08-11T00:00:01Z",
    finishedAt: null,
    ...overrides,
  };
}

describe("describing a task", () => {
  it("says nothing about work that has not started", () => {
    // A queued job is not news, and announcing it would leave a card sitting at
    // zero for as long as the queue is busy.
    expect(describeTask(task({ status: "queued" }))).toBeNull();
    expect(describeTask(task({ status: "cancelled" }))).toBeNull();
  });

  it("reports running work as persistent progress", () => {
    const described = describeTask(
      task({ status: "running", progress: 42, progressMessage: "Reading disc" }),
    );

    expect(described).toMatchObject({
      tone: "progress",
      progress: 42,
      description: "Reading disc",
      // Held until the job ends, whereupon this same card becomes the outcome.
      life: "persistent",
    });
  });

  it("keeps one card per task, so progress replaces rather than accumulates", () => {
    const first = describeTask(task({ progress: 10 }));
    const second = describeTask(task({ progress: 90 }));
    expect(first?.key).toBe(second?.key);
  });

  it("clamps a progress value the server should not have sent", () => {
    expect(describeTask(task({ progress: 140 }))?.progress).toBe(100);
    expect(describeTask(task({ progress: -5 }))?.progress).toBe(0);
  });

  it("lets a success fade but holds a failure until it is read", () => {
    expect(describeTask(task({ status: "succeeded" }))).toMatchObject({
      tone: "success",
      life: "long",
    });
    expect(
      describeTask(task({ status: "failed", error: "Disk unavailable" })),
    ).toMatchObject({
      tone: "error",
      description: "Disk unavailable",
      life: "persistent",
    });
  });

  it("names every job type the queue actually enqueues", () => {
    // These are the literals in JOB_TYPES. Getting one wrong is invisible: the
    // job simply reports itself as unspecified "background work".
    expect(getTaskTitleKey("library.scan")).toBe("tasks.libraryScan");
    expect(getTaskTitleKey("media.probe")).toBe("tasks.probeRun");
    expect(getTaskTitleKey("metadata.scan")).toBe("tasks.metadataScan");
    expect(getTaskTitleKey("metadata.refresh")).toBe("tasks.metadataRefresh");
    expect(getTaskTitleKey("trickplay.generate")).toBe(
      "tasks.trickplayGenerate",
    );
    expect(getTaskTitleKey("something.new")).toBe("tasks.backgroundWork");
  });
});

describe("summarising a result", () => {
  it("reports the counts a scan actually found", () => {
    const summary = summariseResult(
      task({
        status: "succeeded",
        result: { itemsCreated: 42, filesProbed: 296 },
      }),
    );

    expect(summary).toContain("Items created: 42");
    expect(summary).toContain("Files probed: 296");
  });

  it("leaves out counts of nothing, which say nothing", () => {
    expect(
      summariseResult(
        task({ status: "succeeded", result: { itemsCreated: 0, removed: 0 } }),
      ),
    ).toBeUndefined();
  });

  it("ignores values that are not counts", () => {
    expect(
      summariseResult(
        task({ status: "succeeded", result: { libraryId: "abc", ok: true } }),
      ),
    ).toBeUndefined();
  });

  it("has nothing to say when the job reported nothing", () => {
    expect(summariseResult(task({ status: "succeeded" }))).toBeUndefined();
  });
});

describe("noticing what changed since the last poll", () => {
  it("announces a task the first time it is seen", () => {
    const { changed, next } = selectChangedTasks([task()], new Map());
    expect(changed).toHaveLength(1);
    expect(next.size).toBe(1);
  });

  it("says nothing about history on the first poll after a page load", () => {
    // Everything is unseen then. Without this a reload replays every scan that
    // ever finished and every failure from days ago as though it had just
    // happened — which is exactly what a refresh looked like.
    const { changed, next } = selectChangedTasks(
      [
        task({ id: "a", status: "succeeded" }),
        task({ id: "b", status: "failed", error: "old" }),
      ],
      new Map(),
      true,
    );

    expect(changed).toHaveLength(0);
    // They are still remembered, so a later change to either is noticed.
    expect(next.size).toBe(2);
  });

  it("still announces work already running when the page loads", () => {
    // That is happening now, and is the reason somebody would look.
    const { changed } = selectChangedTasks(
      [task({ id: "a", status: "succeeded" }), task({ id: "b", status: "running" })],
      new Map(),
      true,
    );

    expect(changed.map((entry) => entry.id)).toEqual(["b"]);
  });

  it("announces a job that finishes after the first poll", () => {
    const first = selectChangedTasks([task({ status: "running" })], new Map(), true);
    const second = selectChangedTasks(
      [task({ status: "succeeded" })],
      first.next,
    );
    expect(second.changed).toHaveLength(1);
  });

  it("keeps announcing a running task as its progress moves", () => {
    const first = selectChangedTasks([task({ progress: 10 })], new Map());
    const second = selectChangedTasks([task({ progress: 40 })], first.next);
    expect(second.changed).toHaveLength(1);
  });

  it("says nothing when a running task has not moved", () => {
    const first = selectChangedTasks([task({ progress: 10 })], new Map());
    const second = selectChangedTasks([task({ progress: 10 })], first.next);
    expect(second.changed).toHaveLength(0);
  });

  it("announces a finished task once and then lets it be", () => {
    // A finished job stays in the list for a while. Without this its success
    // card would be re-raised on every poll and never expire.
    const running = selectChangedTasks([task({ status: "running" })], new Map());
    const finished = selectChangedTasks(
      [task({ status: "succeeded", progress: 100 })],
      running.next,
    );
    expect(finished.changed).toHaveLength(1);

    const again = selectChangedTasks(
      [task({ status: "succeeded", progress: 100 })],
      finished.next,
    );
    expect(again.changed).toHaveLength(0);
  });

  it("tracks each task separately", () => {
    const { changed } = selectChangedTasks(
      [task({ id: "a" }), task({ id: "b" })],
      new Map([["a", "running:42:"]]),
    );
    expect(changed.map((entry) => entry.id)).toEqual(["b"]);
  });
});
