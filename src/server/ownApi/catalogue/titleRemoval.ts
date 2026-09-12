/**
 * Removing a title from the library, everything included.
 *
 * "Everything" is the title's own folder (source, renditions, artwork,
 * trickplay, subtitles, NFO), any legacy package kept under the rendition root,
 * its downloads, and every catalogue row that mentions it — watch history
 * included. This is irreversible, which decides the order:
 *
 *  1. The folder is **renamed** out of the library first — one atomic,
 *     same-volume step that either happens or does not. A title in use
 *     (Windows refuses to rename a folder with an open handle) is refused here,
 *     before anything is lost.
 *  2. The catalogue rows are deleted in one transaction.
 *  3. Only then are the staged bytes deleted.
 *
 * A crash after 1 leaves the rows pointing at files that are gone: the title
 * reads as missing and removing it again finishes the job. A crash after 2
 * leaves a `.seyirlik-removing-<id>` folder the scanner ignores (dot-prefixed)
 * and the next removal sweeps. Deleting rows before files would be the wrong
 * way round — a rescan would resurrect the title from its own folder.
 */
import { lstat, readdir, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { DatabasePool } from "../database/databasePool";
import { withTransaction } from "../database/transaction";
import { resolveTitleRoot } from "../metadata/titleRoot";
import { isPathInsideRoot } from "../../pathSecurity";
import {
  loadRenditionRegistry,
  saveRenditionRegistry,
} from "../../../renditions/registry";

export const REMOVAL_STAGING_PREFIX = ".seyirlik-removing-";

export class TitleRemovalError extends Error {
  constructor(
    readonly code: "not-found" | "confirmation" | "busy" | "unsafe",
    message: string,
  ) {
    super(message);
    this.name = "TitleRemovalError";
  }
}

export interface TitleRemovalReport {
  itemId: string;
  title: string;
  /** The folder removed, relative to the media root; null when there was none. */
  folder: string | null;
  filesRemoved: number;
  downloadsCancelled: number;
  /** Paths that could not be deleted after the catalogue let go of them. */
  leftovers: string[];
}

export interface TitleRemovalDependencies {
  pool: DatabasePool;
  mediaRoot: string;
  renditionRoot: string;
  stateRoot: string;
  /** Cancels a download and deletes what it fetched. Absent when no client is configured. */
  cancelAcquisition?: (acquisitionId: string) => Promise<void>;
  /** Removes cached artwork that does not live in the title's own folder. */
  removeImage?: (storageKey: string) => Promise<void>;
}

const ACTIVE_ACQUISITION = `a.state NOT IN ('downloaded', 'cancelled', 'superseded', 'failed')`;

function errno(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function comparable(relative: string): string {
  return relative.replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase();
}

/** Deletes a tree, tolerating Windows' brief holds on freshly closed files. */
async function removeTree(target: string): Promise<boolean> {
  try {
    await rm(target, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    });
    return true;
  } catch {
    return false;
  }
}

export function createTitleRemoval(dependencies: TitleRemovalDependencies) {
  const mediaRoot = path.resolve(dependencies.mediaRoot);

  /** An absolute path for a media-root-relative one, or undefined if it escapes. */
  function contained(relative: string): string | undefined {
    const absolute = path.resolve(mediaRoot, relative);
    return isPathInsideRoot(mediaRoot, absolute) ? absolute : undefined;
  }

  /**
   * Staged folders whose title no longer exists. Left behind only by a crash
   * between the commit and the delete, so this is usually a no-op readdir.
   */
  async function sweepStaged(libraryRoots: readonly string[]) {
    const leftovers: string[] = [];
    for (const root of libraryRoots) {
      const directory = contained(root);
      if (!directory) continue;
      let names: string[];
      try {
        names = await readdir(directory);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!name.startsWith(REMOVAL_STAGING_PREFIX)) continue;
        const id = name.slice(REMOVAL_STAGING_PREFIX.length);
        if (!/^[0-9a-f-]{36}$/i.test(id)) continue;
        const exists = await dependencies.pool.query(
          "SELECT 1 FROM items WHERE id = $1",
          [id],
        );
        if (exists.rows.length) continue;
        const staged = path.join(directory, name);
        if (!(await removeTree(staged)))
          leftovers.push(path.relative(mediaRoot, staged));
      }
    }
    return leftovers;
  }

  /**
   * The title's own folder, only if it is provably the title's alone.
   *
   * Two library roots, a loose file in a library root, or a folder another
   * title also keeps files in, all yield undefined — the removal then deletes
   * the title's recorded files one by one instead of a directory.
   */
  async function ownedFolder(
    item: { id: string; kind: string; source_key: string },
    paths: readonly string[],
    libraryRoots: readonly string[],
  ): Promise<string | undefined> {
    const folder = resolveTitleRoot({
      kind: item.kind,
      sourceKey: item.source_key,
      primaryRelativePath: paths[0] ?? null,
      descendantRelativePath: paths[0] ?? null,
    });
    if (!folder) return undefined;
    const segments = folder.split("/").filter(Boolean);
    if (segments.length < 2) return undefined;
    const key = comparable(folder);
    if (libraryRoots.some((root) => comparable(root) === key)) return undefined;
    if (!libraryRoots.some((root) => key.startsWith(`${comparable(root)}/`)))
      return undefined;
    // Every recorded file of this title must be inside it…
    if (!paths.every((relative) => comparable(relative).startsWith(`${key}/`)))
      return undefined;
    // …and no other title may keep anything there.
    const foreign = await dependencies.pool.query(
      `WITH RECURSIVE family AS (
         SELECT id FROM items WHERE id = $1
         UNION SELECT child.id FROM items child JOIN family ON child.parent_id = family.id OR child.series_id = family.id)
       SELECT 1 FROM media_files f WHERE f.item_id NOT IN (SELECT id FROM family)
         AND lower(replace(f.relative_path, '\\', '/')) LIKE $2 ESCAPE '!' LIMIT 1`,
      [item.id, `${key.replace(/[!%_]/g, "!$&")}/%`],
    );
    return foreign.rows.length ? undefined : folder;
  }

  async function pruneRegistry(folder: string | null, files: string[]) {
    const registryPath = path.join(dependencies.stateRoot, "registry.json");
    const prefix = folder ? `${comparable(folder)}/` : null;
    const exact = new Set(files.map(comparable));
    const registry = await loadRenditionRegistry(registryPath);
    const removed = registry.items.filter((entry) => {
      const relative = comparable(entry.relativePath);
      return exact.has(relative) || (prefix && relative.startsWith(prefix));
    });
    if (removed.length === 0) return [];
    registry.items = registry.items.filter((entry) => !removed.includes(entry));
    await saveRenditionRegistry(registryPath, registry);
    return removed.map((entry) => entry.id);
  }

  return {
    async remove(
      itemId: string,
      confirmation: string,
    ): Promise<TitleRemovalReport> {
      const found = await dependencies.pool.query<{
        id: string;
        kind: string;
        title: string;
        source_key: string;
      }>(
        "SELECT id, kind, title, source_key FROM items WHERE id = $1 AND kind IN ('movie', 'series', 'book')",
        [itemId],
      );
      const item = found.rows[0];
      if (!item)
        throw new TitleRemovalError("not-found", "No such movie or show.");
      // Typed, not clicked: the title is the one thing a mis-aimed click cannot supply.
      if (confirmation.trim() !== item.title.trim())
        throw new TitleRemovalError(
          "confirmation",
          "Type the title exactly to confirm the removal.",
        );

      const family = `WITH RECURSIVE family AS (
          SELECT id FROM items WHERE id = $1
          UNION SELECT child.id FROM items child JOIN family ON child.parent_id = family.id OR child.series_id = family.id)`;
      const [
        processing,
        importing,
        downloads,
        files,
        roots,
        installed,
        artwork,
      ] = await Promise.all([
        dependencies.pool.query(
          `${family} SELECT 1 FROM processing_jobs WHERE item_id IN (SELECT id FROM family)
             AND state IN ('pending', 'queued', 'running', 'paused') LIMIT 1`,
          [itemId],
        ),
        dependencies.pool.query(
          `${family} SELECT 1 FROM imports WHERE target_item_id IN (SELECT id FROM family)
             AND state NOT IN ('complete', 'cancelled', 'failed') LIMIT 1`,
          [itemId],
        ),
        dependencies.pool.query<{ id: string }>(
          `${family} SELECT a.id FROM acquisitions a WHERE a.target_item_id IN (SELECT id FROM family) AND ${ACTIVE_ACQUISITION}`,
          [itemId],
        ),
        dependencies.pool.query<{ relative_path: string }>(
          `${family} SELECT relative_path FROM media_files WHERE item_id IN (SELECT id FROM family)
             ORDER BY is_primary DESC, size_bytes DESC`,
          [itemId],
        ),
        dependencies.pool.query<{ relative_path: string }>(
          "SELECT relative_path FROM library_roots",
        ),
        dependencies.pool.query<{ relative_path: string }>(
          `${family} SELECT si.relative_path FROM subtitle_installations si
             JOIN media_files f ON f.id = si.media_file_id WHERE f.item_id IN (SELECT id FROM family)`,
          [itemId],
        ),
        // Title-owned artwork is how a wanted title with no files has a folder.
        dependencies.pool.query<{ relative_path: string }>(
          `${family} SELECT substr(storage_key, 7) AS relative_path FROM item_images
             WHERE item_id IN (SELECT id FROM family) AND storage_key LIKE 'media:%'`,
          [itemId],
        ),
      ]);
      if (processing.rows.length)
        throw new TitleRemovalError(
          "busy",
          "This title is being processed. Cancel its processing jobs first.",
        );
      if (importing.rows.length)
        throw new TitleRemovalError(
          "busy",
          "A download of this title is being imported. Try again when it finishes.",
        );
      if (downloads.rows.length && !dependencies.cancelAcquisition)
        throw new TitleRemovalError(
          "busy",
          "This title is downloading and no download client is configured to cancel it.",
        );

      const libraryRoots = roots.rows.map((row) => row.relative_path);
      const leftovers = await sweepStaged(libraryRoots);
      const filePaths = files.rows.map((row) => row.relative_path);
      const folder =
        (await ownedFolder(
          item,
          [...filePaths, ...artwork.rows.map((row) => row.relative_path)],
          libraryRoots,
        )) ?? null;

      // Downloads go first: a download left running would import the title
      // straight back into the library it was just removed from.
      for (const download of downloads.rows)
        await dependencies.cancelAcquisition!(download.id);

      /* ---- 1. stage: take the folder out of the library, atomically. ---- */
      let staged: string | undefined;
      const looseFiles: string[] = [];
      if (folder) {
        const absolute = contained(folder);
        if (!absolute)
          throw new TitleRemovalError(
            "unsafe",
            "The title folder is outside the library.",
          );
        let present = true;
        try {
          const stats = await lstat(absolute);
          // A link would make the delete follow somebody else's directory.
          if (stats.isSymbolicLink() || !stats.isDirectory())
            throw new TitleRemovalError(
              "unsafe",
              "The title folder is a link, not a folder. Remove it by hand.",
            );
          const real = await realpath(absolute);
          if (!isPathInsideRoot(await realpath(mediaRoot), real))
            throw new TitleRemovalError(
              "unsafe",
              "The title folder resolves outside the library.",
            );
        } catch (error) {
          if (error instanceof TitleRemovalError) throw error;
          if (errno(error) !== "ENOENT") throw error;
          present = false;
        }
        staged = path.join(
          path.dirname(absolute),
          `${REMOVAL_STAGING_PREFIX}${item.id}`,
        );
        if (present) {
          // An earlier, interrupted removal of this same title may have
          // staged its folder already; those bytes were already on their way out.
          await removeTree(staged);
          try {
            await rename(absolute, staged);
          } catch (error) {
            if (["EBUSY", "EPERM", "EACCES"].includes(errno(error) ?? ""))
              throw new TitleRemovalError(
                "busy",
                "The title's files are in use — stop any playback and try again.",
              );
            throw error;
          }
        }
      } else {
        for (const relative of [
          ...filePaths,
          ...installed.rows.map((row) => row.relative_path),
        ]) {
          const absolute = contained(relative);
          if (absolute) looseFiles.push(absolute);
        }
      }

      /* ---- 2. forget: every row that mentions the title, in one transaction. ---- */
      const cachedImages = await withTransaction(
        dependencies.pool,
        async (transaction) => {
          const locked = await transaction.query(
            "SELECT id FROM items WHERE id = $1 FOR UPDATE",
            [itemId],
          );
          if (!locked.rows.length) return [];
          // Artwork kept outside the title folder is collected before its rows go.
          const images = await transaction.query<{ storage_key: string }>(
            `${family} SELECT DISTINCT storage_key FROM item_images i WHERE i.item_id IN (SELECT id FROM family)
           AND storage_key NOT LIKE 'media:%'
           AND NOT EXISTS (SELECT 1 FROM item_images other WHERE other.storage_key = i.storage_key
             AND other.item_id NOT IN (SELECT id FROM family))`,
            [itemId],
          );
          await transaction.query(
            `${family} DELETE FROM acquisitions WHERE target_item_id IN (SELECT id FROM family)`,
            [itemId],
          );
          await transaction.query(
            `${family} DELETE FROM imports WHERE target_item_id IN (SELECT id FROM family)`,
            [itemId],
          );
          await transaction.query(
            `${family} DELETE FROM activity_events WHERE item_id IN (SELECT id FROM family)`,
            [itemId],
          );
          // Seasons, episodes, files, streams, jobs, subtitles, watch state and
          // monitoring all cascade from the title row.
          await transaction.query("DELETE FROM items WHERE id = $1", [itemId]);
          return images.rows.map((row) => row.storage_key);
        },
      );

      /* ---- 3. delete: the bytes nothing refers to any more. ---- */
      for (const key of cachedImages)
        await dependencies.removeImage?.(key).catch(() => undefined);
      let filesRemoved = 0;
      if (staged) {
        if (await removeTree(staged)) filesRemoved += filePaths.length;
        else leftovers.push(path.relative(mediaRoot, staged));
      }
      const realRoot = looseFiles.length ? await realpath(mediaRoot) : "";
      for (const file of looseFiles) {
        try {
          // A junction on the way would make an in-library path land outside it.
          const parent = await realpath(path.dirname(file)).catch(() => null);
          if (parent === null) continue;
          if (
            !isPathInsideRoot(realRoot, path.join(parent, path.basename(file)))
          ) {
            leftovers.push(path.relative(mediaRoot, file));
            continue;
          }
          await rm(file, { force: true, maxRetries: 5, retryDelay: 200 });
          filesRemoved += 1;
        } catch {
          leftovers.push(path.relative(mediaRoot, file));
        }
      }
      try {
        // Best effort: an encode running for another title rewrites the
        // registry from its own copy and may restore these records, which is
        // harmless — nothing in the catalogue points at them any more.
        for (const id of await pruneRegistry(folder, filePaths)) {
          if (!/^[0-9a-f-]{36}$/i.test(id)) continue;
          const legacy = path.join(dependencies.renditionRoot, id);
          if (!(await removeTree(legacy))) leftovers.push(legacy);
        }
      } catch {
        leftovers.push(path.join(dependencies.stateRoot, "registry.json"));
      }

      return {
        itemId,
        title: item.title,
        folder,
        filesRemoved,
        downloadsCancelled: downloads.rows.length,
        leftovers,
      };
    },
  };
}

export type TitleRemoval = ReturnType<typeof createTitleRemoval>;
