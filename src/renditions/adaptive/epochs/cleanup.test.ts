import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupAdaptiveWork } from "./cleanup";
import { beginPartialEpoch } from "./checkpoints";
import { EPOCH_MANIFEST_FILE, EPOCH_PLAN_FILE } from "./policy";

const PROFILE = "cmaf-hls-aligned-v3";
const MEDIA = "media-1";

let workRoot = "";

function buildRoot(fingerprint = "abcdef0123456789"): string {
  return path.join(workRoot, MEDIA, `${PROFILE}-${fingerprint}`);
}

async function writeCompletedEpoch(
  root: string,
  index: number,
): Promise<string> {
  const handle = await beginPartialEpoch({ root, index });
  await mkdir(path.join(handle.directory, "video", "360p"), {
    recursive: true,
  });
  await writeFile(
    path.join(handle.directory, "video", "360p", "media.m4s"),
    "media",
  );
  const target = await handle.promote({
    schemaVersion: 1,
    mediaId: MEDIA,
    sourceFingerprint: "abcdef0123456789",
    adaptiveProfileVersion: PROFILE,
    timelinePolicyVersion: "epoch-midpoint-cut-v1",
    epochIndex: index,
    startSeconds: index * 300,
    endSeconds: (index + 1) * 300,
    expectedDurationSeconds: 300,
    actualDurationSeconds: 300,
    encoder: "libx264",
    renditions: [],
    totalBytes: 5,
    checks: [],
    completedAt: new Date().toISOString(),
  });
  return target;
}

const noLocks = async () => false;

beforeEach(async () => {
  workRoot = await mkdtemp(path.join(tmpdir(), "seyirlik-cleanup-"));
});

afterEach(async () => {
  await rm(workRoot, { recursive: true, force: true });
});

describe("cleanupAdaptiveWork", () => {
  it("keeps completed checkpoints however old they are", async () => {
    const root = buildRoot();
    await writeFile(
      await mkdir(root, { recursive: true }).then(() =>
        path.join(root, EPOCH_PLAN_FILE),
      ),
      "{}",
    );
    await writeCompletedEpoch(root, 0);
    await writeCompletedEpoch(root, 1);

    const actions = await cleanupAdaptiveWork({
      workRoot,
      profileVersion: PROFILE,
      hasActiveLock: noLocks,
    });

    expect(actions).toContainEqual({
      path: `${MEDIA}/${PROFILE}-abcdef0123456789`,
      action: "kept-checkpoints",
      keptEpochs: 2,
    });
    const kept = await readdir(path.join(root, "epochs"));
    expect(kept.sort()).toEqual(["000000", "000001"]);
  });

  it("removes a partial epoch nobody is writing", async () => {
    const root = buildRoot();
    await writeCompletedEpoch(root, 0);
    const abandoned = await beginPartialEpoch({ root, index: 1 });
    abandoned.release();

    const actions = await cleanupAdaptiveWork({
      workRoot,
      profileVersion: PROFILE,
      hasActiveLock: noLocks,
    });

    expect(
      actions.some((entry) => entry.action === "removed-abandoned-epoch"),
    ).toBe(true);
    const remaining = await readdir(path.join(root, "epochs"));
    expect(remaining).toEqual(["000000"]);
  });

  it("removes a staging directory left by an attempt that ended", async () => {
    const root = buildRoot();
    await writeCompletedEpoch(root, 0);
    const staging = path.join(
      workRoot,
      MEDIA,
      `${PROFILE}-abcdef0123456789.999-deadbeef.partial`,
    );
    await mkdir(staging, { recursive: true });

    const actions = await cleanupAdaptiveWork({
      workRoot,
      profileVersion: PROFILE,
      hasActiveLock: noLocks,
    });

    expect(
      actions.some((entry) => entry.action === "removed-stale-staging"),
    ).toBe(true);
    const remaining = await readdir(path.join(workRoot, MEDIA));
    expect(remaining).toEqual([`${PROFILE}-abcdef0123456789`]);
  });

  it("leaves everything alone while a lock says work is going on", async () => {
    const root = buildRoot();
    await writeCompletedEpoch(root, 0);
    const abandoned = await beginPartialEpoch({ root, index: 1 });
    abandoned.release();

    const actions = await cleanupAdaptiveWork({
      workRoot,
      profileVersion: PROFILE,
      hasActiveLock: async () => true,
    });

    expect(actions).toEqual([{ path: MEDIA, action: "skipped-active-lock" }]);
    expect((await readdir(path.join(root, "epochs"))).length).toBe(2);
  });

  it("removes a build keyed to a profile this server no longer produces", async () => {
    const stale = path.join(workRoot, MEDIA, "cmaf-hls-aligned-v1-abcdef01");
    await mkdir(path.join(stale, "epochs", "000000"), { recursive: true });
    await writeFile(
      path.join(stale, "epochs", "000000", EPOCH_MANIFEST_FILE),
      "{}",
    );

    const actions = await cleanupAdaptiveWork({
      workRoot,
      profileVersion: PROFILE,
      hasActiveLock: noLocks,
    });

    expect(
      actions.some((entry) => entry.action === "removed-obsolete-build"),
    ).toBe(true);
    expect(await readdir(workRoot)).toEqual([]);
  });

  it("removes a build for media the library no longer knows about", async () => {
    const root = buildRoot();
    await writeCompletedEpoch(root, 0);

    await cleanupAdaptiveWork({
      workRoot,
      profileVersion: PROFILE,
      isKnownMedia: () => false,
      hasActiveLock: noLocks,
    });

    expect(await readdir(workRoot)).toEqual([]);
  });

  it("removes a completed directory that cannot prove what it holds", async () => {
    const root = buildRoot();
    await writeCompletedEpoch(root, 0);
    await mkdir(path.join(root, "epochs", "000001"), { recursive: true });

    const actions = await cleanupAdaptiveWork({
      workRoot,
      profileVersion: PROFILE,
      hasActiveLock: noLocks,
    });

    expect(
      actions.some(
        (entry) =>
          entry.action === "removed-abandoned-epoch" &&
          entry.path.endsWith("000001"),
      ),
    ).toBe(true);
    expect(await readdir(path.join(root, "epochs"))).toEqual(["000000"]);
  });

  it("changes nothing at all in a dry run", async () => {
    const root = buildRoot();
    await writeCompletedEpoch(root, 0);
    const abandoned = await beginPartialEpoch({ root, index: 1 });
    abandoned.release();
    const before = await readdir(path.join(root, "epochs"));

    const actions = await cleanupAdaptiveWork({
      workRoot,
      profileVersion: PROFILE,
      hasActiveLock: noLocks,
      dryRun: true,
    });

    expect(actions.length).toBeGreaterThan(0);
    expect((await readdir(path.join(root, "epochs"))).sort()).toEqual(
      before.sort(),
    );
  });

  it("clears a workspace that holds nothing reusable", async () => {
    await mkdir(path.join(workRoot, MEDIA), { recursive: true });
    const actions = await cleanupAdaptiveWork({
      workRoot,
      profileVersion: PROFILE,
      hasActiveLock: noLocks,
    });
    expect(actions).toContainEqual({
      path: MEDIA,
      action: "removed-empty-workspace",
    });
  });

  it("does nothing when there is no work root at all", async () => {
    expect(
      await cleanupAdaptiveWork({
        workRoot: path.join(workRoot, "absent"),
        profileVersion: PROFILE,
        hasActiveLock: noLocks,
      }),
    ).toEqual([]);
  });
});
