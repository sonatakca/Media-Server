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
  status: "failed";
  errorMessage: string;
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
