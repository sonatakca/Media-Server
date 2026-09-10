import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  beginPartialEpoch,
  checkpointBytes,
  checkpointRoot,
  completedEpochPath,
  epochsRoot,
  inspectCompletedEpoch,
  invalidateEpoch,
  listCompletedEpochIndexes,
  listPartialEpochs,
  manifestMatchesIdentity,
  readEpochManifest,
  reconcileCheckpoints,
  reconcilePlan,
  writeEpochPlanFile,
  type EpochCheckpointManifest,
} from "./checkpoints";
import {
  EPOCH_CHECKPOINT_SCHEMA_VERSION,
  EPOCH_MANIFEST_FILE,
  EPOCH_TIMELINE_POLICY_VERSION,
} from "./policy";
import { buildEpochPlan } from "./plan";

const IDENTITY = {
  mediaId: "media",
  sourceFingerprint: "fingerprint",
  adaptiveProfileVersion: "profile",
  timelinePolicyVersion: EPOCH_TIMELINE_POLICY_VERSION,
};

let root = "";

function plan(durationSeconds = 26) {
  return buildEpochPlan({
    mediaId: IDENTITY.mediaId,
    sourceFingerprint: IDENTITY.sourceFingerprint,
    profileVersion: IDENTITY.adaptiveProfileVersion,
    sourceDurationSeconds: durationSeconds,
    epochTargetSeconds: 6,
    segmentSeconds: 2,
    timeline: null,
  });
}

function manifestFor(index: number): EpochCheckpointManifest {
  return {
    schemaVersion: EPOCH_CHECKPOINT_SCHEMA_VERSION,
    ...IDENTITY,
    epochIndex: index,
    startSeconds: index * 6,
    endSeconds: (index + 1) * 6,
    expectedDurationSeconds: 6,
    actualDurationSeconds: 6,
    encoder: "libx264",
    renditions: [
      {
        id: "360p",
        qualityHeight: 360,
        width: 640,
        height: 360,
        codec: "h264",
        hdr: "sdr",
        frameRate: 24000 / 1001,
        mediaPath: "video/360p/media.m4s",
        playlistPath: "video/360p/playlist.m3u8",
        fileSizeBytes: 5,
        segmentCount: 3,
        measuredDurationSeconds: 6,
        mediaTimescale: 24000,
        initDigest: "digest",
      },
    ],
    totalBytes: 5,
    checks: [],
    completedAt: new Date().toISOString(),
  };
}

/** Writes the media a manifest promises, so presence checks have something to find. */
async function writeEpochMedia(
  directory: string,
  bytes = "media",
): Promise<void> {
  await mkdir(path.join(directory, "video", "360p"), { recursive: true });
  await writeFile(path.join(directory, "video", "360p", "media.m4s"), bytes);
  await writeFile(
    path.join(directory, "video", "360p", "playlist.m3u8"),
    "#EXTM3U\n",
  );
}

async function completeEpoch(index: number): Promise<string> {
  const handle = await beginPartialEpoch({ root, index });
  await writeEpochMedia(handle.directory);
  const target = await handle.promote(manifestFor(index));
  return target;
}

/**
 * An epoch carrying an explicit encoder configuration and completion time.
 *
 * `manifestFor` deliberately writes no join key — that is the shape of a
 * checkpoint from before joinability was recorded, and the cases below need
 * both shapes.
 */
async function completeEpochWithConfig(
  index: number,
  configDigest: string,
  completedAt: string,
  extraRendition?: { id: string; configDigest: string },
): Promise<string> {
  const base = manifestFor(index);
  const first = base.renditions[0]!;
  const manifest: EpochCheckpointManifest = {
    ...base,
    completedAt,
    renditions: [
      {
        ...first,
        joinKey: {
          mediaTimescale: 24000,
          sampleFormat: "avc1",
          width: first.width,
          height: first.height,
          configDigest,
        },
      },
      ...(extraRendition
        ? [
            {
              ...first,
              id: extraRendition.id,
              mediaPath: `video/${extraRendition.id}/media.m4s`,
              playlistPath: `video/${extraRendition.id}/playlist.m3u8`,
              joinKey: {
                mediaTimescale: 24000,
                sampleFormat: "avc1",
                width: first.width,
                height: first.height,
                configDigest: extraRendition.configDigest,
              },
            },
          ]
        : []),
    ],
  };
  const handle = await beginPartialEpoch({ root, index });
  await writeEpochMedia(handle.directory);
  if (extraRendition) {
    await mkdir(path.join(handle.directory, "video", extraRendition.id), {
      recursive: true,
    });
    await writeFile(
      path.join(handle.directory, "video", extraRendition.id, "media.m4s"),
      "media",
    );
    await writeFile(
      path.join(handle.directory, "video", extraRendition.id, "playlist.m3u8"),
      "#EXTM3U",
    );
  }
  return handle.promote(manifest);
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "seyirlik-checkpoints-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("checkpointRoot", () => {
  it("keys the workspace by profile and source so two builds cannot share one", () => {
    const first = checkpointRoot(
      "/work",
      "media",
      "profile-v3",
      "aaaabbbbccccdddd1111",
    );
    const second = checkpointRoot(
      "/work",
      "media",
      "profile-v4",
      "aaaabbbbccccdddd1111",
    );
    const third = checkpointRoot(
      "/work",
      "media",
      "profile-v3",
      "zzzzbbbbccccdddd1111",
    );
    expect(first).not.toBe(second);
    expect(first).not.toBe(third);
  });
});

