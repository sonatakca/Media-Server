/**
 * Recovering a job when the scratch disk is not the one it was using.
 *
 * The in-process guard binds a running job to `st_dev`, which is the right
 * answer for as long as the process lives and no answer at all afterwards:
 * `st_dev` is a mount slot, it is recycled between mounts, and it is
 * deliberately never written down. The workspace's own `.seyirlik-job.json`
 * cannot cover the gap either, because it lives *on* the scratch volume and is
 * therefore missing in exactly the situation that needs deciding — the disk is
 * absent and the mountpoint pathname now resolves to the filesystem underneath
 * it, where a fresh marker could be written and a fresh workspace begun on
 * entirely the wrong disk.
 *
 * What survives is the volume's own UUID, recorded off the volume. These tests
 * mount real disk images, detach them, swap them, and start each recovery in a
 * runtime that has no memory of the previous one.
 */

import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RenditionPaths } from "../analysis";
import { computeSourceFingerprint } from "../registry";
import { packageAdaptiveRendition } from "./packager";
import { readTitlePackageManifest } from "./publishTitle";
import { ensureAdaptiveEpochFixture } from "./testFixtures";
import {
  createMountedImage,
  diskImagesAvailable,
  type MountedImage,
} from "./testDiskImages";
import type { VolumeIdentity } from "../processing/storageIdentity";

const MEDIA_ID = "88888888-8888-4888-8888-888888888888";

let fixture: string | null = null;
let workspace = "";
let canMount = false;
const images: MountedImage[] = [];

/*
 * Software encoding: these tests are about which disk is mounted, not about
 * encoder selection, and they must not compete for VideoToolbox sessions.
 */
const options = {
  reserveBytes: 0,
  preset: "ultrafast",
  verifySourceFingerprint: false,
  videoEncoder: "libx264" as const,
  encoderPreference: "software" as const,
  epochTargetSeconds: 6,
};

const exists = (target: string): Promise<boolean> =>
  stat(target).then(
    () => true,
    () => false,
  );

async function walkFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, {
      withFileTypes: true,
    }).catch(() => [])) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else found.push(path.relative(root, absolute));
    }
  };
  await visit(root);
  return found.sort();
}

/**
 * A probe standing in for `diskutil`, answering from the volume itself.
 *
 * The identity is written into each image when it is created and travels with
 * it, exactly as a real volume UUID does — which is the property under test.
 * Identifying by mountpoint path instead would defeat the whole exercise: a
 * path is what these tests deliberately make unreliable.
 *
 * The production probe reads `diskutil info -plist` through the parser already
 * in the tree. Driving the real one here would make the test depend on the
 * host's volume manager for a property that is about Seyirlik's logic, so the
 * answer is reported in the same shape the parser produces.
 */
const VOLUME_MARKER = ".seyirlik-test-volume";

async function labelVolume(mountPoint: string, uuid: string): Promise<void> {
  await writeFile(path.join(mountPoint, VOLUME_MARKER), uuid, "utf8");
}

const identityProbe = async (
  target: string,
): Promise<VolumeIdentity | null> => {
  const start = await stat(target).catch(() => null);
  if (!start) return null;

  /*
   * Walk up to the mount root: the last directory still on the same device as
   * the path being asked about. That is where a volume's own marker lives.
   */
  let current = path.resolve(target);
  let root = current;
  while (current !== path.dirname(current)) {
    const parent = path.dirname(current);
    const entry = await stat(parent).catch(() => null);
    if (!entry || entry.dev !== start.dev) break;
    root = parent;
    current = parent;
  }

  const uuid = await readFile(path.join(root, VOLUME_MARKER), "utf8")
    .then((text) => text.trim())
    .catch(() => null);
  if (uuid) {
    return {
      volumeUuid: uuid,
      deviceNode: "/dev/diskX",
      medium: "disk-image",
      fsType: "hfs",
      mountPath: root,
    };
  }

  /*
   * No marker: this is the filesystem underneath a mountpoint rather than one
   * of the test volumes, which is precisely the wrong answer for a recovering
   * job to accept.
   */
  return {
    volumeUuid: "UUID-PARENT-FILESYSTEM",
    deviceNode: "/dev/diskParent",
    medium: "physical-internal",
    fsType: "apfs",
    mountPath: root,
  };
};

interface Runtime {
  paths: RenditionPaths;
  titleRoot: string;
  request: {
    mediaId: string;
    relativePath: string;
    sourceFingerprint: string;
    sourcePath: string;
    workspaceId: string;
  };
  workspaceDirectory: string;
}

