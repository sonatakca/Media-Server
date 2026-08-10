import type { JobHandler } from "./worker";
import { PermanentJobError } from "./worker";
import type { JobQueue } from "./jobQueue";
import type { LibraryRepository } from "../libraries/libraryRepository";
import type { CatalogueScanStore } from "../scanner/reconciler";
import { reconcileLibraryScan } from "../scanner/reconciler";
import { scanLibraryTree, type ScanResult } from "../scanner/libraryScan";
import type { ScannerFileSystem } from "../scanner/libraryScan";
import type { createProbeService } from "../probe/probeService";
import type { MetadataService } from "../metadata/metadataService";

export const JOB_TYPES = {
  libraryScan: "library.scan",
  mediaProbe: "media.probe",
  metadataScan: "metadata.scan",
  metadataRefresh: "metadata.refresh",
} as const;

export interface JobHandlerOptions {
  libraries: LibraryRepository;
  scanStore: CatalogueScanStore;
  fileSystem: ScannerFileSystem;
  probeService: ReturnType<typeof createProbeService>;
  queue: JobQueue;
  /** Absent when no TMDB key is configured; metadata jobs then no-op. */
  metadataService?: MetadataService;
}

/**
 * Merges the scans of a library's roots into one snapshot before reconciling.
 *
 * Reconciling per root would make every root look like a mass disappearance to
 * the others, since each pass only sees part of the library.
 */
function mergeScans(results: ScanResult[]): ScanResult {
  const merged: ScanResult = { items: [], skipped: [] };
  const seenSourceKeys = new Set<string>();

  for (const result of results) {
    for (const item of result.items) {
      if (seenSourceKeys.has(item.sourceKey)) continue;
      seenSourceKeys.add(item.sourceKey);
      merged.items.push(item);
    }
    merged.skipped.push(...result.skipped);
  }
  return merged;
}

export function createJobHandlers({
  libraries,
  scanStore,
  fileSystem,
  probeService,
  queue,
  metadataService,
}: JobHandlerOptions): Record<string, JobHandler> {
  const libraryScan: JobHandler = async ({ job, reportProgress, isCancelled }) => {
    const libraryId = job.payload.libraryId;
    if (typeof libraryId !== "string") {
      throw new PermanentJobError("The task payload is missing a library.");
    }

    const library = await libraries.getById(libraryId);
    if (!library) {
      throw new PermanentJobError("The library no longer exists.");
    }

    await reportProgress(0.05, "Reading the library folders");

    const results: ScanResult[] = [];
    for (const [index, root] of library.roots.entries()) {
      if (await isCancelled()) {
        return { cancelled: true };
      }
      results.push(
        await scanLibraryTree({
          fileSystem,
          rootPath: root,
          kind: library.kind,
        }),
      );
      await reportProgress(
        0.05 + (0.55 * (index + 1)) / Math.max(1, library.roots.length),
        "Reading the library folders",
      );
    }

    if (await isCancelled()) return { cancelled: true };

    await reportProgress(0.65, "Updating the catalogue");
    const summary = await reconcileLibraryScan({
      store: scanStore,
      libraryId,
      scan: mergeScans(results),
      allowMassRemoval: job.payload.allowMassRemoval === true,
    });

    // Probing and metadata are queued separately so a long backlog does not
    // hold the scan's lease, and so the catalogue is browsable before either
    // finishes.
    if (summary.probesQueued > 0) {
      await queue.enqueue({
        jobType: JOB_TYPES.mediaProbe,
        dedupeKey: JOB_TYPES.mediaProbe,
        priority: 200,
      });
    }
    if (metadataService && summary.itemsCreated > 0) {
      await queue.enqueue({
        jobType: JOB_TYPES.metadataScan,
        payload: { libraryId },
        dedupeKey: `${JOB_TYPES.metadataScan}:${libraryId}`,
        priority: 300,
      });
    }

    await reportProgress(1, "Scan complete");
    return { ...summary };
  };

  const mediaProbe: JobHandler = async ({ reportProgress, isCancelled }) => {
    let probed = 0;
    let failed = 0;

    for (;;) {
      if (await isCancelled()) break;

      const batch = await probeService.runBatch();
      probed += batch.probed;
      failed += batch.failed;

      if (batch.remaining === 0) break;
      if (batch.probed === 0 && batch.failed === 0) break;

      const total = probed + failed + batch.remaining;
      await reportProgress(
        total === 0 ? 1 : (probed + failed) / total,
        `Analysed ${probed + failed} of ${total} files`,
      );
    }

    return { probed, failed };
  };

  const metadataScan: JobHandler = async ({ job, reportProgress, isCancelled }) => {
    if (!metadataService) {
      throw new PermanentJobError("No metadata provider is configured.");
    }

    const libraryId =
      typeof job.payload.libraryId === "string" ? job.payload.libraryId : undefined;

    let matched = 0;
    let ambiguous = 0;
    let notFound = 0;

    // Bounded batches keep the provider's rate limit in view and let a
    // cancellation take effect between them. The seen set is a termination
    // guard: if a batch returns only items already visited, no progress is
    // being made and the loop must stop rather than spin.
    const seen = new Set<string>();

    for (;;) {
      if (await isCancelled()) break;

      const results = await metadataService.processPending(10, libraryId);
      if (results.length === 0) break;
      if (results.every((result) => seen.has(result.itemId))) break;

      for (const result of results) {
        seen.add(result.itemId);
        if (result.status === "matched") matched += 1;
        else if (result.status === "ambiguous") ambiguous += 1;
        else if (result.status === "not-found") notFound += 1;
      }

      await reportProgress(
        0.5,
        `Identified ${matched} titles, ${ambiguous} need review`,
      );
    }

    return { matched, ambiguous, notFound };
  };

  const metadataRefresh: JobHandler = async ({ job }) => {
    if (!metadataService) {
      throw new PermanentJobError("No metadata provider is configured.");
    }
    const itemId = job.payload.itemId;
    if (typeof itemId !== "string") {
      throw new PermanentJobError("The task payload is missing an item.");
    }

    const result = await metadataService.refreshItem(itemId);
    return { ...result };
  };

  return {
    [JOB_TYPES.libraryScan]: libraryScan,
    [JOB_TYPES.mediaProbe]: mediaProbe,
    [JOB_TYPES.metadataScan]: metadataScan,
    [JOB_TYPES.metadataRefresh]: metadataRefresh,
  };
}
