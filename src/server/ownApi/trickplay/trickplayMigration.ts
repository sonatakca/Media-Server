import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import {
  resolveTitleRoot,
  titleRootLayoutForKind,
} from "../../../renditions/adaptive/titleRoot";
import type { CatalogueRepository } from "../catalogue/catalogueRepository";
import type { DatabasePool } from "../database/databasePool";
import {
  compareSummaries,
  copyDirectoryTree,
  summariseDirectory,
  UnsafePathError,
} from "./directoryVerification";
import type { TrickplayLayout } from "./trickplayLayout";
import {
  commitPublishedTrickplay,
  discardTrickplayStaging,
  prepareTrickplayStaging,
  publishTrickplayDirectory,
  rollbackPublishedTrickplay,
} from "./trickplayPublication";
import {
  isFilesystemSidecar,
  isInsideDirectory,
  TRICKPLAY_STAGING_PREFIX,
  trickplayDirectoryFor,
} from "./trickplayStorage";
import { validateTrickplayOutput } from "./trickplayValidation";

/**
 * Moving this server's own previous trickplay layout into the new one.
 *
 * These sets are **not** the Jellyfin-era `*.trickplay` folders and must never
 * be confused with them. They are Seyirlik's own output, written into
 * `<generated storage>/trickplay/<uuid>/` by the implementation this work
 * replaces, and they belong in the title folders their sources live in. The
 * legacy external folders are a different population, handled by
 * `legacyTrickplayArchive.ts`, and they go to an archive rather than into a
 * title.
 *
 * The order of operations is the whole design:
 *
 *     read the old set  ->  validate it  ->  copy into staging beside the
 *     destination  ->  verify the copy against the original, file by file  ->
 *     publish  ->  record it in the database  ->  and only now remove the old
 *     directory.
 *
 * Every earlier step is reversible; the last one is not, and it is reached only
 * once the set exists somewhere else and the database says so. A run that is
 * killed anywhere in the middle leaves the old set intact, so the next run
 * simply does it again.
 */

export type MigrationStatus =
  /** Copied, verified, published, recorded, and the old directory removed. */
  | "migrated"
  /**
   * The title already holds these very bytes and the row has been updated to
   * say so. This is what a re-run of a completed migration reports, and what an
   * interrupted run reports for the set it was in the middle of.
   */
  | "already-migrated"
  /** The row's UUID directory is not on disk. Reported, never invented. */
  | "source-missing"
  /** The title already holds a *different* set. Nothing is touched. */
  | "conflict"
  /** No media file, or no title root inside the media root. */
  | "unresolvable"
  /** The old set does not describe what its row claims. */
  | "invalid-source"
  | "failed";

export interface MigrationOutcome {
  setId: string;
  mediaFileId: string;
  status: MigrationStatus;
  relativePath?: string;
  from?: string;
  to?: string;
  /** The sentence an operator reads when the status is not `migrated`. */
  detail?: string;
  files?: number;
  bytes?: number;
}

export interface MigrationReport {
  dryRun: boolean;
  legacyRoot: string;
  outcomes: MigrationOutcome[];
  /** True when the old central root was empty afterwards and was removed. */
  legacyRootRemoved: boolean;
  /**
   * Directories in the old root that no row claims.
   *
   * They are reported and never touched. A UUID directory with no
   * `trickplay_sets` row behind it is output from a set that was deleted, or
   * from a generation whose row never landed — either way this command has no
   * media file to resolve a destination from, so there is nowhere to migrate it
   * to. They are the reason the old root can still be there after a run in
   * which every set succeeded, and an operator who is not told that is left
   * guessing.
   */
  orphanDirectories: string[];
}

interface LegacyRow {
  id: string;
  media_file_id: string;
  tile_width: number;
  tile_height: number;
  columns: number;
  rows: number;
  interval_ms: number;
  thumbnail_count: number;
  sprite_count: number;
  storage_prefix: string;
}

export interface TrickplayMigrationOptions {
  pool: DatabasePool;
  catalogue: Pick<CatalogueRepository, "getFileById" | "getItemKind">;
  mediaRoot: string;
  generatedStoragePath: string;
  /** Reports what would happen and writes nothing. */
  dryRun?: boolean;
  onProgress?: (outcome: MigrationOutcome) => void;
}

function layoutOf(row: LegacyRow): TrickplayLayout {
  return {
    tileWidth: row.tile_width,
    tileHeight: row.tile_height,
    columns: row.columns,
    rows: row.rows,
    intervalMs: row.interval_ms,
    thumbnailCount: row.thumbnail_count,
    spriteCount: row.sprite_count,
  };
}

