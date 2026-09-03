import {
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertOwnedJobWorkspace,
  assertWorkspaceId,
  assertClaimedWorkspace,
  claimJobWorkspace,
  mkdirWithinWorkspace,
  prepareProcessingStorageRoles,
  ScratchStorageLostError,
  sweepAbandonedWorkspaces,
  verifyOwnedJobWorkspace,
} from "./storageRoles";
import type { VolumeIdentity } from "./processing/storageIdentity";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "seyirlik-storage-roles-"));
  roots.push(root);
  const media = path.join(root, "media");
  const scratch = path.join(root, "scratch");
  await mkdir(media);
  return { root, media, scratch };
}

describe("processing storage roles", () => {
  it("creates isolated jobs and logs roots for an explicit scratch volume", async () => {
    const { media, scratch } = await fixture();
    await mkdir(scratch);
    const roles = await prepareProcessingStorageRoles({
      mediaRoot: media,
      scratchRoot: scratch,
      legacyWorkRoot: path.join(media, ".seyirlik", "work"),
      legacyLogsRoot: path.join(media, ".seyirlik", "logs"),
    });
    const canonicalScratch = await realpath(scratch);
    expect(roles.jobsRoot).toBe(path.join(canonicalScratch, "jobs"));
    expect(roles.logsRoot).toBe(path.join(canonicalScratch, "logs"));
    expect(roles.explicitlyConfigured).toBe(true);
  });

  it("preserves the legacy work-root behavior when scratch is unset", async () => {
    const { media } = await fixture();
    const work = path.join(media, ".seyirlik", "work");
    const logs = path.join(media, ".seyirlik", "logs");
    const roles = await prepareProcessingStorageRoles({
      mediaRoot: media,
      legacyWorkRoot: work,
      legacyLogsRoot: logs,
    });
    expect(roles.jobsRoot).toBe(work);
    expect(roles.logsRoot).toBe(logs);
    expect(roles.explicitlyConfigured).toBe(false);
  });

  it("rejects scratch nested in media storage", async () => {
    const { media } = await fixture();
    await mkdir(path.join(media, "scratch"));
    await expect(
      prepareProcessingStorageRoles({
        mediaRoot: media,
        scratchRoot: path.join(media, "scratch"),
        legacyWorkRoot: path.join(media, "work"),
        legacyLogsRoot: path.join(media, "logs"),
      }),
    ).rejects.toThrow(/must not equal, contain, or be nested/);
  });
});

describe("workspace path safety", () => {
  it("rejects traversal and deletion outside the jobs root", () => {
    expect(() => assertWorkspaceId("../media")).toThrow();
    expect(() =>
      assertOwnedJobWorkspace("/scratch/jobs", "/scratch/jobs"),
    ).toThrow();
    expect(() =>
      assertOwnedJobWorkspace("/scratch/jobs", "/scratch/other/job"),
    ).toThrow();
  });

  it("re-claims its own workspace when the source file has been replaced", async () => {
    const { root } = await fixture();
    const jobs = path.join(root, "jobs");
    const workspace = path.join(jobs, "job-1");
    await claimJobWorkspace(jobs, workspace, {
      workspaceId: "job-1",
      sourceFingerprint: "abc",
    });
    // Work built from the source that has since been replaced.
    await writeFile(path.join(workspace, "epoch-000000"), "stale", "utf8");

    await expect(
      claimJobWorkspace(jobs, workspace, {
        workspaceId: "job-1",
        sourceFingerprint: "def",
      }),
    ).resolves.toMatchObject({ directory: workspace, workspaceId: "job-1" });
    // Nothing from the previous source may survive into the new build.
    expect(await readdir(workspace)).toEqual([".seyirlik-job.json"]);
    // And the workspace is still this job's afterwards.
    await expect(
      verifyOwnedJobWorkspace(jobs, workspace, "job-1"),
    ).resolves.toBe(workspace);
  });

  it("refuses a workspace another job owns, whatever its source", async () => {
    const { root } = await fixture();
    const jobs = path.join(root, "jobs");
    const workspace = path.join(jobs, "job-1");
    await claimJobWorkspace(jobs, workspace, {
      workspaceId: "job-1",
      sourceFingerprint: "abc",
    });
    await expect(
      claimJobWorkspace(jobs, workspace, {
        workspaceId: "job-2",
        sourceFingerprint: "abc",
      }),
    ).rejects.toThrow(/different processing job/);
    // The other job's work is still there: a refusal must never delete.
    await expect(
      verifyOwnedJobWorkspace(jobs, workspace, "job-1"),
    ).resolves.toBe(workspace);
  });

  it("requires a matching on-disk ownership marker before cleanup", async () => {
    const { root } = await fixture();
    const jobs = path.join(root, "jobs");
    const workspace = path.join(jobs, "job-1");
    await claimJobWorkspace(jobs, workspace, {
      workspaceId: "job-1",
      sourceFingerprint: "abc",
    });
    await expect(
      verifyOwnedJobWorkspace(jobs, workspace, "job-1"),
    ).resolves.toBe(workspace);
    await expect(
      verifyOwnedJobWorkspace(jobs, workspace, "job-2"),
    ).rejects.toThrow(/unowned/);
  });
});

