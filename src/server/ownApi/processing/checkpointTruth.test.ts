import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkpointCountersFor,
  describeCheckpointRecovery,
  readCheckpointRecovery,
} from "./checkpointTruth";
import {
  checkpointRoot,
  epochsRoot,
  type EpochCheckpointManifest,
} from "../../../renditions/adaptive/epochs/checkpoints";
import {
  EPOCH_MANIFEST_FILE,
  EPOCH_PLAN_FILE,
  epochDirectoryName,
} from "../../../renditions/adaptive/epochs/policy";
import { ADAPTIVE_PROFILE_VERSION } from "../../../renditions/adaptive/profile";
import {
  createEmptyRenditionRegistry,
  saveRenditionRegistry,
  upsertRegistrySource,
} from "../../../renditions/registry";

/**
 * What a recovery is allowed to claim.
 *
 * The message this replaces said "encoding continues from the last durable
 * checkpoint" and was emitted unconditionally, one statement after the epoch
 * counters had been reset to zero. The job it was written about had
 * `completed_epochs = 0`, `epoch_index = NULL` and `protected_seconds = 0`.
 *
 * Everything below runs against a temporary directory built by hand. No real
 * media, no real volume: the checkpoint store's contract is a directory layout
 * and a JSON file, and that is exactly what these tests make.
 */

const FINGERPRINT = "a".repeat(64);
const RELATIVE = "Movies/Some Film (2017)/Some Film 2017.mkv";
const SIZE = 28_900_000_000;
const MTIME = 1_700_000_000_000;

const temporaries: string[] = [];