/**
 * A fresh runtime over the same on-disk layout.
 *
 * Every recovery below is started through one of these, so nothing is carried
 * over in memory from the run before it — which is what makes these restarts
 * rather than retries.
 */
async function runtimeFor(root: string, mountPoint: string): Promise<Runtime> {
  const mediaRoot = path.join(root, "media");
  const titleRoot = path.join(mediaRoot, "Movies", "Identity (2026)");
  await mkdir(titleRoot, { recursive: true });
  const sourcePath = path.join(titleRoot, "Identity (2026).mp4");
  if (!(await exists(sourcePath))) await copyFile(fixture!, sourcePath);

  const paths: RenditionPaths = {
    mediaRoot,
    renditionRoot: path.join(mountPoint, "renditions"),
    stateRoot: path.join(mountPoint, "state"),
    workRoot: path.join(mountPoint, "jobs"),
    logsRoot: path.join(mountPoint, "logs"),
  };
  return {
    paths,
    titleRoot,
    request: {
      mediaId: MEDIA_ID,
      relativePath: path.basename(sourcePath),
      sourceFingerprint: await computeSourceFingerprint(
        sourcePath,
        await stat(sourcePath),
      ),
      sourcePath,
      workspaceId: MEDIA_ID,
    },
    workspaceDirectory: path.join(paths.workRoot, MEDIA_ID),
  };
}

/** Creates the roots a mounted scratch volume needs. */
async function prepareScratch(paths: RenditionPaths): Promise<void> {
  await mkdir(paths.workRoot, { recursive: true });
  await mkdir(paths.logsRoot, { recursive: true });
  await mkdir(path.join(paths.stateRoot, "locks"), { recursive: true });
}

beforeAll(async () => {
  fixture = await ensureAdaptiveEpochFixture();
  canMount = await diskImagesAvailable();
  workspace = await mkdtemp(path.join(tmpdir(), "seyirlik-identity-"));
}, 600_000);

/*
 * Generously timed, and the images go before the directories they are mounted
 * under.
 *
 * Detaching several volumes is `hdiutil` work, and under a parallel run it can
 * take well past the ten seconds vitest allows a hook by default. When the
 * hook was cut short the suite was reported as failed with every test in it
 * passing — and, worse, the images stayed mounted, accumulating on the host
 * across runs until something noticed the disk filling.
 */
afterAll(async () => {
  for (const image of images.splice(0)) await image.dispose();
  if (workspace) await rm(workspace, { recursive: true, force: true });
}, 180_000);