describe("promotion", () => {
  it("makes an epoch readable only after it is complete", async () => {
    const handle = await beginPartialEpoch({ root, index: 3 });
    await writeEpochMedia(handle.directory);

    // Half-written work never appears under a name anything treats as durable.
    expect(await listCompletedEpochIndexes(root)).toEqual([]);
    const partials = await listPartialEpochs(root);
    expect(partials).toHaveLength(1);
    expect(partials[0]!.index).toBe(3);

    await handle.promote(manifestFor(3));
    expect(await listCompletedEpochIndexes(root)).toEqual([3]);
    expect(await listPartialEpochs(root)).toEqual([]);
  });

  it("carries the ownership marker away with the promotion", async () => {
    const target = await completeEpoch(0);
    const entries = await readdir(target);
    expect(entries).toContain(EPOCH_MANIFEST_FILE);
    expect(entries).not.toContain("OWNER.json");
  });

  it("discards a workspace without touching completed epochs", async () => {
    await completeEpoch(0);
    const handle = await beginPartialEpoch({ root, index: 1 });
    await writeEpochMedia(handle.directory);
    await handle.discard();

    expect(await listCompletedEpochIndexes(root)).toEqual([0]);
    expect(await listPartialEpochs(root)).toEqual([]);
  });
});

describe("inspectCompletedEpoch", () => {
  it("accepts a checkpoint that matches its build and holds its files", async () => {
    await completeEpoch(0);
    const state = await inspectCompletedEpoch({
      root,
      index: 0,
      identity: IDENTITY,
      requiredRenditionIds: ["360p"],
    });
    expect(state.status).toBe("complete");
  });

  it("reports a missing epoch as missing rather than invalid", async () => {
    const state = await inspectCompletedEpoch({
      root,
      index: 4,
      identity: IDENTITY,
      requiredRenditionIds: ["360p"],
    });
    expect(state).toEqual({ status: "missing" });
  });

  it("refuses a checkpoint built from different source bytes", async () => {
    await completeEpoch(0);
    const state = await inspectCompletedEpoch({
      root,
      index: 0,
      identity: { ...IDENTITY, sourceFingerprint: "different" },
      requiredRenditionIds: ["360p"],
    });
    expect(state).toEqual({ status: "invalid", reason: "source-fingerprint" });
  });

  it("refuses a checkpoint written under a different timeline policy", async () => {
    await completeEpoch(0);
    const state = await inspectCompletedEpoch({
      root,
      index: 0,
      identity: { ...IDENTITY, timelinePolicyVersion: "other" },
      requiredRenditionIds: ["360p"],
    });
    expect(state).toEqual({
      status: "invalid",
      reason: "timeline-policy-version",
    });
  });

  it("refuses a checkpoint that lacks a rung the ladder now needs", async () => {
    await completeEpoch(0);
    const state = await inspectCompletedEpoch({
      root,
      index: 0,
      identity: IDENTITY,
      requiredRenditionIds: ["360p", "1080p"],
    });
    expect(state).toEqual({
      status: "invalid",
      reason: "missing-rendition:1080p",
    });
  });

  it("refuses a checkpoint whose media is gone even though its manifest is not", async () => {
    const target = await completeEpoch(0);
    await rm(path.join(target, "video", "360p", "media.m4s"));
    const state = await inspectCompletedEpoch({
      root,
      index: 0,
      identity: IDENTITY,
      requiredRenditionIds: ["360p"],
    });
    expect(state).toEqual({
      status: "invalid",
      reason: "missing-file:video/360p/media.m4s",
    });
  });

  it("refuses a checkpoint whose media was truncated after it was written", async () => {
    const target = await completeEpoch(0);
    await writeFile(path.join(target, "video", "360p", "media.m4s"), "x");
    const state = await inspectCompletedEpoch({
      root,
      index: 0,
      identity: IDENTITY,
      requiredRenditionIds: ["360p"],
    });
    expect(state).toEqual({ status: "invalid", reason: "size-changed:360p" });
  });

  it("refuses a directory that has no manifest at all", async () => {
    await mkdir(completedEpochPath(root, 2), { recursive: true });
    const state = await inspectCompletedEpoch({
      root,
      index: 2,
      identity: IDENTITY,
      requiredRenditionIds: ["360p"],
    });
    expect(state).toEqual({ status: "invalid", reason: "missing-manifest" });
  });
});

