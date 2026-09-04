/**
 * The rules behind the Processes tab: which half a job belongs in, what order
 * the waiting ones are really in, and what a drag leaves behind.
 *
 * These are asserted here rather than through the page because they are the
 * part that has to stay true while the page repaints once a second — an order
 * that is only correct on the first render is an order that jumps under the
 * operator's cursor.
 */

import { describe, expect, it } from "vitest";
import type { ProcessingJob } from "../../lib/processingApi";
import {
  applyQueueOverride,
  canReorder,
  isConcluded,
  moveItem,
  orderHistory,
  orderQueue,
  partitionProcessingJobs,
} from "./processingQueueModel";

function job(overrides: Partial<ProcessingJob> & { id: string }) {
  return {
    itemId: `${overrides.id}-item`,
    mediaFileId: `${overrides.id}-file`,
    profile: "cmaf-hls-aligned-v2",
    state: "queued",
    stage: "waiting",
    stageProgress: 0,
    overallProgress: 0,
    bytesProcessed: 0,
    actualOutputBytes: 0,
    outputBytes: null,
    estimatedOutputBytes: null,
    estimatedStagingBytes: null,
    speed: null,
    fps: null,
    etaSeconds: null,
    hardwareAdapter: null,
    videoEncoder: null,
    decision: null,
    validation: null,
    warnings: [],
    sourceDamage: null,
    errorCode: null,
    errorMessage: null,
    publishedVersion: null,
    attempts: 0,
    cancellationRequested: false,
    pauseRequested: false,
    pausedReason: null,
    epochCount: null,
    epochIndex: null,
    completedEpochs: 0,
    protectedSeconds: 0,
    encodedSeconds: 0,
    sourceDurationSeconds: null,
    epochStartSeconds: null,
    epochEndSeconds: null,
    checkpointBytes: 0,
    freeBytes: null,
    queuePriority: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  } as ProcessingJob;
}

const ids = (jobs: readonly ProcessingJob[]) => jobs.map((entry) => entry.id);

describe("which half of the tab a job belongs in", () => {
  it("counts every terminal state as concluded and nothing else", () => {
    expect(isConcluded({ state: "succeeded" })).toBe(true);
    expect(isConcluded({ state: "failed" })).toBe(true);
    expect(isConcluded({ state: "cancelled" })).toBe(true);
    expect(isConcluded({ state: "pending" })).toBe(false);
    expect(isConcluded({ state: "queued" })).toBe(false);
    expect(isConcluded({ state: "running" })).toBe(false);
    // Paused is not concluded: the work is suspended, not over.
    expect(isConcluded({ state: "paused" })).toBe(false);
  });

  it("splits a mixed list into the queue and the history", () => {
    const { active, finished } = partitionProcessingJobs([
      job({ id: "done", state: "succeeded" }),
      job({ id: "waiting", queuePriority: 100 }),
      job({ id: "encoding", state: "running" }),
    ]);

    expect(ids(active)).toEqual(["encoding", "waiting"]);
    expect(ids(finished)).toEqual(["done"]);
  });
});

describe("the order of the waiting line", () => {
  it("puts what is underway first and the rest in queue order", () => {
    const ordered = orderQueue([
      job({ id: "third", queuePriority: 102 }),
      job({ id: "first", queuePriority: 100 }),
      job({ id: "encoding", state: "running", queuePriority: null }),
      job({ id: "second", queuePriority: 101 }),
    ]);

    expect(ids(ordered)).toEqual(["encoding", "first", "second", "third"]);
  });

  it("keeps a paused job at the head rather than in the line", () => {
    // A paused encode still owns the encoder and its workspace. It is not
    // waiting for a turn, so it cannot sit among the jobs that are.
    const ordered = orderQueue([
      job({ id: "waiting", queuePriority: 100 }),
      job({ id: "held", state: "paused", pauseRequested: true }),
    ]);

    expect(ids(ordered)).toEqual(["held", "waiting"]);
  });

  it("keeps a job whose attempt has no place, at the end rather than dropped", () => {
    const ordered = orderQueue([
      job({ id: "orphan", createdAt: "2026-09-01T00:00:00.000Z" }),
      job({ id: "queued", queuePriority: 140 }),
    ]);

    expect(ids(ordered)).toEqual(["queued", "orphan"]);
  });

  it("falls back to age when two jobs claim the same place", () => {
    const ordered = orderQueue([
      job({
        id: "later",
        queuePriority: 100,
        createdAt: "2026-09-02T00:00:00.000Z",
      }),
      job({
        id: "earlier",
        queuePriority: 100,
        createdAt: "2026-09-01T00:00:00.000Z",
      }),
    ]);

    expect(ids(ordered)).toEqual(["earlier", "later"]);
  });

  it("reads the position rather than the state to decide what can be dragged", () => {
    expect(canReorder({ queuePriority: 100 })).toBe(true);
    expect(canReorder({ queuePriority: null })).toBe(false);
    // A server that predates the ordered queue sends nothing at all.
    expect(canReorder({})).toBe(false);
  });
});