describe("recovering across a restart the scratch disk did not survive", () => {
  it("A. refuses to start on the parent filesystem, then resumes when the disk returns", async () => {
    if (!fixture || !canMount) return;

    const root = await mkdtemp(path.join(workspace, "A-"));
    const diskA = await createMountedImage({
      directory: root,
      name: "scratchA",
      sizeMb: 400,
    });
    images.push(diskA);
    await labelVolume(diskA.mountPoint, "UUID-DISK-A");

    // 1-2. A job establishes its workspace on disk A.
    const first = await runtimeFor(root, diskA.mountPoint);
    await prepareScratch(first.paths);
    const established = await packageAdaptiveRendition(
      first.request,
      first.paths,
      { ...options, probeScratchIdentity: identityProbe } as never,
    );
    expect(established.status).toBe("ready");

    /*
     * What the job record keeps. This is the whole durable identity: a UUID,
     * and never the device number, which by now has already been reused.
     */
    const recorded = established.scratchIdentity;
    expect(recorded?.volumeUuid).toBe("UUID-DISK-A");

    // Start again from nothing, so the package below is genuinely rebuilt.
    await rm(first.titleRoot, { recursive: true, force: true });
    await mkdir(first.titleRoot, { recursive: true });
    await copyFile(fixture, first.request.sourcePath);

    // 3-5. The worker restarts with the disk gone, and the mountpoint pathname
    // now resolves to the filesystem underneath it.
    const deviceBefore = (await stat(diskA.mountPoint)).dev;
    await diskA.detach({ force: true });
    await mkdir(diskA.mountPoint, { recursive: true });
    expect(await exists(diskA.mountPoint)).toBe(true);

    // 6. Recovery, in a runtime that remembers nothing but the recorded volume.
    const parentBefore = await walkFiles(diskA.mountPoint);
    const recovering = await runtimeFor(root, diskA.mountPoint);
    let encoderStarted = false;
    const refused = await packageAdaptiveRendition(
      recovering.request,
      recovering.paths,
      {
        ...options,
        probeScratchIdentity: identityProbe,
        expectedScratchIdentity: recorded,
        runEncoder: async () => {
          encoderStarted = true;
          throw new Error("the encoder must not be reached");
        },
      } as never,
    );

    // --- nothing happened on the wrong disk ------------------------------
    expect(encoderStarted).toBe(false);
    expect(await exists(recovering.workspaceDirectory)).toBe(false);
    expect(
      await exists(
        path.join(recovering.workspaceDirectory, ".seyirlik-job.json"),
      ),
    ).toBe(false);
    // No checkpoint, no publication, nothing written at all.
    expect(await walkFiles(diskA.mountPoint)).toEqual(parentBefore);
    expect(await readTitlePackageManifest(recovering.titleRoot)).toBeNull();

    // --- and the job is waiting for storage, not failed -------------------
    expect(refused.status).toBe("interrupted");
    expect(refused.interruption).toBe("storage");

    /*
     * The same disk comes back. Its `st_dev` is free to differ — that is why
     * the device number is not what recovery matches on — and the UUID is
     * unchanged, so the job proceeds.
     */
    /*
     * Bring A back with a *different* device number, deliberately.
     *
     * A filler volume is attached first so it takes the slot A used to hold;
     * A then gets a new one. This is the case that makes persisting `st_dev`
     * impossible, so recovery has to work across it — and asserting the change
     * is what stops this test passing for the wrong reason on a machine that
     * happened to hand back the same number.
     */
    const filler = await createMountedImage({
      directory: root,
      name: "filler",
      sizeMb: 20,
    });
    images.push(filler);
    await diskA.attach();
    const deviceAfter = (await stat(diskA.mountPoint)).dev;
    expect(deviceAfter).not.toBe(deviceBefore);

    const resumed = await runtimeFor(root, diskA.mountPoint);
    await prepareScratch(resumed.paths);
    const completed = await packageAdaptiveRendition(
      resumed.request,
      resumed.paths,
      {
        ...options,
        probeScratchIdentity: identityProbe,
        expectedScratchIdentity: recorded,
      } as never,
    );
    expect(completed.status).toBe("ready");
    expect(await readTitlePackageManifest(resumed.titleRoot)).not.toBeNull();
  }, 900_000);

  it("B. refuses a different volume mounted at the same path, then accepts the right one", async () => {
    if (!fixture || !canMount) return;

    const root = await mkdtemp(path.join(workspace, "B-"));
    const diskA = await createMountedImage({
      directory: root,
      name: "scratchA",
      sizeMb: 400,
    });
    images.push(diskA);
    await labelVolume(diskA.mountPoint, "UUID-DISK-A");
    const mountPoint = diskA.mountPoint;

    /*
     * B is created at its own mountpoint and then re-attached at A's, so the
     * two really are different volumes appearing at one path — the same shape
     * as swapping a drive, and the case a pathname check cannot see.
     */
    const diskB = await createMountedImage({
      directory: root,
      name: "scratchB",
      sizeMb: 400,
    });
    images.push(diskB);
    await labelVolume(diskB.mountPoint, "UUID-DISK-B");

    // 1. The job establishes itself on A.
    const first = await runtimeFor(root, mountPoint);
    await prepareScratch(first.paths);
    const established = await packageAdaptiveRendition(
      first.request,
      first.paths,
      { ...options, probeScratchIdentity: identityProbe } as never,
    );
    expect(established.status).toBe("ready");
    const recorded = established.scratchIdentity;
    expect(recorded?.volumeUuid).toBe("UUID-DISK-A");

    await rm(first.titleRoot, { recursive: true, force: true });
    await mkdir(first.titleRoot, { recursive: true });
    await copyFile(fixture, first.request.sourcePath);

    // 2-4. Runtime stops, A is detached, B is mounted exactly where A was.
    await diskA.detach({ force: true });
    await diskB.detach({ force: true });
    await diskB.attachAt(mountPoint);

    // The pathname resolves, the filesystem type matches, it is writable — and
    // it is the wrong disk. Only the identity says so.
    expect(await exists(mountPoint)).toBe(true);
    const swapped = await runtimeFor(root, mountPoint);
    await prepareScratch(swapped.paths);
    const bBefore = await walkFiles(mountPoint);

    // 5. Recovery must refuse.
    let encoderStarted = false;
    const refused = await packageAdaptiveRendition(
      swapped.request,
      swapped.paths,
      {
        ...options,
        probeScratchIdentity: identityProbe,
        expectedScratchIdentity: recorded,
        runEncoder: async () => {
          encoderStarted = true;
          throw new Error("the encoder must not be reached");
        },
      } as never,
    );
    expect(encoderStarted).toBe(false);
    expect(refused.status).toBe("interrupted");
    expect(refused.interruption).toBe("storage");
    expect(await exists(swapped.workspaceDirectory)).toBe(false);
    // Nothing was written to the innocent volume either.
    expect(await walkFiles(mountPoint)).toEqual(bBefore);
    expect(await readTitlePackageManifest(swapped.titleRoot)).toBeNull();

    // Put A back where it belongs and the same job runs.
    await diskB.detach({ force: true });
    await diskA.attach();
    const restored = await runtimeFor(root, mountPoint);
    await prepareScratch(restored.paths);
    const completed = await packageAdaptiveRendition(
      restored.request,
      restored.paths,
      {
        ...options,
        probeScratchIdentity: identityProbe,
        expectedScratchIdentity: recorded,
      } as never,
    );
    expect(completed.status).toBe("ready");
  }, 900_000);

  it("C. accepts only the recorded volume when nothing is remembered in memory", async () => {
    if (!fixture || !canMount) return;

    const root = await mkdtemp(path.join(workspace, "C-"));
    const diskA = await createMountedImage({
      directory: root,
      name: "scratchA",
      sizeMb: 400,
    });
    images.push(diskA);
    await labelVolume(diskA.mountPoint, "UUID-DISK-A");
    const diskB = await createMountedImage({
      directory: root,
      name: "scratchB",
      sizeMb: 400,
    });
    images.push(diskB);
    await labelVolume(diskB.mountPoint, "UUID-DISK-B");
    const mountPoint = diskA.mountPoint;

    /*
     * The reboot case: no claim was ever made in this process, so there is no
     * `st_dev` to compare and no marker to read until a volume is accepted.
     * The recorded UUID is the only thing standing between the job and
     * whatever happens to be mounted.
     */
    const recordedA: VolumeIdentity = {
      volumeUuid: "UUID-DISK-A",
      deviceNode: null,
      medium: "disk-image",
      fsType: "hfs",
      mountPath: null,
    };

    // B is at the path. Refused, with nothing created.
    await diskA.detach({ force: true });
    await diskB.detach({ force: true });
    await diskB.attachAt(mountPoint);
    const wrong = await runtimeFor(root, mountPoint);
    await prepareScratch(wrong.paths);
    const before = await walkFiles(mountPoint);
    const refused = await packageAdaptiveRendition(wrong.request, wrong.paths, {
      ...options,
      probeScratchIdentity: identityProbe,
      expectedScratchIdentity: recordedA,
      runEncoder: async () => {
        throw new Error("the encoder must not be reached");
      },
    } as never);
    expect(refused.status).toBe("interrupted");
    expect(await exists(wrong.workspaceDirectory)).toBe(false);
    expect(await walkFiles(mountPoint)).toEqual(before);

    // A is at the path. Accepted.
    await diskB.detach({ force: true });
    await diskA.attach();
    const right = await runtimeFor(root, mountPoint);
    await prepareScratch(right.paths);
    const accepted = await packageAdaptiveRendition(
      right.request,
      right.paths,
      {
        ...options,
        probeScratchIdentity: identityProbe,
        expectedScratchIdentity: recordedA,
      } as never,
    );
    expect(accepted.status).toBe("ready");
  }, 900_000);

  it("still lets a genuinely new job claim whatever is mounted", async () => {
    if (!fixture || !canMount) return;

    const root = await mkdtemp(path.join(workspace, "new-"));
    const disk = await createMountedImage({
      directory: root,
      name: "scratchNew",
      sizeMb: 400,
    });
    images.push(disk);
    await labelVolume(disk.mountPoint, "UUID-FRESH");

    /*
     * No recorded identity, because the job has never claimed one. The check
     * must not fire here: holding a new job until it recognises a volume it
     * has never seen would stop every first run on every machine.
     */
    const runtime = await runtimeFor(root, disk.mountPoint);
    await prepareScratch(runtime.paths);
    const result = await packageAdaptiveRendition(
      runtime.request,
      runtime.paths,
      { ...options, probeScratchIdentity: identityProbe } as never,
    );
    expect(result.status).toBe("ready");
    // And it reports what it claimed, so the caller can record it.
    expect(result.scratchIdentity?.volumeUuid).toBe("UUID-FRESH");
  }, 900_000);
});