describe("reconcileCheckpoints", () => {
  it("reuses what is valid and schedules the rest", async () => {
    await completeEpoch(0);
    await completeEpoch(1);
    const outcome = await reconcileCheckpoints({
      root,
      plan: plan(),
      identity: IDENTITY,
      requiredRenditionIds: ["360p"],
    });
    expect(outcome.complete).toEqual([0, 1]);
    expect(outcome.pending).toEqual([2, 3]);
    expect(outcome.invalidated).toEqual([]);
  });

  it("removes an abandoned workspace and leaves an active one alone", async () => {
    await completeEpoch(0);
    const abandoned = await beginPartialEpoch({ root, index: 1 });
    abandoned.release();
    // A workspace this process wrote for an attempt that has ended.
    const before = await listPartialEpochs(root);
    expect(before[0]!.active).toBe(false);

    const outcome = await reconcileCheckpoints({
      root,
      plan: plan(),
      identity: IDENTITY,
      requiredRenditionIds: ["360p"],
    });
    expect(outcome.abandoned).toHaveLength(1);
    expect(outcome.complete).toEqual([0]);
    expect(await listPartialEpochs(root)).toEqual([]);
  });

  it("leaves a workspace another live process owns", async () => {
    await mkdir(epochsRoot(root), { recursive: true });
    const directory = path.join(
      epochsRoot(root),
      "000002.partial-999999-abcd1234",
    );
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, "OWNER.json"),
      JSON.stringify({
        // Another host: not this machine's to judge, so never reclaimed here.
        pid: 999_999,
        hostname: `${os.hostname()}-elsewhere`,
        attemptId: "a",
        startedAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
      }),
    );
    const outcome = await reconcileCheckpoints({
      root,
      plan: plan(),
      identity: IDENTITY,
      requiredRenditionIds: ["360p"],
    });
    expect(outcome.active).toEqual(["000002.partial-999999-abcd1234"]);
    expect(outcome.abandoned).toEqual([]);
  });

  it("reclaims a workspace whose owner stopped writing long ago", async () => {
    await mkdir(epochsRoot(root), { recursive: true });
    const directory = path.join(
      epochsRoot(root),
      "000002.partial-4242-abcd1234",
    );
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, "OWNER.json"),
      JSON.stringify({
        pid: 4242,
        hostname: os.hostname(),
        attemptId: "a",
        startedAt: new Date(Date.now() - 600_000).toISOString(),
        heartbeatAt: new Date(Date.now() - 600_000).toISOString(),
      }),
    );
    const outcome = await reconcileCheckpoints({
      root,
      plan: plan(),
      identity: IDENTITY,
      requiredRenditionIds: ["360p"],
    });
    expect(outcome.abandoned).toEqual(["000002.partial-4242-abcd1234"]);
  });

  it("invalidates exactly the damaged checkpoint and nothing around it", async () => {
    await completeEpoch(0);
    const second = await completeEpoch(1);
    await completeEpoch(2);
    await rm(path.join(second, "video", "360p", "media.m4s"));

    const outcome = await reconcileCheckpoints({
      root,
      plan: plan(),
      identity: IDENTITY,
      requiredRenditionIds: ["360p"],
    });
    expect(outcome.complete).toEqual([0, 2]);
    expect(outcome.invalidated).toEqual([
      { index: 1, reason: "missing-file:video/360p/media.m4s" },
    ]);
    expect(await readEpochManifest(root, 0)).not.toBeNull();
    expect(await readEpochManifest(root, 2)).not.toBeNull();
  });

  it("is idempotent: running it twice does the same as running it once", async () => {
    await completeEpoch(0);
    const abandoned = await beginPartialEpoch({ root, index: 1 });
    abandoned.release();

    const first = await reconcileCheckpoints({
      root,
      plan: plan(),
      identity: IDENTITY,
      requiredRenditionIds: ["360p"],
    });
    const second = await reconcileCheckpoints({
      root,
      plan: plan(),
      identity: IDENTITY,
      requiredRenditionIds: ["360p"],
    });
    expect(second.complete).toEqual(first.complete);
    expect(second.pending).toEqual(first.pending);
    expect(second.abandoned).toEqual([]);
  });

  it("discards epochs left over from a longer plan", async () => {
    await completeEpoch(0);
    await completeEpoch(7);
    const outcome = await reconcileCheckpoints({
      root,
      plan: plan(),
      identity: IDENTITY,
      requiredRenditionIds: ["360p"],
    });
    expect(outcome.invalidated).toContainEqual({
      index: 7,
      reason: "beyond-plan",
    });
    expect(await listCompletedEpochIndexes(root)).toEqual([0]);
  });
});