describe("the history", () => {
  it("reads newest first, the opposite of the queue", () => {
    const ordered = orderHistory([
      job({
        id: "older",
        state: "succeeded",
        finishedAt: "2026-09-01T10:00:00.000Z",
      }),
      job({
        id: "newest",
        state: "failed",
        finishedAt: "2026-09-03T10:00:00.000Z",
      }),
      job({
        id: "middle",
        state: "cancelled",
        finishedAt: "2026-09-02T10:00:00.000Z",
      }),
    ]);

    expect(ids(ordered)).toEqual(["newest", "middle", "older"]);
  });

  it("stands the creation time in for a job whose worker never recorded an end", () => {
    const ordered = orderHistory([
      job({
        id: "recorded",
        state: "succeeded",
        finishedAt: "2026-09-01T10:00:00.000Z",
      }),
      job({
        id: "vanished",
        state: "failed",
        createdAt: "2026-09-05T00:00:00.000Z",
        finishedAt: null,
      }),
    ]);

    expect(ids(ordered)).toEqual(["vanished", "recorded"]);
  });
});

describe("moving a row", () => {
  it("lifts an item out and puts it back at the target index", () => {
    expect(moveItem(["a", "b", "c", "d"], 3, 1)).toEqual(["a", "d", "b", "c"]);
    expect(moveItem(["a", "b", "c", "d"], 0, 2)).toEqual(["b", "c", "a", "d"]);
  });

  it("clamps a drop past the end instead of refusing it", () => {
    expect(moveItem(["a", "b", "c"], 0, 9)).toEqual(["b", "c", "a"]);
    expect(moveItem(["a", "b", "c"], 2, -4)).toEqual(["c", "a", "b"]);
  });

  it("changes nothing when the row is dropped where it came from", () => {
    expect(moveItem(["a", "b", "c"], 1, 1)).toEqual(["a", "b", "c"]);
    expect(moveItem(["a", "b", "c"], 7, 0)).toEqual(["a", "b", "c"]);
  });
});

describe("holding the dragged order until the server agrees", () => {
  it("rearranges only the rows the override names", () => {
    const ordered = [
      job({ id: "encoding", state: "running" }),
      job({ id: "first", queuePriority: 100 }),
      job({ id: "second", queuePriority: 101 }),
      job({ id: "third", queuePriority: 102 }),
    ];

    // The encode keeps the one position it can never be moved out of.
    expect(
      ids(applyQueueOverride(ordered, ["third", "first", "second"])),
    ).toEqual(["encoding", "third", "first", "second"]);
  });

  it("leaves a job the override never saw where the server put it", () => {
    const ordered = [
      job({ id: "first", queuePriority: 100 }),
      job({ id: "second", queuePriority: 101 }),
      job({ id: "queued-during-the-drag", queuePriority: 102 }),
    ];

    expect(ids(applyQueueOverride(ordered, ["second", "first"]))).toEqual([
      "second",
      "first",
      "queued-during-the-drag",
    ]);
  });

  it("passes the server's order straight through when there is no override", () => {
    const ordered = [job({ id: "a" }), job({ id: "b" })];
    expect(ids(applyQueueOverride(ordered, null))).toEqual(["a", "b"]);
    expect(ids(applyQueueOverride(ordered, []))).toEqual(["a", "b"]);
  });
});
