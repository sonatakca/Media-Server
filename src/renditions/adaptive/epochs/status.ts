/**
 * What a title's durable work looks like, for `status` and for diagnostics.
 *
 * Reads the checkpoints rather than any record of them, because the filesystem
 * is the only thing that survives everything else. A status command that read a
 * database would answer confidently after a crash that took the disk with it.
 */

import {
  checkpointRoot,
  listCompletedEpochIndexes,
  listPartialEpochs,
  readEpochManifest,
  readEpochPlanFile,
} from "./checkpoints";
import { protectedSecondsAfter } from "./plan";

export interface CheckpointSummary {
  /** Present only when a build directory for this source and profile exists. */
  present: boolean;
  epochCount: number;
  completedEpochs: number;
  /** Media time a crash could not take away. */
  protectedSeconds: number;
  /** The epoch a resumed run would start on, or null when there is nothing left. */
  nextEpochIndex: number | null;
  /** A workspace another attempt is writing right now. */
  activePartials: number;
  bytes: number;
}

const EMPTY: CheckpointSummary = {
  present: false,
  epochCount: 0,
  completedEpochs: 0,
  protectedSeconds: 0,
  nextEpochIndex: null,
  activePartials: 0,
  bytes: 0,
};

/**
 * Summarises one title's checkpoints.
 *
 * Only a *contiguous* run from the beginning counts as protected. Epoch seven
 * being complete while epoch three is missing protects nothing: the title
 * cannot be assembled up to seven, and reporting it as protected would tell an
 * operator their work is safe further along than it is.
 */
export async function summariseCheckpoints({
  workRoot,
  mediaId,
  profileVersion,
  sourceFingerprint,
}: {
  workRoot: string;
  mediaId: string;
  profileVersion: string;
  sourceFingerprint: string;
}): Promise<CheckpointSummary> {
  const root = checkpointRoot(
    workRoot,
    mediaId,
    profileVersion,
    sourceFingerprint,
  );
  const plan = await readEpochPlanFile(root);
  if (!plan) return EMPTY;

  const completed = new Set(await listCompletedEpochIndexes(root));
  let contiguous = 0;
  while (contiguous < plan.epochs.length && completed.has(contiguous)) {
    contiguous += 1;
  }

  let bytes = 0;
  for (const index of completed) {
    const manifest = await readEpochManifest(root, index);
    if (manifest) bytes += manifest.totalBytes;
  }

  const partials = await listPartialEpochs(root);

  return {
    present: true,
    epochCount: plan.epochs.length,
    completedEpochs: completed.size,
    protectedSeconds: protectedSecondsAfter(plan, contiguous),
    nextEpochIndex: contiguous < plan.epochs.length ? contiguous : null,
    activePartials: partials.filter((partial) => partial.active).length,
    bytes,
  };
}
