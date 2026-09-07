import { mkdir, rename, rm, stat } from "node:fs/promises";
import {
  TRICKPLAY_RETIRED_SUFFIX,
  trickplayDirectoryFor,
} from "./trickplayStorage";

/**
 * Swapping a proven set of sheets into the title's own folder.
 *
 * The invariant this file exists to hold is one sentence long:
 *
 *     an existing valid set plus a failed regeneration
 *     is still an existing valid set.
 *
 * That rules out the obvious implementation. Emptying `trickplay/` and pointing
 * FFmpeg at it destroys a working set the moment the encode is started, and
 * every way the encode can then fail — a bad source, a cancelled job, a volume
 * that goes away mid-decode — leaves the title with nothing where it used to
 * have something.
 *
 * So a generation writes into a staging directory beside the live one, is
 * validated there, and only then changes what `trickplay/` names. The change is
 * two renames within one directory, which is atomic on every filesystem this
 * runs on: the live set is renamed aside, the staged set is renamed into its
 * place, and only once the caller has committed its database row is the old set
 * removed. A reader mid-request keeps reading the bytes it already opened.
 */

export interface PublishedTrickplay {
  directory: string;
  /** Present until `commit`; the previous set, kept so it can be restored. */
  retired: string | null;
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await stat(candidate);
    return true;
  } catch {
    return false;
  }
}

/**
 * Moves `staging` into place as the title's live trickplay.
 *
 * Returns a handle the caller must either `commit` (the database row is
 * written, the old set can go) or `rollback` (something after the swap failed,
 * and the old set must come back). Leaving it un-finished leaves the previous
 * set on disk under a name nothing serves, which is untidy but never lossy.
 */
export async function publishTrickplayDirectory(
  titleRoot: string,
  staging: string,
): Promise<PublishedTrickplay> {
  const live = trickplayDirectoryFor(titleRoot);
  const retired = `${staging}${TRICKPLAY_RETIRED_SUFFIX}`;

  // A leftover from an interrupted run would make the rename below fail, and it
  // holds nothing anyone is serving: it is only ever a previous set that was
  // already superseded.
  await rm(retired, { recursive: true, force: true }).catch(() => undefined);

  const hadLive = await pathExists(live);
  if (hadLive) await rename(live, retired);
  try {
    await rename(staging, live);
  } catch (error) {
    // The live set was renamed aside and its replacement would not go in. Put
    // it back before anything else happens: a title with no sheets at all is a
    // strictly worse outcome than a title with its previous ones.
    if (hadLive) await rename(retired, live).catch(() => undefined);
    throw error;
  }

  return { directory: live, retired: hadLive ? retired : null };
}

/** The new set is durable and recorded; the previous one is no longer needed. */
export async function commitPublishedTrickplay(
  published: PublishedTrickplay,
): Promise<void> {
  if (!published.retired) return;
  await rm(published.retired, { recursive: true, force: true }).catch(
    () => undefined,
  );
}

/**
 * Undoes a swap whose database write did not land.
 *
 * Without this the folder would hold sheets the row does not describe, and the
 * seek bar would compute offsets for the previous geometry against the new
 * sheets — the precise failure the row and the bytes are kept together to
 * prevent.
 */
export async function rollbackPublishedTrickplay(
  published: PublishedTrickplay,
): Promise<void> {
  if (!published.retired) {
    await rm(published.directory, { recursive: true, force: true }).catch(
      () => undefined,
    );
    return;
  }
  await rm(published.directory, { recursive: true, force: true }).catch(
    () => undefined,
  );
  await rename(published.retired, published.directory).catch(() => undefined);
}

/** Creates an empty staging directory, replacing any leftover of the same name. */
export async function prepareTrickplayStaging(staging: string): Promise<void> {
  await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  await mkdir(staging, { recursive: true });
}

export async function discardTrickplayStaging(staging: string): Promise<void> {
  await rm(staging, { recursive: true, force: true }).catch(() => undefined);
}
