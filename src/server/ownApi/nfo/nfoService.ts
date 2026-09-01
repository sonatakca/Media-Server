import { nativeExportOwnsLibrary } from "./arrClient";
import type { NfoConfig } from "./nfoConfig";
import { planNfoFiles, type NfoPlan, type NfoSkipReason } from "./nfoPlanner";
import type { NfoItemBundle, NfoRepository } from "./nfoRepository";
import type {
  NfoConflictReason,
  NfoExistingState,
  NfoWriter,
} from "./nfoWriter";

/**
 * Export orchestration: what to write, whether it may be written, and what to
 * report afterwards.
 *
 * Nothing here resolves or formats a host path. Every path that leaves this
 * module is relative to the export root, which is what keeps a conflict report
 * safe to hand to an administrator without telling them the server's directory
 * layout.
 */

export interface NfoPreviewFile {
  relativePath: string;
  xml: string;
  /** What is already at that path. */
  existing: NfoExistingState;
  /** True when the bytes on disk already match exactly. */
  identical: boolean;
  reason?: NfoConflictReason;
}

export interface NfoPreview {
  itemId: string;
  kind: string;
  mode: NfoConfig["mode"];
  overwritePolicy: NfoConfig["overwritePolicy"];
  /** `media-root` in sidecar mode, `generated-storage` otherwise. */
  destination: "media-root" | "generated-storage" | "none";
  files: NfoPreviewFile[];
  skipped?: NfoSkipReason | "arr-managed";
}

export interface NfoConflict {
  itemId: string;
  relativePath: string;
  reason: NfoConflictReason;
}

export interface NfoExportCounts {
  created: number;
  updated: number;
  unchanged: number;
  skippedConflict: number;
  skippedNotApplicable: number;
  failed: number;
}

export interface NfoExportSummary extends NfoExportCounts {
  mode: NfoConfig["mode"];
  itemsConsidered: number;
  /** Bounded; the counts remain exact even when the list is truncated. */
  conflicts: NfoConflict[];
  /** True when `conflicts` was cut short. */
  conflictsTruncated: boolean;
}

export interface NfoService {
  readonly config: NfoConfig;
  preview(itemId: string): Promise<NfoPreview | null>;
  exportItem(
    itemId: string,
    options?: { force?: boolean },
  ): Promise<NfoExportSummary | null>;
  exportLibrary(
    libraryId: string,
    options?: {
      force?: boolean;
      reportProgress?(fraction: number, message: string): Promise<void>;
      isCancelled?(): Promise<boolean>;
    },
  ): Promise<(NfoExportSummary & { cancelled: boolean }) | null>;
}

export interface CreateNfoServiceOptions {
  repository: NfoRepository;
  writer: NfoWriter;
  config: NfoConfig;
}

/** A library export walks the catalogue in pages of this size. */
const LIBRARY_PAGE = 100;

/** Enough conflicts to act on; the counts carry the rest. */
const MAX_REPORTED_CONFLICTS = 50;

function emptyCounts(): NfoExportCounts {
  return {
    created: 0,
    updated: 0,
    unchanged: 0,
    skippedConflict: 0,
    skippedNotApplicable: 0,
    failed: 0,
  };
}

