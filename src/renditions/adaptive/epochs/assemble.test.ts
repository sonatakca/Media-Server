/**
 * The guard that stands between independently encoded epochs and one file.
 *
 * Assembly concatenates fragments under a *single* initialisation segment —
 * epoch zero's. That is only sound because every epoch's initialisation is
 * byte-identical, which holds because each epoch is muxed on its own zero-based
 * timeline with the same settings. If it ever stopped holding, concatenating
 * anyway would produce a file whose second half is decoded with the wrong
 * VPS/SPS/PPS: wrong dimensions, wrong profile, wrong colour, or simply noise,
 * with nothing in the container to say so.
 *
 * So the digest is not decoration. These tests prove it is load-bearing.
 */

import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assembleVideoRenditions } from "./assemble";
import type { EpochCheckpointManifest } from "./checkpoints";
import { buildEpochPlan } from "./plan";

let workspace = "";

beforeEach(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "seyirlik-assemble-"));
});

afterEach(async () => {
  if (workspace) await rm(workspace, { recursive: true, force: true });
});

const RENDITION = "video-1080";

function manifest(
  index: number,
  overrides: Partial<EpochCheckpointManifest["renditions"][number]> = {},
): EpochCheckpointManifest {
  return {
    schemaVersion: 1,
    mediaId: "11111111-1111-4111-8111-111111111111",
    sourceFingerprint: "f".repeat(64),
    adaptiveProfileVersion: "cmaf-hls-aligned-v2",
    timelinePolicyVersion: "epoch-midpoint-cut-v1",
    epochIndex: index,
    startSeconds: index * 6,
    endSeconds: (index + 1) * 6,
    expectedDurationSeconds: 6,
    actualDurationSeconds: 6,
    encoder: "h264_videotoolbox",
    renditions: [
      {
        id: RENDITION,
        qualityHeight: 1080,
        width: 1920,
        height: 1080,
        codec: "h264",
        pixelFormat: "yuv420p",
        hdr: "sdr",
        frameRate: 24,
        mediaPath: `video/${RENDITION}/media.m4s`,
        playlistPath: `video/${RENDITION}/playlist.m3u8`,
        fileSizeBytes: 1024,
        segmentCount: 3,
        measuredDurationSeconds: 6,
        mediaTimescale: 15360,
        initDigest: "a".repeat(64),
        ...overrides,
      },
    ],
    totalBytes: 1024,
    checks: [],
    completedAt: "2026-09-02T00:00:00.000Z",
  };
}

function plan() {
  return buildEpochPlan({
    mediaId: "11111111-1111-4111-8111-111111111111",
    sourceFingerprint: "f".repeat(64),
    profileVersion: "cmaf-hls-aligned-v2",
    sourceDurationSeconds: 18,
    epochTargetSeconds: 6,
    segmentSeconds: 2,
  });
}

async function assemble(manifests: EpochCheckpointManifest[]) {
  return assembleVideoRenditions({
    checkpointRoot: path.join(workspace, "checkpoints"),
    plan: plan(),
    manifests,
    renditionIds: [RENDITION],
    targetRoot: path.join(workspace, "staging"),
    targetDirectory: "video",
  });
}

describe("initialisation compatibility across epochs", () => {
  /**
   * The whole point. A single differing byte anywhere in the initialisation
   * segment — a changed SPS, a different profile or level, another pixel
   * format, other dimensions, a moved colour box, an HDR signal that came or
   * went, a different `mdhd` timescale — changes the digest, and the digest is
   * what is compared. There is no list of fields to keep in step with the
   * format because the comparison is over the bytes themselves.
   */
  it("refuses to join epochs whose initialisation segments differ", async () => {
    await expect(
      assemble([
        manifest(0),
        manifest(1, { initDigest: "b".repeat(64) }),
        manifest(2),
      ]),
    ).rejects.toThrow(/different .* initialisation segment/i);
  });

  it("names the epoch that disagrees, so the right one is rebuilt", async () => {
    await expect(
      assemble([
        manifest(0),
        manifest(1),
        manifest(2, { initDigest: "c".repeat(64) }),
      ]),
    ).rejects.toThrow(/Epoch 2/);
  });

  /**
   * Nothing is written before the check.
   *
   * A half-written media file left behind by a refused assembly is exactly the
   * thing a later run could mistake for output, so the guard has to come before
   * the first byte, not after it.
   */
  it("writes no media at all when the check fails", async () => {
    await expect(
      assemble([manifest(0), manifest(1, { initDigest: "b".repeat(64) })]),
    ).rejects.toThrow();
    const staged = await readdir(
      path.join(workspace, "staging", "video", RENDITION),
    ).catch(() => []);
    expect(staged).toEqual([]);
  });

  /**
   * The timescale is checked separately even though it lives inside the
   * initialisation segment and is therefore already covered by the digest. It
   * is the one field assembly *uses* — every offset is converted through it —
   * so a mismatch gets its own message rather than being reported as a generic
   * initialisation difference an operator cannot act on.
   */
  it("refuses epochs muxed on different timescales, and says so plainly", async () => {
    await expect(
      assemble([manifest(0), manifest(1, { mediaTimescale: 90000 })]),
    ).rejects.toThrow(/90000 timescale where epoch 0 used 15360/);
  });

  it("refuses to assemble an epoch that is missing the rendition entirely", async () => {
    const broken = manifest(1);
    broken.renditions = [];
    await expect(assemble([manifest(0), broken])).rejects.toThrow(
      /has no video-1080 rendition/,
    );
  });

  it("refuses to assemble nothing", async () => {
    await expect(assemble([])).rejects.toThrow(
      /needs at least one completed epoch/,
    );
  });
});