afterEach(async () => {
  for (const directory of temporaries.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

/**
 * A work root with a registry, so the checkpoint directory this code derives is
 * the same one the encoder would have written to.
 */
async function scaffold(): Promise<{
  paths: { workRoot: string; stateRoot: string };
  root: string;
}> {
  const base = await mkdtemp(path.join(tmpdir(), "seyirlik-checkpoints-"));
  temporaries.push(base);
  const workRoot = path.join(base, "work");
  const stateRoot = path.join(base, "state");
  await mkdir(workRoot, { recursive: true });
  await mkdir(stateRoot, { recursive: true });

  const registry = createEmptyRenditionRegistry();
  const item = upsertRegistrySource(registry, {
    relativePath: RELATIVE,
    size: SIZE,
    mtimeMs: MTIME,
    sourceFingerprint: FINGERPRINT,
  });
  await saveRenditionRegistry(path.join(stateRoot, "registry.json"), registry);

  return {
    paths: { workRoot, stateRoot },
    root: checkpointRoot(
      workRoot,
      item.id,
      ADAPTIVE_PROFILE_VERSION,
      FINGERPRINT,
    ),
  };
}

function manifest(
  index: number,
  overrides: Partial<EpochCheckpointManifest> = {},
): EpochCheckpointManifest {
  return {
    schemaVersion: 1,
    mediaId: "media",
    sourceFingerprint: FINGERPRINT,
    adaptiveProfileVersion: ADAPTIVE_PROFILE_VERSION,
    timelinePolicyVersion: "epoch-midpoint-cut-v1",
    epochIndex: index,
    startSeconds: index * 300,
    endSeconds: (index + 1) * 300,
    expectedDurationSeconds: 300,
    actualDurationSeconds: 300,
    encoder: "hevc_videotoolbox",
    renditions: [],
    totalBytes: 1_000,
    checks: [],
    completedAt: new Date().toISOString(),
    ...overrides,
  };
}

/** Writes a promoted epoch: the directory and the manifest that proves it. */
async function writeEpoch(
  root: string,
  index: number,
  overrides: Partial<EpochCheckpointManifest> = {},
): Promise<void> {
  const directory = path.join(epochsRoot(root), epochDirectoryName(index));
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, EPOCH_MANIFEST_FILE),
    JSON.stringify(manifest(index, overrides), null, 2),
    "utf8",
  );
}

describe("a job interrupted before its first checkpoint", () => {
  /** The exact claim that was false. */
  it("never says it resumed from a checkpoint", async () => {
    const { paths } = await scaffold();
    const recovery = await readCheckpointRecovery({
      paths,
      relativePath: RELATIVE,
      sourceFingerprint: FINGERPRINT,
      sizeBytes: SIZE,
      mtimeMs: MTIME,
    });

    expect(recovery.completedEpochs).toEqual([]);
    expect(recovery.protectedSeconds).toBe(0);
    expect(recovery.nextEpochIndex).toBe(0);

    const sentence = describeCheckpointRecovery(recovery);
    expect(sentence).toContain("restart from the beginning");
    expect(sentence).not.toContain("continues from");
    expect(sentence).not.toMatch(/Recovered \d+ durable/);
  });

  it("writes no invented progress into the counters", async () => {
    const { paths } = await scaffold();
    const recovery = await readCheckpointRecovery({
      paths,
      relativePath: RELATIVE,
      sourceFingerprint: FINGERPRINT,
      sizeBytes: SIZE,
      mtimeMs: MTIME,
    });
    expect(checkpointCountersFor(recovery)).toEqual({
      completedEpochs: 0,
      protectedSeconds: 0,
      encodedSeconds: 0,
      epochIndex: null,
    });
  });
});

describe("a job with checkpoints that genuinely exist", () => {
  it("counts exactly them and resumes at exactly the next one", async () => {
    const { paths, root } = await scaffold();
    for (const index of [0, 1, 2]) await writeEpoch(root, index);

    const recovery = await readCheckpointRecovery({
      paths,
      relativePath: RELATIVE,
      sourceFingerprint: FINGERPRINT,
      sizeBytes: SIZE,
      mtimeMs: MTIME,
    });

    expect(recovery.completedEpochs).toEqual([0, 1, 2]);
    expect(recovery.protectedSeconds).toBe(900);
    expect(recovery.nextEpochIndex).toBe(3);
    expect(recovery.resumeAtSeconds).toBe(900);
    expect(describeCheckpointRecovery(recovery)).toBe(
      "Recovered 3 durable checkpoints. Processing resumes from 00:15:00.",
    );
    expect(checkpointCountersFor(recovery)).toEqual({
      completedEpochs: 3,
      protectedSeconds: 900,
      encodedSeconds: 900,
      epochIndex: 3,
    });
  });

  it("says checkpoint in the singular for one", async () => {
    const { paths, root } = await scaffold();
    await writeEpoch(root, 0);
    const recovery = await readCheckpointRecovery({
      paths,
      relativePath: RELATIVE,
      sourceFingerprint: FINGERPRINT,
      sizeBytes: SIZE,
      mtimeMs: MTIME,
    });
    expect(describeCheckpointRecovery(recovery)).toContain(
      "1 durable checkpoint.",
    );
  });
});

describe("checkpoints that cannot be trusted", () => {
  /**
   * A directory whose manifest cannot be read is not a checkpoint, whatever its
   * name says. Counting it is how a resume lands in a gap.
   */
  it("rejects an epoch directory with no manifest", async () => {
    const { paths, root } = await scaffold();
    await writeEpoch(root, 0);
    await writeEpoch(root, 1);
    // Epoch 2 exists as a directory but was never promoted.
    await mkdir(path.join(epochsRoot(root), epochDirectoryName(2)), {
      recursive: true,
    });

    const recovery = await readCheckpointRecovery({
      paths,
      relativePath: RELATIVE,
      sourceFingerprint: FINGERPRINT,
      sizeBytes: SIZE,
      mtimeMs: MTIME,
    });
    expect(recovery.completedEpochs).toEqual([0, 1]);
    expect(recovery.nextEpochIndex).toBe(2);
  });

  it("rejects an epoch whose manifest is corrupt", async () => {
    const { paths, root } = await scaffold();
    await writeEpoch(root, 0);
    const broken = path.join(epochsRoot(root), epochDirectoryName(1));
    await mkdir(broken, { recursive: true });
    await writeFile(
      path.join(broken, EPOCH_MANIFEST_FILE),
      "{not json",
      "utf8",
    );

    const recovery = await readCheckpointRecovery({
      paths,
      relativePath: RELATIVE,
      sourceFingerprint: FINGERPRINT,
      sizeBytes: SIZE,
      mtimeMs: MTIME,
    });
    expect(recovery.completedEpochs).toEqual([0]);
  });

  /**
   * Epochs 0,1,2,7 are four directories and two hours of nothing: the encode
   * resumes at the first gap, so 7 is work that will be done again. Counting it
   * would restate the same lie in arithmetic instead of prose.
   */
  it("counts only the contiguous prefix, not every directory present", async () => {
    const { paths, root } = await scaffold();
    for (const index of [0, 1, 2, 7, 8]) await writeEpoch(root, index);

    const recovery = await readCheckpointRecovery({
      paths,
      relativePath: RELATIVE,
      sourceFingerprint: FINGERPRINT,
      sizeBytes: SIZE,
      mtimeMs: MTIME,
    });
    expect(recovery.completedEpochs).toEqual([0, 1, 2]);
    expect(recovery.protectedSeconds).toBe(900);
  });

  /**
   * An interrupted epoch is a `.partial` workspace and must never be counted,
   * whatever else survived. The completed ones around it are untouched.
   */
  it("ignores a partial workspace while keeping the completed epochs", async () => {
    const { paths, root } = await scaffold();
    for (const index of [0, 1] as const) await writeEpoch(root, index);
    await mkdir(path.join(epochsRoot(root), "000002.partial-1234-abcd"), {
      recursive: true,
    });

    const recovery = await readCheckpointRecovery({
      paths,
      relativePath: RELATIVE,
      sourceFingerprint: FINGERPRINT,
      sizeBytes: SIZE,
      mtimeMs: MTIME,
    });
    expect(recovery.completedEpochs).toEqual([0, 1]);
    expect(recovery.nextEpochIndex).toBe(2);
  });
});

describe("a work root that is not reachable", () => {
  /**
   * "None, as far as anyone can tell" is the honest answer when the volume has
   * gone. It must never become "the last one".
   */
  it("reports nothing recovered rather than throwing or guessing", async () => {
    const recovery = await readCheckpointRecovery({
      paths: {
        workRoot: "/definitely/not/mounted/work",
        stateRoot: "/definitely/not/mounted/state",
      },
      relativePath: RELATIVE,
      sourceFingerprint: FINGERPRINT,
      sizeBytes: SIZE,
      mtimeMs: MTIME,
    });
    expect(recovery.completedEpochs).toEqual([]);
    expect(describeCheckpointRecovery(recovery)).toContain(
      "restart from the beginning",
    );
  });
});

describe("a salvaged checkpoint", () => {
  /**
   * A recovery must not quietly present replaced film as clean film. The
   * manifest carries the salvage record precisely so a later reader rediscovers
   * it without the job row that ran at the time.
   */
  it("is counted but named as replaced", async () => {
    const { paths, root } = await scaffold();
    await writeEpoch(root, 0);
    await writeEpoch(root, 1, {
      salvage: {
        reason: "source-read",
        intervals: [{ startSeconds: 300, endSeconds: 600 }],
      } as unknown as EpochCheckpointManifest["salvage"],
    });

    const recovery = await readCheckpointRecovery({
      paths,
      relativePath: RELATIVE,
      sourceFingerprint: FINGERPRINT,
      sizeBytes: SIZE,
      mtimeMs: MTIME,
    });
    expect(recovery.salvagedEpochs).toEqual([1]);
    expect(describeCheckpointRecovery(recovery)).toContain(
      "replaced an unreadable stretch",
    );
  });
});

describe("the plan on disk", () => {
  it("is reported when present, so a page can show progress against it", async () => {
    const { paths, root } = await scaffold();
    await mkdir(root, { recursive: true });
    await writeFile(
      path.join(root, EPOCH_PLAN_FILE),
      JSON.stringify({
        schemaVersion: 1,
        targetSeconds: 300,
        sourceDurationSeconds: 7746.241,
        epochs: Array.from({ length: 26 }, (_unused, index) => ({
          index,
          startSeconds: index * 300,
          endSeconds: (index + 1) * 300,
        })),
      }),
      "utf8",
    );
    await writeEpoch(root, 0);

    const recovery = await readCheckpointRecovery({
      paths,
      relativePath: RELATIVE,
      sourceFingerprint: FINGERPRINT,
      sizeBytes: SIZE,
      mtimeMs: MTIME,
    });
    expect(recovery.plannedEpochs).toBe(26);
  });
});