describe("releasing abandoned scratch", () => {
  async function workspaceAt(jobs: string, id: string): Promise<string> {
    const workspace = path.join(jobs, id);
    await claimJobWorkspace(jobs, workspace, {
      workspaceId: id,
      sourceFingerprint: "abc",
    });
    return workspace;
  }

  it("removes only workspaces no live job answers for", async () => {
    const { root } = await fixture();
    const jobs = path.join(root, "jobs");
    const live = await workspaceAt(jobs, "job-live");
    const dead = await workspaceAt(jobs, "job-dead");

    const sweep = await sweepAbandonedWorkspaces({
      jobsRoot: jobs,
      stillClaimed: (id) => id === "job-live",
      // The age floor is a race guard, not the policy under test.
      minimumAgeMs: 0,
    });

    expect(sweep.removed).toEqual([dead]);
    await expect(stat(live)).resolves.toMatchObject({});
    await expect(stat(dead)).rejects.toThrow();
  });

  it("keeps a workspace whose job is still waiting, however old it is", async () => {
    const { root } = await fixture();
    const jobs = path.join(root, "jobs");
    const waiting = await workspaceAt(jobs, "job-waiting");
    // The expensive thing an age-based rule would delete.
    await writeFile(
      path.join(waiting, ".verified-package.json"),
      JSON.stringify({ schemaVersion: 1 }),
      "utf8",
    );

    const sweep = await sweepAbandonedWorkspaces({
      jobsRoot: jobs,
      stillClaimed: () => true,
      minimumAgeMs: 0,
      // A month later. Age alone must still not be enough.
      now: () => Date.now() + 30 * 24 * 60 * 60 * 1000,
    });

    expect(sweep.removed).toEqual([]);
    await expect(
      stat(path.join(waiting, ".verified-package.json")),
    ).resolves.toMatchObject({});
  });

  it("never touches a directory it cannot identify as its own", async () => {
    const { root } = await fixture();
    const jobs = path.join(root, "jobs");
    await mkdir(jobs, { recursive: true });
    // Somebody else's folder, sitting in the same place.
    const foreign = path.join(jobs, "operator-notes");
    await mkdir(foreign);
    await writeFile(path.join(foreign, "keep.txt"), "mine", "utf8");

    const sweep = await sweepAbandonedWorkspaces({
      jobsRoot: jobs,
      stillClaimed: () => false,
      minimumAgeMs: 0,
    });

    expect(sweep.removed).toEqual([]);
    await expect(stat(path.join(foreign, "keep.txt"))).resolves.toMatchObject(
      {},
    );
  });

  it("does not remove a workspace claimed moments ago", async () => {
    const { root } = await fixture();
    const jobs = path.join(root, "jobs");
    const fresh = await workspaceAt(jobs, "job-fresh");

    /*
     * The race the age floor exists for: the job has claimed its workspace but
     * the sweeping process has not yet read the row that says so.
     */
    const sweep = await sweepAbandonedWorkspaces({
      jobsRoot: jobs,
      stillClaimed: () => false,
      minimumAgeMs: 60 * 60 * 1000,
    });

    expect(sweep.removed).toEqual([]);
    await expect(stat(fresh)).resolves.toMatchObject({});
  });
});