describe("reconcilePlan", () => {
  it("reuses a plan that belongs to this build", async () => {
    const expected = {
      mediaId: IDENTITY.mediaId,
      sourceFingerprint: IDENTITY.sourceFingerprint,
      profileVersion: IDENTITY.adaptiveProfileVersion,
      epochTargetSeconds: 6,
      segmentSeconds: 2,
      sourceDurationSeconds: 26,
    };
    await writeEpochPlanFile(root, plan());
    await completeEpoch(0);

    const outcome = await reconcilePlan({ root, plan: plan(), expected });
    expect(outcome.reused).toBe(true);
    expect(await listCompletedEpochIndexes(root)).toEqual([0]);
  });

  it("throws away every epoch when the boundaries would move", async () => {
    await writeEpochPlanFile(root, plan());
    await completeEpoch(0);

    const outcome = await reconcilePlan({
      root,
      plan: plan(),
      expected: {
        mediaId: IDENTITY.mediaId,
        sourceFingerprint: "changed",
        profileVersion: IDENTITY.adaptiveProfileVersion,
        epochTargetSeconds: 6,
        segmentSeconds: 2,
        sourceDurationSeconds: 26,
      },
    });
    expect(outcome.reused).toBe(false);
    expect(outcome.discardedReason).toBe("source-fingerprint");
    expect(await listCompletedEpochIndexes(root)).toEqual([]);
  });
});

describe("invalidateEpoch", () => {
  it("removes one checkpoint and leaves its neighbours in place", async () => {
    await completeEpoch(0);
    await completeEpoch(1);
    await invalidateEpoch(root, 0);
    expect(await listCompletedEpochIndexes(root)).toEqual([1]);
  });
});

describe("checkpointBytes", () => {
  it("reports what the durable work actually occupies", async () => {
    await completeEpoch(0);
    await completeEpoch(1);
    const bytes = await checkpointBytes(root);
    const manifestSize = (
      await stat(path.join(completedEpochPath(root, 0), EPOCH_MANIFEST_FILE))
    ).size;
    expect(bytes).toBeGreaterThan(manifestSize);
  });

  it("reports nothing for a root that does not exist yet", async () => {
    expect(await checkpointBytes(path.join(root, "absent"))).toBe(0);
  });
});

describe("manifestMatchesIdentity", () => {
  it("refuses a manifest written by an older checkpoint format", () => {
    expect(
      manifestMatchesIdentity(
        { ...manifestFor(0), schemaVersion: 0 },
        IDENTITY,
      ),
    ).toEqual({ ok: false, reason: "checkpoint-schema-version" });
  });
});

describe("manifest durability", () => {
  it("writes the manifest inside the workspace so the rename publishes both at once", async () => {
    const handle = await beginPartialEpoch({ root, index: 0 });
    await writeEpochMedia(handle.directory);
    const target = await handle.promote(manifestFor(0));
    const raw = await readFile(path.join(target, EPOCH_MANIFEST_FILE), "utf8");
    expect(JSON.parse(raw).epochIndex).toBe(0);
  });
});

/**
 * The trap that cost a twenty-two epoch title its whole assembly.
 *
 * A checkpointed encode assumes the encoder's configuration holds for the life
 * of the job, and nothing enforced it. A QSV preset change was deployed at
 * 02:57 between epoch 2 and epoch 3; the new parameter sets gave epochs 3-21 a
 * different `configDigest` from epochs 0-2. Every epoch encoded fine. Two hours
 * later the assembler compared them for the first time, said "epoch 3 wrote
 * 1440p with a different decoder configuration from the reference", and the job
 * failed — four times over, once per remaining attempt.
 *
 * The comparison belongs here instead, where the manifests already hold the
 * answer and nothing has been re-encoded yet.
 */
