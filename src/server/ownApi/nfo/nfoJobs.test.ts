import { describe, expect, it, vi } from "vitest";
import type { JobRecord } from "../tasks/jobQueue";
import { PermanentJobError } from "../tasks/worker";
import { createNfoJobHandlers, NFO_JOB_TYPES } from "./nfoJobs";
import type { NfoExportSummary, NfoService } from "./nfoService";

const SUMMARY: NfoExportSummary = {
  created: 3,
  updated: 1,
  unchanged: 10,
  skippedConflict: 2,
  skippedNotApplicable: 0,
  failed: 0,
  mode: "sidecar",
  itemsConsidered: 16,
  conflicts: [
    {
      itemId: "aaaaaaaa-1111-4111-8111-111111111111",
      relativePath: "Movies/Dune (2021)/movie.nfo",
      reason: "foreign-file",
    },
  ],
  conflictsTruncated: false,
};

function service(overrides: Partial<NfoService> = {}): NfoService {
  return {
    config: {
      mode: "sidecar",
      overwritePolicy: "managed-only",
      arrManagedLibrarySlugs: new Set(),
    },
    preview: async () => null,
    exportItem: async () => SUMMARY,
    exportLibrary: async () => ({ ...SUMMARY, cancelled: false }),
    ...overrides,
  };
}

function job(payload: Record<string, unknown>): JobRecord {
  return {
    id: "cccccccc-3333-4333-8333-333333333333",
    jobType: NFO_JOB_TYPES.exportItem,
    payload,
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

function context(payload: Record<string, unknown>, overrides = {}) {
  return {
    job: job(payload),
    reportProgress: async () => undefined,
    isCancelled: async () => false,
    ...overrides,
  };
}

describe("nfo jobs", () => {
  it("registers exactly the two documented job types", () => {
    expect(Object.keys(createNfoJobHandlers(service())).sort()).toEqual([
      "nfo.export.item",
      "nfo.export.library",
    ]);
  });

  describe("nfo.export.item", () => {
    it("reports the created, unchanged, conflicting and failed counts", async () => {
      const handlers = createNfoJobHandlers(service());

      const result = await handlers[NFO_JOB_TYPES.exportItem]?.(
        context({ itemId: "aaaaaaaa-1111-4111-8111-111111111111" }),
      );

      expect(result).toMatchObject({
        created: 3,
        unchanged: 10,
        skippedConflict: 2,
        failed: 0,
      });
    });

    it("passes force through", async () => {
      const exportItem = vi.fn(async () => SUMMARY);
      const handlers = createNfoJobHandlers(service({ exportItem }));

      await handlers[NFO_JOB_TYPES.exportItem]?.(
        context({
          itemId: "aaaaaaaa-1111-4111-8111-111111111111",
          force: true,
        }),
      );

      expect(exportItem).toHaveBeenCalledWith(
        "aaaaaaaa-1111-4111-8111-111111111111",
        { force: true },
      );
    });

    it("fails permanently on a payload with no item", async () => {
      const handlers = createNfoJobHandlers(service());

      await expect(
        handlers[NFO_JOB_TYPES.exportItem]?.(context({})),
      ).rejects.toBeInstanceOf(PermanentJobError);
    });

    it("does not retry an item that no longer exists", async () => {
      const handlers = createNfoJobHandlers(
        service({ exportItem: async () => null }),
      );

      await expect(
        handlers[NFO_JOB_TYPES.exportItem]?.(
          context({ itemId: "aaaaaaaa-1111-4111-8111-111111111111" }),
        ),
      ).rejects.toBeInstanceOf(PermanentJobError);
    });
  });

  describe("nfo.export.library", () => {
    it("forwards progress reporting and cancellation to the service", async () => {
      const exportLibrary = vi.fn(async () => ({
        ...SUMMARY,
        cancelled: false,
      }));
      const reportProgress = vi.fn(async () => undefined);
      const handlers = createNfoJobHandlers(service({ exportLibrary }));

      await handlers[NFO_JOB_TYPES.exportLibrary]?.(
        context(
          { libraryId: "bbbbbbbb-2222-4222-8222-222222222222" },
          {
            reportProgress,
          },
        ),
      );

      const options = (
        exportLibrary.mock.calls as unknown as Array<
          [
            string,
            {
              reportProgress?(fraction: number, message: string): Promise<void>;
              isCancelled?(): Promise<boolean>;
            },
          ]
        >
      )[0]?.[1];
      await options?.reportProgress?.(0.5, "half way");
      expect(reportProgress).toHaveBeenCalledWith(0.5, "half way");
      expect(await options?.isCancelled?.()).toBe(false);
    });

    it("fails permanently on a payload with no library", async () => {
      const handlers = createNfoJobHandlers(service());

      await expect(
        handlers[NFO_JOB_TYPES.exportLibrary]?.(context({})),
      ).rejects.toBeInstanceOf(PermanentJobError);
    });
  });
});
