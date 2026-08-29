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
import type { TrickplayService } from "../trickplay/trickplayService";

export const JOB_TYPES = {
  libraryScan: "library.scan",
  mediaProbe: "media.probe",
  metadataScan: "metadata.scan",
  metadataRefresh: "metadata.refresh",
  trickplayGenerate: "trickplay.generate",
  mediaProcess: "media.process",
} as const;

export interface JobHandlerOptions {
  libraries: LibraryRepository;
  scanStore: CatalogueScanStore;
  fileSystem: ScannerFileSystem;
  probeService: ReturnType<typeof createProbeService>;
  queue: JobQueue;
  /** Absent when no TMDB key is configured; metadata jobs then no-op. */
  metadataService?: MetadataService;
  trickplayService?: TrickplayService;
  /**
   * Runs a media-processing job. Absent when the runtime has no rendition
   * paths configured, in which case queued processing jobs fail cleanly rather
   * than being silently dropped.
   */
  processingRunner?: {
    run(input: {
      processingJobId: string;
      sourcePath: string;
      relativePath: string;
      sizeBytes: number;
      mtimeMs: number;
      signal?: AbortSignal;
      isCancelled?: () => Promise<boolean>;
    }): Promise<{
      status: "succeeded" | "failed" | "cancelled";
      errorMessage?: string;
    }>;
  };
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
  trickplayService,
  processingRunner,
}: JobHandlerOptions): Record<string, JobHandler> {
  const libraryScan: JobHandler = async ({
    job,
    reportProgress,
    isCancelled,
  }) => {
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
    // Not gated on itemsCreated: a scan that failed after reconciling leaves the
    // items already created, so the retry would report zero and never ask for
    // metadata. The job is deduped and exits immediately when nothing is
    // pending, so queueing it unconditionally costs nothing.
    if (metadataService) {
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

  const metadataScan: JobHandler = async ({
    job,
    reportProgress,
    isCancelled,
  }) => {
    if (!metadataService) {
      throw new PermanentJobError("No metadata provider is configured.");
    }

    const libraryId =
      typeof job.payload.libraryId === "string"
        ? job.payload.libraryId
        : undefined;

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

  const trickplayGenerate: JobHandler = async ({ job }) => {
    if (!trickplayService) {
      throw new PermanentJobError("Trickplay generation is not available.");
    }
    const itemId = job.payload.itemId;
    if (typeof itemId !== "string") {
      throw new PermanentJobError("The task payload is missing an item.");
    }

    if (job.payload.force === true) {
      await trickplayService.deleteForItem(itemId);
    }

    const set = await trickplayService.generateForItem(itemId);
    return set
      ? { generated: true, spriteCount: set.spriteCount }
      : { generated: false };
  };

  /**
   * Runs one media-processing job.
   *
   * The queue owns scheduling, leasing and retry; the runner owns the media
   * work and writes its own detailed record. Progress is mirrored back onto the
   * queue row so the generic task list stays meaningful, but the processing UI
   * reads the richer record directly.
   */
  const mediaProcess: JobHandler = async ({
    job,
    reportProgress,
    isCancelled,
  }) => {
    const payload = job.payload as {
      processingJobId?: unknown;
      sourcePath?: unknown;
      relativePath?: unknown;
      sizeBytes?: unknown;
      mtimeMs?: unknown;
    };
    if (
      typeof payload.processingJobId !== "string" ||
      typeof payload.sourcePath !== "string" ||
      typeof payload.relativePath !== "string" ||
      typeof payload.sizeBytes !== "number" ||
      typeof payload.mtimeMs !== "number"
    ) {
      throw new PermanentJobError("The processing task payload is incomplete.");
    }
    if (!processingRunner) {
      throw new PermanentJobError(
        "This server is not configured to process media.",
      );
    }

    await reportProgress(0.01, "Starting media processing");
    const outcome = await processingRunner.run({
      processingJobId: payload.processingJobId,
      sourcePath: payload.sourcePath,
      relativePath: payload.relativePath,
      sizeBytes: payload.sizeBytes,
      mtimeMs: payload.mtimeMs,
      isCancelled,
    });
    await reportProgress(1, "Media processing finished");

    if (outcome.status === "failed") {
      // Already recorded in detail on the processing job; the queue row only
      // needs to know it did not succeed.
      throw new PermanentJobError(outcome.errorMessage ?? "Processing failed.");
    }
    return { status: outcome.status };
  };

  return {
    [JOB_TYPES.mediaProcess]: mediaProcess,
    [JOB_TYPES.libraryScan]: libraryScan,
    [JOB_TYPES.trickplayGenerate]: trickplayGenerate,
    [JOB_TYPES.mediaProbe]: mediaProbe,
    [JOB_TYPES.metadataScan]: metadataScan,
    [JOB_TYPES.metadataRefresh]: metadataRefresh,
  };
}
