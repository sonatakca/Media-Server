/**
 * Running out of room, on filesystems that really are full.
 *
 * `ENOSPC` is not something a fake can produce honestly. It arrives from
 * `write(2)` in the middle of an operation that was already succeeding, it can
 * arrive after a free-space preflight has passed, and where it arrives decides
 * what the job should do about it: scratch filling is a deferral, the
 * destination filling is a deferral that must additionally leave the verified
 * package and any previously published one untouched. Small mounted volumes
 * are the only way to get the real thing.
 *
 * The two paths that reach a full destination are deliberately both covered.
 * A publication refused by its free-space preflight and one that ran out
 * half-way through are different code, and only the second exercises what
 * happens to a partially written destination file.
 */

import { copyFile, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
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
  fillVolume,
  fillVolumeSync,
  freeBytes,
  type MountedImage,
} from "./testDiskImages";

const MEDIA_ID = "77777777-7777-4777-8777-777777777777";
const EPOCH_TARGET_SECONDS = 6;

let fixture: string | null = null;
let workspace = "";
let canMount = false;
const images: MountedImage[] = [];

const exists = (target: string): Promise<boolean> =>
  stat(target).then(
    () => true,
    () => false,
  );

interface Harness {
  paths: RenditionPaths;
  titleRoot: string;
  sourcePath: string;
  request: {
    mediaId: string;
    relativePath: string;
    sourceFingerprint: string;
    sourcePath: string;
    workspaceId: string;
  };
  workspaceDirectory: string;
  scratch: MountedImage;
  media: MountedImage;
}

/**
 * Two separate volumes, each sized by the caller.
 *
 * The media volume has to hold the source as well as the package, so its size
 * is chosen relative to both.
 */
async function createHarness({
  scratchMb,
  mediaMb,
}: {
  scratchMb: number;
  mediaMb: number;
}): Promise<Harness> {
  const root = await mkdtemp(path.join(workspace, "run-"));
  const scratch = await createMountedImage({
    directory: root,
    name: "scratch",
    sizeMb: scratchMb,
  });
  images.push(scratch);
  const media = await createMountedImage({
    directory: root,
    name: "media",
    sizeMb: mediaMb,
  });
  images.push(media);

  const mediaRoot = path.join(media.mountPoint, "media");
  const titleRoot = path.join(mediaRoot, "Movies", "Exhaustion (2026)");
  await mkdir(titleRoot, { recursive: true });
  const sourcePath = path.join(titleRoot, "Exhaustion (2026).mp4");
  await copyFile(fixture!, sourcePath);

  const paths: RenditionPaths = {
    mediaRoot,
    renditionRoot: path.join(scratch.mountPoint, "renditions"),
    stateRoot: path.join(scratch.mountPoint, "state"),
    workRoot: path.join(scratch.mountPoint, "jobs"),
    logsRoot: path.join(scratch.mountPoint, "logs"),
  };
  await mkdir(paths.workRoot, { recursive: true });
  await mkdir(paths.logsRoot, { recursive: true });
  await mkdir(path.join(paths.stateRoot, "locks"), { recursive: true });

  return {
    paths,
    titleRoot,
    sourcePath,
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
    scratch,
    media,
  };
}

/*
 * Software encoding, pinned.
 *
 * These tests are about storage, not about encoder selection, and the machine
 * has a small fixed number of VideoToolbox sessions. Left on `auto` they
 * compete with every other integration file for that pool, and a session that
 * cannot be opened fails the encode before the storage condition under test is
 * ever reached — which shows up as this file failing for a reason that has
 * nothing to do with it.
 */
const options = {
  reserveBytes: 0,
  preset: "ultrafast",
  verifySourceFingerprint: false,
  videoEncoder: "libx264" as const,
  encoderPreference: "software" as const,
  epochTargetSeconds: EPOCH_TARGET_SECONDS,
};

