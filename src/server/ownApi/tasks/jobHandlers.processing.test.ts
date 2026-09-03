import { describe, expect, it } from "vitest";
import type { CatalogueScanStore } from "../scanner/reconciler";
import type { JobRecord } from "./jobQueue";
import { createJobHandlers, JOB_TYPES } from "./jobHandlers";
import { PermanentJobError } from "./worker";

/**
 * Whether a failed encode gets another go.
 *
 * The distinction matters more than it looks: the queue retries an ordinary
 * error and gives up on a `PermanentJobError`, and giving up means a title sits
 * in the operator's list marked failed until a person notices and requeues it.
 * A rendition lock held by another attempt is not grounds for that — and it was
 * being treated as such, so restarting the worker mid-encode permanently failed
 * the very job the restart had just put back on the queue.
 */
const MEDIA_FILE_ID = "33333333-3333-4333-8333-333333333333";

function scanStore(): CatalogueScanStore {
  return {
    listItems: async () => [],
    listFiles: async () => [],
    upsertItem: async () => "unused",
    setItemRelations: async () => undefined,
    upsertFile: async () => ({ id: "unused", changed: false }),
    replaceExternalSubtitles: async () => undefined,
    markItemsSeen: async () => undefined,
    markFilesSeen: async () => undefined,
    markItemsMissing: async () => undefined,
    markFilesMissing: async () => undefined,
    deleteItems: async () => undefined,
    deleteFiles: async () => undefined,
    queueProbe: async () => undefined,
    refreshItemCounts: async () => undefined,
  };
}

function processingJob(): JobRecord {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    jobType: JOB_TYPES.mediaProcess,
    payload: {
      processingJobId: MEDIA_FILE_ID,
      sourcePath: "/media/Films/A Film (2011)/A Film (2011).mkv",
      relativePath: "Films/A Film (2011)/A Film (2011).mkv",
      sizeBytes: 1024,
      mtimeMs: 1_700_000_000_000,
    },
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
  };
}

function handlersFor(outcome: {
  status: "failed" | "succeeded";
  errorMessage?: string;
  retryable?: boolean;
}) {
  return createJobHandlers({
    libraries: {
      get: async () => null,
      list: async () => [],
    } as never,
    scanStore: scanStore(),
    fileSystem: {} as never,
    probeService: {} as never,
    queue: {} as never,
    processingRunner: { run: async () => outcome },
  });
}

async function run(outcome: Parameters<typeof handlersFor>[0]) {
  const handler = handlersFor(outcome)[JOB_TYPES.mediaProcess];
  return handler({
    job: processingJob(),
    reportProgress: async () => undefined,
    isCancelled: async () => false,
  });
}

describe("a processing job that failed", () => {
  it("goes back on the queue when the rendition lock was simply held", async () => {
    const error = await run({
      status: "failed",
      errorMessage: "Rendition lock is already held: /state/locks/a.lock",
      retryable: true,
    }).catch((thrown: Error) => thrown);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(PermanentJobError);
    expect((error as Error).message).toContain("Rendition lock");
  });

  it("stays failed when the source itself cannot be encoded", async () => {
    // Retrying a file with no video stream would burn attempts on a verdict
    // that will not change.
    const error = await run({
      status: "failed",
      errorMessage: "The source has no video stream.",
    }).catch((thrown: Error) => thrown);

    expect(error).toBeInstanceOf(PermanentJobError);
  });
});

/**
 * The regression the damaged Seagate volume exposed.
 *
 * When the wedged FFmpeg was finally killed, the worker logged
 * `job.failed { retry: true }` and the queue immediately re-ran the identical
 * `media.process` job — a second FFmpeg, same `-ss`, same source, straight back
 * into the same unreadable sectors while the first was still being reaped.
 *
 * A confirmed physical fault is never a condition of the moment, so it must
 * never come back through the queue. The processing record keeps the detail and
 * the page keeps its Retry button; what goes away is the automatic second pass.
 */
describe("a source that cannot be read", () => {
  it("is never requeued automatically", async () => {
    const error = await run({
      status: "failed",
      errorMessage:
        "The source could not be read while its volume stayed available.",
    }).catch((thrown: Error) => thrown);

    expect(error).toBeInstanceOf(PermanentJobError);
  });

  it("does not requeue an encoder that stopped producing either", async () => {
    // Whatever wedged it is in the encode, so doing it again wedges it again.
    const error = await run({
      status: "failed",
      errorMessage:
        "The encoder stopped producing media and had to be stopped.",
    }).catch((thrown: Error) => thrown);

    expect(error).toBeInstanceOf(PermanentJobError);
  });

  it("does not fail the queue run at all when the interval was salvaged", async () => {
    /*
     * The whole point of salvage: the damage is handled *inside* the media job,
     * which then carries on to the next epoch and finishes. There is nothing
     * here for the queue to retry because nothing failed.
     */
    const result = await run({ status: "succeeded" });
    expect(result).toEqual({ status: "succeeded" });
  });
});