describe("binding a workspace to the filesystem it was claimed on", () => {
  async function claimed(root: string) {
    const jobs = path.join(root, "jobs");
    const workspace = path.join(jobs, "job-1");
    return claimJobWorkspace(jobs, workspace, {
      workspaceId: "job-1",
      sourceFingerprint: "abc",
    });
  }

  it("records the device the workspace was claimed on", async () => {
    const { root } = await fixture();
    const claim = await claimed(root);
    expect(claim.deviceId).toBe((await stat(claim.directory)).dev);
    await expect(assertClaimedWorkspace(claim)).resolves.toBeUndefined();
  });

  it("rejects a workspace that has moved to another filesystem", async () => {
    const { root } = await fixture();
    const claim = await claimed(root);

    /*
     * What an unmount leaves behind: the pathname is there, it is writable, the
     * ownership marker is even still there — and it is a different filesystem.
     * Only the device says so, which is why the device is recorded.
     */
    const moved = { ...claim, deviceId: claim.deviceId + 1 };
    await expect(assertClaimedWorkspace(moved)).rejects.toThrow(
      ScratchStorageLostError,
    );
    await expect(assertClaimedWorkspace(moved)).rejects.toThrow(
      /not the device/,
    );
  });

  it("rejects a workspace whose ownership marker has gone", async () => {
    const { root } = await fixture();
    const claim = await claimed(root);
    await rm(path.join(claim.directory, ".seyirlik-job.json"), { force: true });
    await expect(assertClaimedWorkspace(claim)).rejects.toThrow(
      ScratchStorageLostError,
    );
  });

  it("refuses to create directories once the filesystem has changed", async () => {
    const { root } = await fixture();
    const claim = await claimed(root);
    const target = path.join(claim.directory, "epochs", "000000");

    // On the claimed filesystem it is an ordinary recursive create.
    await mkdirWithinWorkspace(claim, target);
    await expect(stat(target)).resolves.toMatchObject({});

    /*
     * On a different one it must not happen at all. This is the check that
     * stops `mkdir -p` rebuilding a vanished scratch hierarchy somewhere else
     * and an encoder filling it.
     */
    const moved = { ...claim, deviceId: claim.deviceId + 1 };
    const elsewhere = path.join(claim.directory, "epochs", "000001");
    await expect(mkdirWithinWorkspace(moved, elsewhere)).rejects.toThrow(
      ScratchStorageLostError,
    );
    await expect(stat(elsewhere)).rejects.toThrow();
  });

  it("refuses to create anything outside the workspace", async () => {
    const { root } = await fixture();
    const claim = await claimed(root);
    await expect(
      mkdirWithinWorkspace(claim, path.join(root, "escaped")),
    ).rejects.toThrow(/outside the job workspace/);
  });

  it("checks volume identity only when asked, and only when it can", async () => {
    const { root } = await fixture();
    const jobs = path.join(root, "jobs");
    const workspace = path.join(jobs, "job-1");
    /*
     * The persistent half of identity, injected exactly as the storage-incident
     * store injects it. A UUID survives a remount where `st_dev` does not, so
     * it is what catches a *different* volume mounted at the same path that
     * happens to be handed the same device number.
     */
    let current: VolumeIdentity = {
      volumeUuid: "UUID-A",
      deviceNode: "/dev/disk9s1",
      medium: "disk-image",
      fsType: "hfs",
      mountPath: workspace,
    };
    const claim = await claimJobWorkspace(
      jobs,
      workspace,
      { workspaceId: "job-1", sourceFingerprint: "abc" },
      { probeIdentity: async () => current },
    );
    expect(claim.identity?.volumeUuid).toBe("UUID-A");

    // The same volume: fine, however deeply it is checked.
    await expect(
      assertClaimedWorkspace(claim, { deep: true }),
    ).resolves.toBeUndefined();

    // A different volume at the same path, with the device number reused.
    current = { ...current, volumeUuid: "UUID-B" };
    await expect(assertClaimedWorkspace(claim, { deep: true })).rejects.toThrow(
      /a different volume is mounted/,
    );

    // The shallow check is unaffected: it costs a stat and never a subprocess.
    await expect(assertClaimedWorkspace(claim)).resolves.toBeUndefined();
  });

  it("treats a physical volume replaced by an image as a different volume", async () => {
    const { root } = await fixture();
    const jobs = path.join(root, "jobs");
    const workspace = path.join(jobs, "job-1");
    let current: VolumeIdentity = {
      volumeUuid: "UUID-A",
      deviceNode: "/dev/disk9s1",
      medium: "physical-external",
      fsType: "hfs",
      mountPath: workspace,
    };
    const claim = await claimJobWorkspace(
      jobs,
      workspace,
      { workspaceId: "job-1", sourceFingerprint: "abc" },
      { probeIdentity: async () => current },
    );
    // Same UUID, but it is now a disk image standing where the drive was.
    current = { ...current, medium: "disk-image" };
    await expect(assertClaimedWorkspace(claim, { deep: true })).rejects.toThrow(
      /disk image/,
    );
  });
});