beforeAll(async () => {
  fixture = await ensureAdaptiveEpochFixture();
  canMount = await diskImagesAvailable();
  workspace = await mkdtemp(path.join(tmpdir(), "seyirlik-enospc-"));
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

describe("the scratch volume filling up while FFmpeg is writing", () => {
  it("is reported as a storage deferral, not as a broken encoder", async () => {
    if (!fixture || !canMount) return;
    /*
     * The volume is generously sized and then filled from underneath the
     * encoder once it is running. Choosing a small volume instead would be
     * refused by the free-space preflight before FFmpeg ever started, which is
     * a different branch and not the one this is about: here the encode is
     * under way, with output files open, when the disk runs out.
     */
    const harness = await createHarness({ scratchMb: 200, mediaMb: 400 });

    let balloon: string | null = null;
    const result = await packageAdaptiveRendition(
      harness.request,
      harness.paths,
      {
        ...options,
        onEvent: (event: { type: string }) => {
          if (balloon) return;
          if (
            event.type !== "encode-progress" &&
            event.type !== "epoch-progress"
          ) {
            return;
          }
          balloon = fillVolumeSync(harness.scratch.mountPoint, {
            leaveBytes: 128 * 1024,
            availableBytes: 200 * 1024 * 1024,
          });
        },
      } as never,
    );

    expect(balloon).not.toBeNull();

    /*
     * The distinction that matters. `encoder` means "this encode is broken",
     * ends the job and asks for a person; running out of room is a condition
     * of the disk that will be true again next time and false once space is
     * freed, so it defers instead.
     */
    expect(result.failureKind).toBe("out-of-space");
    expect(result.status).toBe("deferred-for-storage");

    // Nothing was published, and the title still holds only its source.
    expect(await readTitlePackageManifest(harness.titleRoot)).toBeNull();
    expect(await exists(path.join(harness.titleRoot, "video"))).toBe(false);
    await expect(stat(harness.sourcePath)).resolves.toMatchObject({});

    // Freeing the space is all it takes: the job runs to completion after.
    await rm(balloon!, { force: true });
    const recovered = await packageAdaptiveRendition(
      harness.request,
      harness.paths,
      { ...options } as never,
    );
    expect(recovered.status).toBe("ready");
    expect(await readTitlePackageManifest(harness.titleRoot)).not.toBeNull();
  }, 900_000);
});

describe("the media volume filling up during publication", () => {
  it("defers before it starts when the destination cannot hold the package", async () => {
    if (!fixture || !canMount) return;
    /*
     * Ample scratch, and a media volume filled down to less than the package
     * needs before the job starts. The free-space preflight should refuse
     * before a single destination byte is written.
     */
    const harness = await createHarness({ scratchMb: 500, mediaMb: 60 });
    const balloon = await fillVolume(harness.titleRoot, {
      leaveBytes: 256 * 1024,
    });

    const result = await packageAdaptiveRendition(
      harness.request,
      harness.paths,
      { ...options } as never,
    );

    expect(result.status).toBe("deferred-for-storage");
    expect(result.failureKind).toBe("out-of-space");

    // Nothing exposed, and no half-written staging left behind in the title.
    expect(await readTitlePackageManifest(harness.titleRoot)).toBeNull();

    /*
     * The whole point of deferring rather than failing: the encode is finished
     * and verified on scratch, so freeing space is all that is needed.
     */
    await expect(
      stat(path.join(harness.workspaceDirectory, ".verified-package.json")),
    ).resolves.toMatchObject({});

    // And with room made, the same job publishes without re-encoding.
    await rm(balloon, { force: true });
    let encodes = 0;
    const recovered = await packageAdaptiveRendition(
      harness.request,
      harness.paths,
      {
        ...options,
        runEncoder: async (command: string, args: string[], opts: never) => {
          encodes += 1;
          const { runFfmpeg } = await import("../processor");
          return runFfmpeg(command, args, opts);
        },
      } as never,
    );
    expect(recovered.status).toBe("ready");
    expect(encodes).toBe(0);
  }, 900_000);

  it("survives running out mid-copy and resumes once space is freed", async () => {
    if (!fixture || !canMount) return;
    /*
     * Sized so the preflight passes and the copy does not: the volume is
     * filled from underneath the publication once it has begun, which is the
     * only way to reach a write-time `ENOSPC` on the destination.
     */
    const harness = await createHarness({ scratchMb: 500, mediaMb: 90 });
    const availableBefore = await freeBytes(harness.titleRoot);

    let balloon: string | null = null;
    const result = await packageAdaptiveRendition(
      harness.request,
      harness.paths,
      {
        ...options,
        onEvent: (event: { type: string }) => {
          if (event.type !== "publish-progress" || balloon) return;
          // Synchronous: the copy must meet a full disk, not a racing one.
          balloon = fillVolumeSync(harness.media.mountPoint, {
            leaveBytes: 0,
            availableBytes: availableBefore,
          });
        },
      } as never,
    );

    expect(balloon).not.toBeNull();
    expect(result.status).not.toBe("ready");
    // Whatever the classification, nothing partial may be reachable.
    expect(await readTitlePackageManifest(harness.titleRoot)).toBeNull();

    // The verified scratch package is intact, so no re-encode is needed.
    await expect(
      stat(path.join(harness.workspaceDirectory, ".verified-package.json")),
    ).resolves.toMatchObject({});

    // Space is freed, exactly as an operator would free it.
    await rm(balloon!, { force: true });
    expect(await freeBytes(harness.titleRoot)).toBeGreaterThan(
      20 * 1024 * 1024,
    );

    const resumed = await packageAdaptiveRendition(
      harness.request,
      harness.paths,
      { ...options } as never,
    );
    expect(resumed.status).toBe("ready");

    const manifest = await readTitlePackageManifest(harness.titleRoot);
    expect(manifest).not.toBeNull();
    for (const rendition of [...manifest!.video, ...manifest!.audio]) {
      const media = await stat(
        path.join(harness.titleRoot, ...rendition.mediaPath.split("/")),
      );
      // Complete, not a remnant of the copy that ran out of room.
      expect(media.size).toBe(rendition.fileSizeBytes);
    }
  }, 900_000);

  it("never damages a package that was already published", async () => {
    if (!fixture || !canMount) return;
    const harness = await createHarness({ scratchMb: 500, mediaMb: 200 });

    // A good package, published normally.
    const first = await packageAdaptiveRendition(
      harness.request,
      harness.paths,
      { ...options } as never,
    );
    expect(first.status).toBe("ready");
    const before = await readTitlePackageManifest(harness.titleRoot);
    expect(before).not.toBeNull();
    const beforeSizes = new Map<string, number>();
    for (const rendition of [...before!.video, ...before!.audio]) {
      const absolute = path.join(
        harness.titleRoot,
        ...rendition.mediaPath.split("/"),
      );
      beforeSizes.set(rendition.mediaPath, (await stat(absolute)).size);
    }

    /*
     * Now the volume is filled and the same title is rebuilt from scratch, as
     * a re-process would. The rebuild cannot succeed; the published package
     * must not be disturbed by its failure.
     */
    await rm(path.join(harness.paths.workRoot, MEDIA_ID), {
      recursive: true,
      force: true,
    });
    await rm(path.join(harness.titleRoot, ".seyirlik", "package.json"), {
      force: true,
    });
    const balloon = await fillVolume(harness.titleRoot, {
      leaveBytes: 128 * 1024,
    });

    const second = await packageAdaptiveRendition(
      harness.request,
      harness.paths,
      { ...options } as never,
    );
    expect(second.status).not.toBe("ready");

    // Every media file of the previously published package is byte-for-byte
    // the size it was. A failed rebuild is allowed to publish nothing; it is
    // never allowed to truncate what is already playing.
    for (const [relative, size] of beforeSizes) {
      const absolute = path.join(harness.titleRoot, ...relative.split("/"));
      expect((await stat(absolute)).size).toBe(size);
    }

    await rm(balloon, { force: true });
  }, 900_000);
});