export function createNfoService({
  repository,
  writer,
  config,
}: CreateNfoServiceOptions): NfoService {
  const destination: NfoPreview["destination"] =
    config.mode === "sidecar"
      ? "media-root"
      : config.mode === "generated"
        ? "generated-storage"
        : "none";

  /**
   * Writes one item's planned files and folds the outcomes into `counts`.
   *
   * A plan that produced nothing is counted as not-applicable rather than
   * failed: a season with no folder of its own, or a book, is a normal part of
   * a library, not an error to page someone about.
   */
  async function applyPlan(
    plan: NfoPlan,
    force: boolean,
    counts: NfoExportCounts,
    conflicts: NfoConflict[],
  ): Promise<void> {
    if (plan.files.length === 0) {
      counts.skippedNotApplicable += 1;
      return;
    }

    for (const file of plan.files) {
      const result = await writer.write(file.relativePath, file.xml, { force });
      switch (result.status) {
        case "created":
          counts.created += 1;
          break;
        case "updated":
          counts.updated += 1;
          break;
        case "unchanged":
          counts.unchanged += 1;
          break;
        case "skipped-conflict":
          counts.skippedConflict += 1;
          if (conflicts.length < MAX_REPORTED_CONFLICTS) {
            conflicts.push({
              itemId: plan.itemId,
              relativePath: result.relativePath,
              reason: result.reason ?? "foreign-file",
            });
          }
          break;
        case "skipped-disabled":
          counts.skippedNotApplicable += 1;
          break;
        case "failed":
          counts.failed += 1;
          break;
      }
    }
  }

  async function bundleFor(itemId: string): Promise<NfoItemBundle | null> {
    const [bundle] = await repository.loadBundles([itemId]);
    return bundle ?? null;
  }

  return {
    config,

    preview: async (itemId) => {
      const bundle = await bundleFor(itemId);
      if (!bundle) return null;

      const library = await repository.getLibraryForItem(itemId);
      const base = {
        itemId,
        kind: bundle.item.kind,
        mode: config.mode,
        overwritePolicy: config.overwritePolicy,
        destination,
      };

      if (
        library &&
        !nativeExportOwnsLibrary(library.slug, config.arrManagedLibrarySlugs)
      ) {
        return { ...base, files: [], skipped: "arr-managed" };
      }

      const plan = planNfoFiles(bundle);
      const files: NfoPreviewFile[] = [];
      for (const file of plan.files) {
        const existing = await writer.inspect(file.relativePath);
        files.push({
          relativePath: file.relativePath,
          xml: file.xml,
          existing: existing.state,
          identical: existing.contents === file.xml,
          ...(existing.reason ? { reason: existing.reason } : {}),
        });
      }

      return {
        ...base,
        files,
        ...(plan.skipped ? { skipped: plan.skipped } : {}),
      };
    },

    exportItem: async (itemId, options = {}) => {
      const bundle = await bundleFor(itemId);
      if (!bundle) return null;

      const counts = emptyCounts();
      const conflicts: NfoConflict[] = [];

      const library = await repository.getLibraryForItem(itemId);
      if (
        library &&
        !nativeExportOwnsLibrary(library.slug, config.arrManagedLibrarySlugs)
      ) {
        counts.skippedNotApplicable += 1;
      } else {
        await applyPlan(
          planNfoFiles(bundle),
          options.force === true,
          counts,
          conflicts,
        );
      }

      return {
        ...counts,
        mode: config.mode,
        itemsConsidered: 1,
        conflicts,
        conflictsTruncated: false,
      };
    },

    exportLibrary: async (libraryId, options = {}) => {
      const library = await repository.getLibrary(libraryId);
      if (!library) return null;

      const counts = emptyCounts();
      const conflicts: NfoConflict[] = [];
      let itemsConsidered = 0;
      let cancelled = false;

      if (
        !nativeExportOwnsLibrary(library.slug, config.arrManagedLibrarySlugs)
      ) {
        // Radarr or Sonarr owns these paths. Reporting zero work is the honest
        // answer; writing "just this once" is how two exporters start fighting.
        return {
          ...counts,
          mode: config.mode,
          itemsConsidered: 0,
          conflicts,
          conflictsTruncated: false,
          cancelled: false,
        };
      }

      const total = await repository.countExportableItems(libraryId);
      let after: string | undefined;

      for (;;) {
        if (await options.isCancelled?.()) {
          cancelled = true;
          break;
        }

        const ids = await repository.listExportableItemIds(libraryId, {
          limit: LIBRARY_PAGE,
          ...(after ? { after } : {}),
        });
        if (ids.length === 0) break;
        after = ids[ids.length - 1] as string;

        for (const bundle of await repository.loadBundles(ids)) {
          itemsConsidered += 1;
          await applyPlan(
            planNfoFiles(bundle),
            options.force === true,
            counts,
            conflicts,
          );
        }

        await options.reportProgress?.(
          total === 0 ? 1 : Math.min(1, itemsConsidered / total),
          `Exported metadata for ${itemsConsidered} of ${total} titles`,
        );

        if (ids.length < LIBRARY_PAGE) break;
      }

      return {
        ...counts,
        mode: config.mode,
        itemsConsidered,
        conflicts,
        conflictsTruncated: counts.skippedConflict > conflicts.length,
        cancelled,
      };
    },
  };
}
