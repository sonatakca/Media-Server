import { describe, expect, it, vi } from "vitest";
import {
  createWorker,
  PermanentJobError,
  sanitizeJobError,
  type JobHandler,
} from "./worker";
import type { JobQueue, JobRecord, JobStatus } from "./jobQueue";

function job(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "job-1",
    jobType: "library.scan",
    payload: {},
    status: "running",
    attempts: 1,
    maxAttempts: 3,
    progress: 0,
    progressMessage: null,
    safeError: null,
    result: null,
    cancellationRequested: false,
    queuedAt: new Date(),
    startedAt: new Date(),
    finishedAt: null,
    ...overrides,
  };
}

interface FakeQueue extends JobQueue {
  completed: Array<{ id: string; result?: Record<string, unknown> }>;
  failures: Array<{ id: string; error: string; retry: boolean }>;
}

function fakeQueue(pending: JobRecord[]): FakeQueue {
  const queue: FakeQueue = {
    completed: [],
    failures: [],
    enqueue: async () => "job-1",
    claim: async () => pending.shift() ?? null,
    heartbeat: async () => true,
    reportProgress: async () => undefined,
    complete: async (id, result) => {
      queue.completed.push({ id, ...(result ? { result } : {}) });
    },
    fail: async (id, error, retry) => {
      queue.failures.push({ id, error, retry });
    },
    requestCancellation: async () => true,
    isCancellationRequested: async () => false,
    get: async () => null,
    list: async () => [],
    reclaimExpiredLeases: async () => 0,
  };
  return queue;
}

describe("job worker", () => {
  it("drains every queued job in one pass rather than one per interval", async () => {
    const queue = fakeQueue([
      job({ id: "a" }),
      job({ id: "b" }),
      job({ id: "c" }),
    ]);
    const handler: JobHandler = async () => ({ ok: true });
    const worker = createWorker({
      queue,
      handlers: { "library.scan": handler },
    });

    await worker.runPending();

    expect(queue.completed.map((entry) => entry.id)).toEqual(["a", "b", "c"]);
  });

  it("stores the handler's result with the job", async () => {
    const queue = fakeQueue([job()]);
    const worker = createWorker({
      queue,
      handlers: { "library.scan": async () => ({ itemsCreated: 4 }) },
    });

    await worker.runPending();

    expect(queue.completed[0]?.result).toEqual({ itemsCreated: 4 });
  });

  it("retries a transient failure but not a permanent one", async () => {
    const transient = fakeQueue([job({ id: "transient" })]);
    await createWorker({
      queue: transient,
      handlers: {
        "library.scan": async () => {
          throw new Error("the volume was busy");
        },
      },
    }).runPending();
    expect(transient.failures[0]).toMatchObject({ retry: true });

    const permanent = fakeQueue([job({ id: "permanent" })]);
    await createWorker({
      queue: permanent,
      handlers: {
        "library.scan": async () => {
          throw new PermanentJobError("the library no longer exists");
        },
      },
    }).runPending();
    expect(permanent.failures[0]).toMatchObject({ retry: false });
  });

  it("fails a job with no registered handler without retrying forever", async () => {
    const queue = fakeQueue([job({ jobType: "unknown.type" })]);
    await createWorker({ queue, handlers: {} }).runPending();

    expect(queue.failures[0]).toMatchObject({ retry: false });
  });

  it("keeps the lease alive while a long job runs", async () => {
    vi.useFakeTimers();
    try {
      const queue = fakeQueue([job()]);
      const heartbeat = vi.spyOn(queue, "heartbeat");
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });

      const worker = createWorker({
        queue,
        handlers: { "library.scan": () => gate.then(() => undefined) },
        leaseMs: 9_000,
      });

      const pass = worker.runPending();
      await vi.advanceTimersByTimeAsync(7_000);
      expect(heartbeat).toHaveBeenCalled();

      release();
      await vi.runAllTimersAsync();
      await pass;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("sanitizeJobError", () => {
  it("strips filesystem paths from an operator-visible message", () => {
    expect(
      sanitizeJobError(new Error("cannot open /media/Movies/Secret.mkv")),
    ).toBe("cannot open");
    expect(
      sanitizeJobError(new Error("failed reading D:\\media\\Shows\\x.mkv")),
    ).toBe("failed reading");
  });

  it("strips connection strings", () => {
    expect(
      sanitizeJobError(
        new Error("connect failed postgresql://user:pw@host/db"),
      ),
    ).toBe("connect failed");
  });

  it("keeps only the first line", () => {
    expect(sanitizeJobError(new Error("headline\nstack frame one"))).toBe(
      "headline",
    );
  });

  it("falls back to a generic message when nothing safe remains", () => {
    expect(sanitizeJobError(new Error("/var/lib/secret"))).toBe(
      "The task failed.",
    );
  });
});

describe("job status typing", () => {
  it("keeps the status union in sync with the queue contract", () => {
    const statuses: JobStatus[] = [
      "queued",
      "running",
      "succeeded",
      "failed",
      "cancelled",
    ];
    expect(statuses).toHaveLength(5);
  });
});