describe("checkpoints an encoder change has left behind", () => {
  const OLD = "aaaa1111";
  const NEW = "bbbb2222";

  it("keeps every epoch while they all agree", async () => {
    await completeEpochWithConfig(0, OLD, "2026-09-10T00:00:00.000Z");
    await completeEpochWithConfig(1, OLD, "2026-09-10T00:10:00.000Z");

    const outcome = await reconcileCheckpoints({
      root,
      plan: plan(),
      identity: IDENTITY,
      requiredRenditionIds: ["360p"],
    });

    expect(outcome.complete).toEqual([0, 1]);
    expect(outcome.invalidated).toEqual([]);
  });

  it("drops the epochs from the older configuration and schedules them again", async () => {
    await completeEpochWithConfig(0, OLD, "2026-09-09T23:49:44.544Z");
    await completeEpochWithConfig(1, OLD, "2026-09-10T00:14:20.937Z");
    await completeEpochWithConfig(2, NEW, "2026-09-10T02:03:02.998Z");
    await completeEpochWithConfig(3, NEW, "2026-09-10T02:08:00.435Z");

    const outcome = await reconcileCheckpoints({
      root,
      plan: plan(),
      identity: IDENTITY,
      requiredRenditionIds: ["360p"],
    });

    expect(outcome.complete).toEqual([2, 3]);
    expect(outcome.pending).toEqual([0, 1]);
    expect(outcome.invalidated).toEqual([
      { index: 0, reason: "encoder-config-changed" },
      { index: 1, reason: "encoder-config-changed" },
    ]);
    // Removed from disk, not merely un-listed: the next attempt has to encode
    // them, and a directory left behind would be re-adopted.
    expect(await listCompletedEpochIndexes(root)).toEqual([2, 3]);
  });

  /**
   * The newest group wins, not the largest.
   *
   * Both rules keep the right epochs in the case above, and only this one
   * converges: the newest epochs came from the most recent configuration, which
   * is the one the next epoch will be encoded with. Keeping the larger group
   * would discard the epochs that actually match what is about to be produced,
   * and could hand the same decision back unchanged on the next attempt.
   */
  it("keeps the newest configuration even when fewer epochs share it", async () => {
    await completeEpochWithConfig(0, OLD, "2026-09-10T00:00:00.000Z");
    await completeEpochWithConfig(1, OLD, "2026-09-10T00:10:00.000Z");
    await completeEpochWithConfig(2, OLD, "2026-09-10T00:20:00.000Z");
    await completeEpochWithConfig(3, NEW, "2026-09-10T02:00:00.000Z");

    const outcome = await reconcileCheckpoints({
      root,
      plan: plan(),
      identity: IDENTITY,
      requiredRenditionIds: ["360p"],
    });

    expect(outcome.complete).toEqual([3]);
    expect(outcome.pending).toEqual([0, 1, 2]);
  });

  it("compares every rung, not just the first", async () => {
    // The rung that disagreed in production was 1440p, and a ladder can agree
    // on one rung and differ on another. Checking only the first would let the
    // same two-hour failure through by a different route.
    await completeEpochWithConfig(0, OLD, "2026-09-10T00:00:00.000Z", {
      id: "720p",
      configDigest: "same",
    });
    await completeEpochWithConfig(1, OLD, "2026-09-10T02:00:00.000Z", {
      id: "720p",
      configDigest: "different",
    });

    const outcome = await reconcileCheckpoints({
      root,
      plan: plan(),
      identity: IDENTITY,
      requiredRenditionIds: ["360p"],
    });

    expect(outcome.complete).toEqual([1]);
    expect(outcome.invalidated).toEqual([
      { index: 0, reason: "encoder-config-changed" },
    ]);
  });

  it("leaves checkpoints written before join keys were recorded alone", async () => {
    // No join key is not evidence of a change, and these are already re-derived
    // from the media itself at assembly. Discarding them would throw away hours
    // of good work to answer a question nobody asked.
    await completeEpoch(0);
    await completeEpoch(1);

    const outcome = await reconcileCheckpoints({
      root,
      plan: plan(),
      identity: IDENTITY,
      requiredRenditionIds: ["360p"],
    });

    expect(outcome.complete).toEqual([0, 1]);
    expect(outcome.invalidated).toEqual([]);
  });
});
