import {
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { storageIdentity } from "./processing/storageWatchdog";
import {
  describeMedium,
  satisfiesRecovery,
  type StorageIdentityProbe,
  type VolumeIdentity,
} from "./processing/storageIdentity";

/**
 * The three storage roles involved in one media build.
 *
 * `sourceRoot` and `finalRoot` are presently the same library volume, but they
 * are named separately here because they have opposite access contracts: the
 * source is read-only while the final root is written only by publication.
 */
export interface ProcessingStorageRoles {
  sourceRoot: string;
  scratchRoot: string;
  finalRoot: string;
  jobsRoot: string;
  logsRoot: string;
  explicitlyConfigured: boolean;
}

export const SCRATCH_OWNER_FILE = ".seyirlik-scratch.json";
export const JOB_WORKSPACE_OWNER_FILE = ".seyirlik-job.json";

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function requireAbsolute(name: string, value: string): string {
  if (!path.isAbsolute(value)) {
    throw new Error(`${name} must be an absolute path.`);
  }
  return path.resolve(value);
}

/**
 * Resolves and prepares storage roots once, before a worker can claim a job.
 *
 * An explicitly configured scratch root is never substituted. If it is absent
 * later, the watchdog pauses work against that exact path; it does not fall
 * back to the library volume or the system temporary directory.
 */
export async function prepareProcessingStorageRoles({
  mediaRoot,
  scratchRoot,
  legacyWorkRoot,
  legacyLogsRoot,
  allowUnavailable = false,
}: {
  mediaRoot: string;
  scratchRoot?: string;
  legacyWorkRoot: string;
  legacyLogsRoot: string;
  allowUnavailable?: boolean;
}): Promise<ProcessingStorageRoles> {
  const finalRoot = requireAbsolute("SEYIRLIK_MEDIA_ROOT", mediaRoot);
  const explicit = scratchRoot?.trim();

  if (!explicit) {
    return {
      sourceRoot: finalRoot,
      scratchRoot: path.dirname(legacyWorkRoot),
      finalRoot,
      jobsRoot: legacyWorkRoot,
      logsRoot: legacyLogsRoot,
      explicitlyConfigured: false,
    };
  }

  const resolvedScratch = requireAbsolute(
    "SEYIRLIK_PROCESSING_SCRATCH_ROOT",
    explicit,
  );
  let realMedia: string;
  let realScratch: string;
  try {
    [realMedia, realScratch] = await Promise.all([
      realpath(finalRoot),
      realpath(resolvedScratch),
    ]);
  } catch (error) {
    if (!allowUnavailable) {
      throw new Error(
        "SEYIRLIK_PROCESSING_SCRATCH_ROOT must point to a mounted, existing directory.",
        { cause: error },
      );
    }
    realMedia = path.resolve(finalRoot);
    realScratch = resolvedScratch;
  }
  if (isInside(realMedia, realScratch) || isInside(realScratch, realMedia)) {
    throw new Error(
      "SEYIRLIK_PROCESSING_SCRATCH_ROOT must not equal, contain, or be nested inside SEYIRLIK_MEDIA_ROOT.",
    );
  }

  const stats = await stat(realScratch).catch(() => null);
  if (stats && !stats.isDirectory()) {
    throw new Error("SEYIRLIK_PROCESSING_SCRATCH_ROOT must be a directory.");
  }

  const jobsRoot = path.join(realScratch, "jobs");
  const logsRoot = path.join(realScratch, "logs");
  if (stats) {
    await Promise.all([
      mkdir(jobsRoot, { recursive: true }),
      mkdir(logsRoot, { recursive: true }),
    ]);
  }
  if (stats)
    await writeFile(
      path.join(realScratch, SCRATCH_OWNER_FILE),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          owner: "seyirlik-processing-scratch",
          sourceRoot: realMedia,
        },
        null,
        2,
      )}\n`,
      { encoding: "utf8", flag: "wx" },
    ).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });

  return {
    sourceRoot: realMedia,
    scratchRoot: realScratch,
    finalRoot: realMedia,
    jobsRoot,
    logsRoot,
    explicitlyConfigured: true,
  };
}

/** A job/workspace id reduced to one safe path component. */
export function assertWorkspaceId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new Error(
      "The processing workspace id is not a safe path component.",
    );
  }
  return value;
}

/** Proves a deletion target is a direct child owned by the configured jobs root. */
export function assertOwnedJobWorkspace(
  jobsRoot: string,
  workspace: string,
): string {
  const root = path.resolve(jobsRoot);
  const target = path.resolve(workspace);
  if (path.dirname(target) !== root || target === root) {
    throw new Error(
      "Refusing to remove a path that is not an owned job workspace.",
    );
  }
  assertWorkspaceId(path.basename(target));
  return target;
}

/**
 * Takes ownership of one job's scratch workspace, reusing what it already
 * holds when that work still describes the same source.
 *
 * Ownership and content identity are deliberately separate questions here.
 * `workspaceId` is ownership: a directory claimed by another job is never
 * touched, because deleting it would destroy work this job cannot see.
 * `sourceFingerprint` is content: when it differs, the directory is this job's
 * own leftovers from a source file that has since been replaced, and every
 * checkpoint in it describes frames the new source does not contain. Treating
 * that second case as a foreign workspace — which is what it did at first —
 * left a job permanently unable to start after its source was re-ripped, with
 * an error blaming a different job that did not exist.
 */
export async function claimJobWorkspace(
  jobsRoot: string,
  workspace: string,
  owner: { workspaceId: string; sourceFingerprint: string },
  {
    probeIdentity,
    expectedIdentity,
  }: {
    probeIdentity?: StorageIdentityProbe;
    /**
     * The volume this job recorded the first time it claimed scratch.
     *
     * Present only for a job that is resuming, and it is the whole of the
     * cross-process story. `st_dev` cannot serve here — it is deliberately not
     * persisted, and it is recycled between mounts — and the ownership marker
     * cannot either, because it lives *on* the volume and so is missing in
     * exactly the situation that needs answering: the disk is absent and the
     * mountpoint pathname now resolves to the filesystem underneath it.
     *
     * Checked before anything is created. A recovering job that finds the
     * wrong volume, or no volume, must leave the parent filesystem exactly as
     * it found it.
     */
    expectedIdentity?: VolumeIdentity | null;
  } = {},
): Promise<ClaimedWorkspace> {
  const target = assertOwnedJobWorkspace(jobsRoot, workspace);

  if (expectedIdentity?.volumeUuid) {
    /*
     * The scratch root rather than the workspace: the workspace is what we are
     * deciding whether to create, and asking about a path that does not exist
     * yet would answer about its parent — which is the mistake this prevents.
     */
    const current = probeIdentity
      ? await probeIdentity(jobsRoot).catch(() => null)
      : null;
    const verdict = satisfiesRecovery(expectedIdentity, current);
    if (!verdict.ok) {
      throw new ScratchStorageLostError(target, verdict.reason);
    }
  }

  await mkdir(target, { recursive: true });
  const marker = path.join(target, JOB_WORKSPACE_OWNER_FILE);
  const existing = await readFile(marker, "utf8").catch(() => null);
  if (existing) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(existing) as Record<string, unknown>;
    } catch (error) {
      throw new Error(
        "The scratch workspace has an unreadable ownership marker.",
        { cause: error },
      );
    }
    if (
      parsed.owner !== "seyirlik-processing-job" ||
      parsed.workspaceId !== owner.workspaceId
    ) {
      throw new Error(
        "The scratch workspace belongs to a different processing job.",
      );
    }
    if (parsed.sourceFingerprint === owner.sourceFingerprint) {
      return finishClaim(target, owner.workspaceId, probeIdentity);
    }
    /*
     * Same job, different source bytes. The directory is re-created rather
     * than emptied so that nothing from the previous source — a half-written
     * epoch, a verified-package marker — can be mistaken for this build's.
     */
    await rm(target, { recursive: true, force: true });
    await mkdir(target, { recursive: true });
  }
  await writeFile(
    marker,
    `${JSON.stringify({ schemaVersion: 1, owner: "seyirlik-processing-job", ...owner })}\n`,
    { encoding: "utf8", flag: "wx" },
  );
  return finishClaim(target, owner.workspaceId, probeIdentity);
}

/** Reads the device the freshly claimed workspace is actually sitting on. */
async function finishClaim(
  directory: string,
  workspaceId: string,
  probeIdentity?: StorageIdentityProbe,
): Promise<ClaimedWorkspace> {
  const deviceId = await storageIdentity(directory);
  if (deviceId === null) {
    throw new ScratchStorageLostError(
      directory,
      "it disappeared while it was being claimed",
    );
  }
  const identity = probeIdentity
    ? await probeIdentity(directory).catch(() => null)
    : null;
  return {
    directory,
    workspaceId,
    deviceId,
    identity,
    ...(probeIdentity ? { probeIdentity } : {}),
  };
}

/**
 * A scratch workspace bound to the filesystem that was mounted when it was
 * claimed.
 *
 * `deviceId` is `st_dev`, read through the same `storageIdentity` the storage
 * watchdog uses, and it is held **in memory for the life of the claim only**.
 * It is never written to disk, because `st_dev` names a mount slot rather than
 * a volume: detaching one image and attaching a different one hands the second
 * the number the first had, and re-attaching the first gives it a new one.
 * Persisting it would produce both false matches and false alarms.
 *
 * In-process, over one job, it is exactly the right question — "does this path
 * still resolve to the filesystem I claimed?" — and it is the only check that
 * catches the case a path test cannot: an unmounted volume whose mountpoint
 * pathname has been recreated on the parent filesystem, where everything
 * exists, everything is writable, and none of it is the disk the operator
 * configured.
 */
export interface ClaimedWorkspace {
  directory: string;
  workspaceId: string;
  /** `st_dev` of the workspace at claim time. In-process only. */
  deviceId: number;
  /**
   * The volume this job claimed, when the deployment can identify volumes.
   *
   * The persistent counterpart to `deviceId`, and the same `VolumeIdentity`
   * the storage-incident store records: a UUID that survives remount and
   * reboot, plus the medium, which is what tells physical external media from
   * a disk image mounted at the same path. Optional because the probe is
   * injected — a deployment without one is checked on device and marker alone,
   * which is what the gap this closes actually required.
   */
  identity?: VolumeIdentity | null;
  /** Retained so the identity can be re-read at stage boundaries. */
  probeIdentity?: StorageIdentityProbe;
}

/**
 * Raised when scratch is no longer the filesystem the job claimed.
 *
 * Its own class so callers do not have to infer a storage condition from the
 * wording of a message: this is always a recoverable interruption and never a
 * defect in the encode.
 */
export class ScratchStorageLostError extends Error {
  readonly workspace: string;
  constructor(workspace: string, detail: string) {
    super(
      `The processing scratch workspace ${workspace} is no longer on the filesystem this job claimed: ${detail}`,
    );
    this.name = "ScratchStorageLostError";
    this.workspace = workspace;
  }
}

/**
 * Proves the scratch workspace this job claimed is still the one it claimed.
 *
 * Two independent facts, because either alone can be satisfied by the wrong
 * disk. The **device** must be the one seen at claim time, which rules out a
 * recreated pathname on the parent filesystem and a different volume mounted
 * at the same place. The **ownership marker** must still be there and still
 * name this job, which rules out the workspace having been cleared underneath
 * a job that is still using it.
 *
 * Without the device half, a job whose configured volume was unplugged carried
 * on encoding onto the internal disk and published the result, because `mkdir`
 * with `recursive` had rebuilt every path it needed and the storage watchdog,
 * polling a path that now existed again, agreed that all was well.
 */
export async function assertClaimedWorkspace(
  claim: ClaimedWorkspace,
  { deep = false }: { deep?: boolean } = {},
): Promise<void> {
  const device = await storageIdentity(claim.directory);
  if (device === null) {
    throw new ScratchStorageLostError(
      claim.directory,
      "it cannot be read as a directory",
    );
  }
  if (device !== claim.deviceId) {
    throw new ScratchStorageLostError(
      claim.directory,
      `it is now on device ${device}, not the device ${claim.deviceId} it was claimed on`,
    );
  }

  const marker = path.join(claim.directory, JOB_WORKSPACE_OWNER_FILE);
  const raw = await readFile(marker, "utf8").catch(() => null);
  if (raw === null) {
    throw new ScratchStorageLostError(
      claim.directory,
      "its ownership marker is gone",
    );
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new ScratchStorageLostError(
      claim.directory,
      "its ownership marker is unreadable",
    );
  }
  if (
    parsed.owner !== "seyirlik-processing-job" ||
    parsed.workspaceId !== claim.workspaceId
  ) {
    throw new ScratchStorageLostError(
      claim.directory,
      "its ownership marker now names another job",
    );
  }

  /*
   * The volume's own identity, asked for only at stage boundaries.
   *
   * `deviceId` above already catches the case this feature exists for, and it
   * costs a `stat`. This costs a subprocess, so it is not put in front of every
   * directory creation; it is asked before the few operations that are about to
   * spend hours or move hundreds of gigabytes, where the cost is nothing and
   * being sure is worth something.
   */
  if (!deep || !claim.probeIdentity || !claim.identity?.volumeUuid) return;
  const current = await claim.probeIdentity(claim.directory).catch(() => null);
  // A probe that cannot answer is not evidence of a swap; the device and the
  // marker have both already agreed this is the right filesystem.
  if (!current?.volumeUuid) return;
  if (current.volumeUuid !== claim.identity.volumeUuid) {
    throw new ScratchStorageLostError(
      claim.directory,
      "a different volume is mounted where this job's scratch was claimed",
    );
  }
  if (current.medium !== claim.identity.medium) {
    throw new ScratchStorageLostError(
      claim.directory,
      `the volume there is now ${describeMedium(current.medium)}, not ${describeMedium(claim.identity.medium)}`,
    );
  }
}

/**
 * Creates a directory beneath the claimed workspace, identity first.
 *
 * Every scratch directory a job makes goes through here. `mkdir` with
 * `recursive` is the mechanism that rebuilds a vanished scratch hierarchy
 * somewhere else — it cannot tell "this parent is missing because nothing has
 * created it yet" from "this parent is missing because the disk was unplugged"
 * — so the identity question is answered before it is allowed to run, and the
 * target is confined to the workspace so no call site can wander outside it.
 */
export async function mkdirWithinWorkspace(
  claim: ClaimedWorkspace,
  directory: string,
): Promise<void> {
  const root = path.resolve(claim.directory);
  const target = path.resolve(directory);
  if (target !== root && !isInside(root, target)) {
    throw new Error(
      `Refusing to create ${directory}, which is outside the job workspace.`,
    );
  }
  await assertClaimedWorkspace(claim);
  await mkdir(target, { recursive: true });
}

export async function verifyOwnedJobWorkspace(
  jobsRoot: string,
  workspace: string,
  workspaceId: string,
): Promise<string> {
  const target = assertOwnedJobWorkspace(jobsRoot, workspace);
  const parsed = JSON.parse(
    await readFile(path.join(target, JOB_WORKSPACE_OWNER_FILE), "utf8"),
  ) as Record<string, unknown>;
  if (
    parsed.owner !== "seyirlik-processing-job" ||
    parsed.workspaceId !== workspaceId
  ) {
    throw new Error("Refusing to remove an unowned scratch workspace.");
  }
  return target;
}

export interface AbandonedWorkspaceSweep {
  removed: string[];
  kept: string[];
}

/**
 * Removes scratch workspaces that no job can still be using.
 *
 * Age is deliberately not the criterion. A workspace holding a verified
 * package for a job that has been waiting three weeks for its drive to come
 * back is the single most expensive thing on the volume and the single worst
 * thing to delete, and every "clean up files older than N days" rule deletes
 * exactly that. So the question asked here is ownership, not age: a workspace
 * goes only when `stillClaimed` says no live job answers to its id.
 *
 * The age floor that remains is a race guard, not a policy — it keeps the
 * sweep from removing a workspace claimed moments ago by a job whose row the
 * sweeping process has not yet read.
 *
 * Anything without a readable ownership marker is left alone. This directory
 * may be shared with an operator's own files, and a sweep that deletes what it
 * cannot identify is a sweep that eventually deletes something that mattered.
 */
export async function sweepAbandonedWorkspaces({
  jobsRoot,
  stillClaimed,
  minimumAgeMs = 60 * 60 * 1000,
  now = Date.now,
}: {
  jobsRoot: string;
  stillClaimed: (workspaceId: string) => boolean | Promise<boolean>;
  minimumAgeMs?: number;
  now?: () => number;
}): Promise<AbandonedWorkspaceSweep> {
  const removed: string[] = [];
  const kept: string[] = [];
  const entries = await readdir(jobsRoot, { withFileTypes: true }).catch(
    () => [],
  );

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const workspace = path.join(jobsRoot, entry.name);

    let owned: string;
    try {
      owned = assertOwnedJobWorkspace(jobsRoot, workspace);
    } catch {
      kept.push(workspace);
      continue;
    }

    const marker = await readFile(
      path.join(owned, JOB_WORKSPACE_OWNER_FILE),
      "utf8",
    )
      .then((raw) => JSON.parse(raw) as Record<string, unknown>)
      .catch(() => null);
    if (
      !marker ||
      marker.owner !== "seyirlik-processing-job" ||
      typeof marker.workspaceId !== "string"
    ) {
      kept.push(workspace);
      continue;
    }

    const stats = await stat(owned).catch(() => null);
    /*
     * Clamped, so a zero floor really means no floor. A filesystem timestamp
     * can sit a fraction of a millisecond ahead of the clock this reads, which
     * made the age negative and kept every workspace for ever.
     */
    if (!stats || Math.max(0, now() - stats.mtimeMs) < minimumAgeMs) {
      kept.push(workspace);
      continue;
    }

    if (await stillClaimed(marker.workspaceId)) {
      kept.push(workspace);
      continue;
    }

    await rm(owned, { recursive: true, force: true });
    removed.push(workspace);
  }

  return { removed, kept };
}
