/**
 * What cleanup may take, and what it must never take.
 *
 * The rule used to be simple because the work was worthless: a package was one
 * transaction, so a work directory nobody was holding a lock on was abandoned
 * rubbish and could go. That rule is now dangerous. A work directory can hold
 * fifty minutes of validated, immutable encoding that a job is going to resume
 * from, and "older than twenty-four hours" describes exactly the job that was
 * interrupted by a drive being unplugged over a weekend — the case checkpoints
 * exist for.
 *
 * So cleanup became specific rather than sweeping. It removes work that is
 * provably not reusable: partial epochs nobody is writing, staging directories
 * from attempts that have ended, and whole builds keyed to a profile version or
 * a source fingerprint that no longer exists. A valid completed checkpoint is
 * never removed by this command, at any age.
 */

import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { EPOCH_MANIFEST_FILE, parseCompletedEpochDirectory } from "./policy";
import { listPartialEpochs } from "./checkpoints";

export type CleanupAction =
  | "skipped-active-lock"
  | "skipped-active-epoch"
  | "kept-checkpoints"
  | "removed-abandoned-epoch"
  | "removed-stale-staging"
  | "removed-obsolete-build"
  | "removed-empty-workspace";

export interface CleanupEntry {
  /** Path relative to the work root, so logs carry no absolute paths. */
  path: string;
  action: CleanupAction;
  /** Checkpoints this build still holds, when any were kept. */
  keptEpochs?: number;
}

export interface CleanupWorkInput {
  workRoot: string;
  /**
   * The adaptive profile a build must be keyed to in order to be reusable.
   * Anything else describes a package this server can no longer produce.
   */
  profileVersion: string;
  /**
   * Whether a media id still has work that could resume. A build for a source
   * the library no longer knows about is not resumable by anyone.
   */
  isKnownMedia?: (mediaId: string) => boolean;
  /** Whether a lock file says somebody is actively working on this media id. */
  hasActiveLock: (mediaId: string) => Promise<boolean>;
  dryRun?: boolean;
}

/** Directory names inside `workRoot/<mediaId>` that are attempt scratch space. */
const STAGING_SUFFIX = ".partial";

/**
 * Removes only what is provably not reusable.
 *
 * Deliberately takes no age threshold for checkpoints. Age is evidence about
 * staging directories, which belong to one attempt and are worthless the moment
 * it ends; it is no evidence at all about a checkpoint, which is exactly as
 * useful a week later as it was when it was written.
 */
export async function cleanupAdaptiveWork({
  workRoot,
  profileVersion,
  isKnownMedia,
  hasActiveLock,
  dryRun = false,
}: CleanupWorkInput): Promise<CleanupEntry[]> {
  const entries: CleanupEntry[] = [];
  const remove = async (target: string): Promise<void> => {
    if (!dryRun) await rm(target, { recursive: true, force: true });
  };

  let mediaEntries;
  try {
    mediaEntries = await readdir(workRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return entries;
    throw error;
  }

  for (const mediaEntry of mediaEntries) {
    if (!mediaEntry.isDirectory() || mediaEntry.isSymbolicLink()) continue;
    const mediaId = mediaEntry.name;
    const mediaWorkRoot = path.join(workRoot, mediaId);

    if (await hasActiveLock(mediaId)) {
      entries.push({ path: mediaId, action: "skipped-active-lock" });
      continue;
    }

    const known = isKnownMedia?.(mediaId) ?? true;
    let remaining = 0;

    for (const child of await readdir(mediaWorkRoot, { withFileTypes: true })) {
      if (!child.isDirectory() || child.isSymbolicLink()) continue;
      const childPath = path.join(mediaWorkRoot, child.name);
      const relative = `${mediaId}/${child.name}`;

      /*
       * A staging directory belongs to one attempt. Once no lock is held the
       * attempt has ended, so whatever it managed to assemble is unreachable —
       * the checkpoints it was assembled from are the durable copy.
       */
      if (child.name.includes(STAGING_SUFFIX)) {
        entries.push({ path: relative, action: "removed-stale-staging" });
        await remove(childPath);
        continue;
      }

      /*
       * A build directory is named `<profileVersion>-<fingerprintPrefix>`. One
       * keyed to a profile this server no longer produces cannot be joined to
       * anything it would build today, so it is obsolete rather than merely
       * old.
       */
      if (!child.name.startsWith(`${profileVersion}-`) || !known) {
        entries.push({ path: relative, action: "removed-obsolete-build" });
        await remove(childPath);
        continue;
      }

      const kept = await cleanBuildDirectory(
        childPath,
        entries,
        relative,
        remove,
      );
      if (kept.active) {
        entries.push({ path: relative, action: "skipped-active-epoch" });
        remaining += 1;
        continue;
      }
      if (kept.completed > 0) {
        entries.push({
          path: relative,
          action: "kept-checkpoints",
          keptEpochs: kept.completed,
        });
        remaining += 1;
        continue;
      }
      /*
       * Nothing durable left. The plan alone is not worth keeping: it is
       * regenerated deterministically from the source on the next run.
       */
      entries.push({ path: relative, action: "removed-obsolete-build" });
      await remove(childPath);
    }

    if (remaining === 0) {
      entries.push({ path: mediaId, action: "removed-empty-workspace" });
      await remove(mediaWorkRoot);
    }
  }

  return entries;
}

async function cleanBuildDirectory(
  buildRoot: string,
  entries: CleanupEntry[],
  relative: string,
  remove: (target: string) => Promise<void>,
): Promise<{ completed: number; active: boolean }> {
  let completed = 0;
  let active = false;

  for (const partial of await listPartialEpochs(buildRoot)) {
    if (partial.active) {
      active = true;
      continue;
    }
    entries.push({
      path: `${relative}/epochs/${partial.name}`,
      action: "removed-abandoned-epoch",
    });
    await remove(partial.directory);
  }

  const epochsDirectory = path.join(buildRoot, "epochs");
  for (const entry of await readdir(epochsDirectory, {
    withFileTypes: true,
  }).catch(() => [])) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    if (parseCompletedEpochDirectory(entry.name) === null) continue;
    /*
     * A completed directory with no manifest is not a checkpoint — nothing can
     * prove what it contains — so it is removed here rather than kept for ever
     * as work that resume will never use.
     */
    const manifest = await stat(
      path.join(epochsDirectory, entry.name, EPOCH_MANIFEST_FILE),
    ).catch(() => undefined);
    if (manifest?.isFile()) {
      completed += 1;
      continue;
    }
    entries.push({
      path: `${relative}/epochs/${entry.name}`,
      action: "removed-abandoned-epoch",
    });
    await remove(path.join(epochsDirectory, entry.name));
  }

  return { completed, active };
}