async function directoryExists(candidate: string): Promise<boolean> {
  const stats = await stat(candidate).catch(() => null);
  return stats?.isDirectory() ?? false;
}

/**
 * Migrates every set still recorded with a legacy storage prefix.
 *
 * A row whose `storage_prefix` is null is already in the new layout and is not
 * selected at all, which is what makes a second run cheap as well as safe.
 */
export async function migrateLegacyTrickplaySets({
  pool,
  catalogue,
  mediaRoot,
  generatedStoragePath,
  dryRun = false,
  onProgress,
}: TrickplayMigrationOptions): Promise<MigrationReport> {
  const legacyRoot = path.join(generatedStoragePath, "trickplay");
  const resolvedMediaRoot = path.resolve(mediaRoot);
  const outcomes: MigrationOutcome[] = [];

  const result = await pool.query<LegacyRow>(
    `SELECT id, media_file_id, tile_width, tile_height, columns, rows,
            interval_ms, thumbnail_count, sprite_count, storage_prefix
       FROM trickplay_sets
      WHERE storage_prefix IS NOT NULL
      ORDER BY created_at`,
  );

  // Which directories the database still accounts for. Anything else in the old
  // root is an orphan, and is reported rather than removed or adopted.
  const claimed = new Set(result.rows.map((row) => row.storage_prefix));

  for (const row of result.rows) {
    const outcome = await migrateOne(row);
    outcomes.push(outcome);
    onProgress?.(outcome);
  }

  /*
   * The old root goes only when it is genuinely empty. A set that could not be
   * migrated is still in there, and removing the tree around it would destroy
   * exactly the thing this command exists to preserve.
   *
   * "Empty" means empty of directories this server wrote. Removing `<uuid>`
   * leaves the AppleDouble `._<uuid>` the filesystem made for it, so counting
   * raw entries would report a root that holds nothing but macOS bookkeeping as
   * still in use, for ever.
   */
  const remaining = (await readdir(legacyRoot).catch(() => null)) ?? [];
  const orphanDirectories = remaining
    .filter((name) => !isFilesystemSidecar(name))
    .filter((name) => !claimed.has(name))
    .sort();

  let legacyRootRemoved = false;
  if (!dryRun && (await directoryExists(legacyRoot))) {
    const left = (await readdir(legacyRoot).catch(() => ["unreadable"])).filter(
      (name) => !isFilesystemSidecar(name),
    );
    if (left.length === 0) {
      // The sidecars go with the root they describe, and only once nothing this
      // server wrote is left beside them.
      await rm(legacyRoot, { recursive: true, force: true }).catch(
        () => undefined,
      );
      legacyRootRemoved = !(await directoryExists(legacyRoot));
    }
  }

  return {
    dryRun,
    legacyRoot,
    outcomes,
    legacyRootRemoved,
    orphanDirectories,
  };

  async function migrateOne(row: LegacyRow): Promise<MigrationOutcome> {
    const base: MigrationOutcome = {
      setId: row.id,
      mediaFileId: row.media_file_id,
      status: "failed",
    };

    const source = path.join(legacyRoot, row.storage_prefix);
    if (
      !isInsideDirectory(legacyRoot, source) ||
      path.resolve(source) === path.resolve(legacyRoot)
    ) {
      return {
        ...base,
        status: "unresolvable",
        detail:
          "The recorded storage prefix does not name a directory inside the old root.",
      };
    }
    base.from = source;

    const file = await catalogue.getFileById(row.media_file_id);
    if (!file) {
      return {
        ...base,
        status: "unresolvable",
        detail: "The media file this set belongs to is no longer catalogued.",
      };
    }
    base.relativePath = file.relativePath;

    const sourcePath = path.resolve(
      resolvedMediaRoot,
      ...file.relativePath.split("/"),
    );
    if (!isInsideDirectory(resolvedMediaRoot, sourcePath)) {
      return {
        ...base,
        status: "unresolvable",
        detail: "The media file resolves outside the media root.",
      };
    }

    const kind = (await catalogue.getItemKind(file.itemId)) ?? "movie";
    const titleRoot = await resolveTitleRoot(
      sourcePath,
      titleRootLayoutForKind(kind),
    );
    if (!isInsideDirectory(resolvedMediaRoot, titleRoot)) {
      return {
        ...base,
        status: "unresolvable",
        detail: "The title root resolves outside the media root.",
      };
    }
    const destination = trickplayDirectoryFor(titleRoot);
    base.to = destination;

    if (!(await directoryExists(source))) {
      return {
        ...base,
        status: "source-missing",
        detail:
          "The old directory this row names is not on disk. The row is left as it is; regenerating the title will replace it.",
      };
    }

    let sourceSummary;
    try {
      sourceSummary = await summariseDirectory(source);
    } catch (error) {
      return {
        ...base,
        status: error instanceof UnsafePathError ? "invalid-source" : "failed",
        detail: (error as Error).message,
      };
    }
    base.files = sourceSummary.files.length;
    base.bytes = sourceSummary.totalBytes;

    // The old set has to be a set before it is worth moving. A row pointing at
    // a half-written directory is not something to carry forward.
    let validatedSource;
    try {
      validatedSource = await validateTrickplayOutput(source, layoutOf(row));
    } catch (error) {
      return {
        ...base,
        status: "invalid-source",
        detail: `The old set does not match its own row: ${(error as Error).message}`,
      };
    }

    if (await directoryExists(destination)) {
      let destinationSummary;
      try {
        destinationSummary = await summariseDirectory(destination);
      } catch (error) {
        return {
          ...base,
          status: "conflict",
          detail: (error as Error).message,
        };
      }
      const comparison = compareSummaries(sourceSummary, destinationSummary);
      if (!comparison.identical) {
        return {
          ...base,
          status: "conflict",
          detail: `The title already holds different trickplay: ${comparison.differences
            .slice(0, 3)
            .join("; ")}`,
        };
      }
      /*
       * Byte-identical: an earlier run published this set and was interrupted
       * before it cleared the row, or before it removed the old directory.
       * Finishing those two steps is what "resume" means here.
       */
      if (dryRun) {
        return {
          ...base,
          status: "already-migrated",
          detail:
            "The title already holds these bytes; the row would be cleared and the old directory removed.",
        };
      }
      await clearStoragePrefix(row.id, validatedSource.spriteCount);
      await rm(source, { recursive: true, force: true }).catch(() => undefined);
      return {
        ...base,
        status: "already-migrated",
        detail:
          "The title already held these bytes; the row and the old directory have been settled.",
      };
    }

    if (dryRun) return { ...base, status: "migrated" };

    /*
     * Staging is named after the set rather than randomly, so an interrupted
     * run's leftovers are reused rather than accumulated. `prepareTrickplayStaging`
     * clears it first: a partial copy from a killed run is not something to
     * resume mid-file.
     */
    const staging = path.join(
      titleRoot,
      `${TRICKPLAY_STAGING_PREFIX}-migrate-${row.id}`,
    );

    try {
      await prepareTrickplayStaging(staging);
      await copyDirectoryTree(source, staging);

      // The copy is compared against the original, every file, by content.
      const stagedSummary = await summariseDirectory(staging);
      const comparison = compareSummaries(sourceSummary, stagedSummary);
      if (!comparison.identical) {
        await discardTrickplayStaging(staging);
        return {
          ...base,
          status: "failed",
          detail: `The copy did not verify: ${comparison.differences.slice(0, 3).join("; ")}`,
        };
      }
      const validatedCopy = await validateTrickplayOutput(
        staging,
        layoutOf(row),
      );

      const published = await publishTrickplayDirectory(titleRoot, staging);
      try {
        await clearStoragePrefix(row.id, validatedCopy.spriteCount);
      } catch (error) {
        await rollbackPublishedTrickplay(published);
        throw error;
      }
      await commitPublishedTrickplay(published);

      // Irreversible, and last. Everything above has already proved the bytes
      // exist in the title folder and that the database points at them.
      await rm(source, { recursive: true, force: true });

      return { ...base, status: "migrated" };
    } catch (error) {
      await discardTrickplayStaging(staging);
      return { ...base, status: "failed", detail: (error as Error).message };
    }
  }

  /**
   * Marks one set as living in its title folder.
   *
   * `sprite_count` is set from the sheets validation counted rather than left at
   * whatever the row said, so the row keeps describing the disk even if the old
   * set had one sheet more or fewer than its row claimed.
   *
   * Sheets, emphatically, and not files in the directory. On this exFAT library
   * every sheet is accompanied by an AppleDouble `._` sidecar, so a file count
   * is twice the sheet count — and a row claiming twice as many sheets as exist
   * sends the seek bar to fetch sheets that were never written.
   */
  async function clearStoragePrefix(
    setId: string,
    spriteCount: number,
  ): Promise<void> {
    await pool.query(
      `UPDATE trickplay_sets
          SET storage_prefix = NULL,
              sprite_count = $2,
              thumbnail_count = LEAST(thumbnail_count, $2 * columns * rows)
        WHERE id = $1`,
      [setId, spriteCount],
    );
  }
}
