/**
 * The scratch volume being pulled out while FFmpeg is running.
 *
 * This is the failure the scratch pipeline adds to the system, and it is not
 * the same failure as losing the media volume. The encoder holds open write
 * handles on scratch for minutes at a time, so losing it mid-encode is device
 * loss under active I/O — and the whole question is whether that ends the job
 * or parks it.
 *
 * A real mount is used and really detached. `chmod` would produce `EACCES` on
 * a path that still resolves, which is a different errno reaching a different
 * branch of the classifier, so it would prove nothing about the case that
 * actually happens when somebody knocks a cable out.
 */

import { copyFile, mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
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
  onSameDevice,
  type MountedImage,
} from "./testDiskImages";

const MEDIA_ID = "66666666-6666-4666-8666-666666666666";
const EPOCH_TARGET_SECONDS = 6;

let fixture: string | null = null;
let workspace = "";
let canMount = false;
const images: MountedImage[] = [];

/** Every file (not directory) beneath a root, relative and sorted. */
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

const exists = (target: string): Promise<boolean> =>
  stat(target).then(
    () => true,
    () => false,
  );

beforeAll(async () => {
  fixture = await ensureAdaptiveEpochFixture();
  canMount = await diskImagesAvailable();
  workspace = await mkdtemp(path.join(tmpdir(), "seyirlik-scratch-unmount-"));
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

describe("losing the scratch volume while the encoder is running", () => {
  /*
   * The same failure, forced at many different moments.
   *
   * One detach at one point proves one timing window. The windows that matter
   * are the ones between a check and the write it guards, so the volume is
   * pulled at a different point in each round — at directory creation, part way
   * through an epoch, at the very first progress report — and every round
   * asserts the same invariants.
   */
  it.each([
    ["as soon as the build reports a stage", "build-stage"],
    ["once the encoder starts", "encode-start"],
    ["part way through an epoch", "encode-progress"],
    ["as an epoch completes", "epoch-complete"],
  ])(
    "survives the volume being pulled %s",
    async (_label, trigger) => {
      if (!fixture || !canMount) return;

      const root = await mkdtemp(path.join(workspace, "race-"));
      const scratch = await createMountedImage({
        directory: root,
        name: "scratch",
        sizeMb: 400,
      });
      images.push(scratch);

      const mediaRoot = path.join(root, "media");
      const titleRoot = path.join(mediaRoot, "Movies", "Race (2026)");
      await mkdir(titleRoot, { recursive: true });
      const sourcePath = path.join(titleRoot, "Race (2026).mp4");
      await copyFile(fixture, sourcePath);

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

      const request = {
        mediaId: MEDIA_ID,
        relativePath: path.basename(sourcePath),
        sourceFingerprint: await computeSourceFingerprint(
          sourcePath,
          await stat(sourcePath),
        ),
        sourcePath,
        workspaceId: MEDIA_ID,
      };

      let pulled = false;
      let detachedAt = 0;
      const result = await packageAdaptiveRendition(request, paths, {
        ...options,
        storageAvailable: () => true,
        onEvent: (event: { type: string }) => {
          if (pulled || event.type !== trigger) return;
          pulled = true;
          scratch.detachSync({ force: true });
          detachedAt = Date.now();
        },
      } as never);
      const stoppedAfterMs = Date.now() - detachedAt;

      // If the trigger never fired this round proves nothing; say so rather than
      // passing quietly.
      expect(pulled).toBe(true);
      expect(scratch.attached).toBe(false);

      /*
       * How long the job kept going after the volume left.
       *
       * This is the number the "bounded" claim rests on. The scratch poll runs
       * every two seconds and aborts the encoder through the same path a
       * cancellation uses; the allowance here is generous enough not to be
       * flaky and small enough that a regression to "runs until the epoch ends"
       * — minutes, on a real title — would fail it.
       */
      expect(stoppedAfterMs).toBeLessThan(60_000);

      // --- the four invariants, whatever the timing ------------------------
      // 1. Recoverable, never a permanent failure.
      expect(result.status).toBe("interrupted");
      expect(result.interruption).toBe("storage");

      // 2. Nothing published.
      expect(await readTitlePackageManifest(titleRoot)).toBeNull();

      // 3. No promoted checkpoint on the wrong filesystem.
      const stray = await walkFiles(paths.workRoot);
      expect(stray.filter((name) => name.endsWith("COMPLETE.json"))).toEqual(
        [],
      );
      // 4. And no generated media bytes there either.
      expect(
        stray.filter((name) => /\.(m4s|mp4|m3u8|vtt|m4a)$/.test(name)),
      ).toEqual([]);

      // --- and it recovers once the volume returns -------------------------
      await scratch.attach();
      const recovered = await packageAdaptiveRendition(request, paths, {
        ...options,
      } as never);
      expect(recovered.status).toBe("ready");
      expect(await readTitlePackageManifest(titleRoot)).not.toBeNull();
    },
    900_000,
  );

  it("parks the job, exposes nothing, and keeps other media intact", async () => {
    if (!fixture || !canMount) return;

    const root = await mkdtemp(path.join(workspace, "run-"));
    /*
     * 400 MB is ample for this package. The volume is separate so it can be
     * detached, not so it can be filled — running out of room is a different
     * test with a different errno.
     */
    const scratch = await createMountedImage({
      directory: root,
      name: "scratch",
      sizeMb: 400,
    });
    images.push(scratch);

    // The media volume stays put throughout: this test is about scratch.
    const mediaRoot = path.join(root, "media");
    const titleRoot = path.join(mediaRoot, "Movies", "Unmount Scratch (2026)");
    await mkdir(titleRoot, { recursive: true });
    const sourcePath = path.join(titleRoot, "Unmount Scratch (2026).mp4");
    await copyFile(fixture, sourcePath);

    /*
     * An unrelated title that was already published, sitting on the same media
     * volume. Nothing this job does when its scratch disappears may reach it.
     */
    const bystanderRoot = path.join(mediaRoot, "Movies", "Bystander (2019)");
    await mkdir(path.join(bystanderRoot, "video"), { recursive: true });
    const bystanderMedia = path.join(bystanderRoot, "video", "1080p.mp4");
    await copyFile(fixture, bystanderMedia);
    const bystanderBefore = await stat(bystanderMedia);

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

    // The premise: scratch really is a different filesystem from the media.
    expect(await onSameDevice(paths.workRoot, scratch.mountPoint)).toBe(true);
    expect(await onSameDevice(mediaRoot, scratch.mountPoint)).toBe(false);

    const request = {
      mediaId: MEDIA_ID,
      relativePath: path.basename(sourcePath),
      sourceFingerprint: await computeSourceFingerprint(
        sourcePath,
        await stat(sourcePath),
      ),
      sourcePath,
      workspaceId: MEDIA_ID,
    };
    /*
     * Detached on the first sign of encoder progress, so the volume goes while
     * FFmpeg holds its output files open rather than between stages.
     */
    let pulled = false;
    const result = await packageAdaptiveRendition(request, paths, {
      ...options,
      /*
       * The watchdog's answer, as the runner supplies it in production. It is
       * deliberately the *stale* answer — still reporting available — so this
       * proves the classification does not depend on the watchdog having
       * noticed yet, which on a timer it usually has not.
       */
      storageAvailable: () => true,
      onEvent: (event: { type: string }) => {
        if (pulled) return;
        // Mid-encode: FFmpeg is running and holding its scratch output open.
        if (
          event.type !== "encode-progress" &&
          event.type !== "epoch-progress"
        ) {
          return;
        }
        pulled = true;
        /*
         * Synchronous on purpose. Starting an unmount the caller does not
         * await is a race the encoder wins on a short fixture, and the job
         * then finishes normally — which tests nothing at all.
         */
        scratch.detachSync({ force: true });
      },
    } as never);

    expect(pulled).toBe(true);
    // The volume really went; otherwise this test proves nothing.
    expect(scratch.attached).toBe(false);

    // --- the job is parked, not failed -------------------------------------
    expect(result.status).toBe("interrupted");
    expect(result.interruption).toBe("storage");
    expect(["storage-device-lost", "storage-unavailable"]).toContain(
      result.failureKind,
    );
    /*
     * The reason has to say which storage and why, so an operator is not left
     * guessing. It now names the device mismatch outright — "it is now on
     * device X, not the device Y it was claimed on" — which is the sentence
     * that distinguishes a pulled disk from a broken encode.
     */
    expect(result.error ?? "").toMatch(
      /filesystem|storage|unavailable|disappear/i,
    );

    // --- nothing was exposed ----------------------------------------------
    expect(await readTitlePackageManifest(titleRoot)).toBeNull();
    expect(await exists(path.join(titleRoot, ".seyirlik-incoming"))).toBe(
      false,
    );
    expect(await exists(path.join(titleRoot, "video"))).toBe(false);

    // --- the source and unrelated media are untouched ----------------------
    const bystanderAfter = await stat(bystanderMedia);
    expect(bystanderAfter.size).toBe(bystanderBefore.size);
    expect(bystanderAfter.mtimeMs).toBe(bystanderBefore.mtimeMs);
    await expect(stat(sourcePath)).resolves.toMatchObject({});

    // --- durable state is coherent ----------------------------------------
    /*
     * The job stopped rather than carrying on somewhere else.
     *
     * `mkdir` with `recursive` will rebuild a missing scratch path on whatever
     * filesystem the mount point's parent is on, so a few empty directories
     * can survive a `mkdir` that raced the unmount. What must not survive is
     * anything that makes that tree look like a workspace or a build: no
     * ownership marker, no verified-package marker, and no media. Without the
     * per-epoch ownership check this job encoded a complete ladder onto the
     * internal disk and published it, with the watchdog reporting healthy
     * because the path it polls had been recreated underneath it.
     */
    const strayWorkspace = path.join(paths.workRoot, MEDIA_ID);
    expect(await exists(path.join(strayWorkspace, ".seyirlik-job.json"))).toBe(
      false,
    );
    expect(
      await exists(path.join(strayWorkspace, ".verified-package.json")),
    ).toBe(false);
    const strayFiles: string[] = [];
    const collect = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, {
        withFileTypes: true,
      }).catch(() => [])) {
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) await collect(absolute);
        else strayFiles.push(path.relative(paths.workRoot, absolute));
      }
    };
    await collect(paths.workRoot);
    expect(strayFiles).toEqual([]);

    // --- the volume returns, and the job runs again ------------------------
    await scratch.attach();
    expect(await onSameDevice(paths.workRoot, scratch.mountPoint)).toBe(true);

    const recovered = await packageAdaptiveRendition(request, paths, {
      ...options,
    } as never);
    expect(recovered.status).toBe("ready");

    const manifest = await readTitlePackageManifest(titleRoot);
    expect(manifest).not.toBeNull();
    expect(manifest!.video.length).toBeGreaterThan(0);
    for (const rendition of [...manifest!.video, ...manifest!.audio]) {
      const media = await stat(
        path.join(titleRoot, ...rendition.mediaPath.split("/")),
      );
      expect(media.size).toBe(rendition.fileSizeBytes);
    }
    // Scratch was released after the destination was proven.
    expect(await exists(path.join(paths.workRoot, MEDIA_ID))).toBe(false);
    // And the bystander is still exactly as it was.
    expect((await stat(bystanderMedia)).mtimeMs).toBe(bystanderBefore.mtimeMs);
  }, 900_000);
});
