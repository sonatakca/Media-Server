/**
 * The guard that stands between independently encoded epochs and one file.
 *
 * Assembly concatenates fragments under a *single* initialisation segment —
 * epoch zero's. That is only sound while every epoch's fragments decode
 * correctly under it. If it ever stopped holding, concatenating anyway would
 * produce a file whose second half is decoded with the wrong VPS/SPS/PPS: wrong
 * dimensions, wrong profile, wrong colour, or simply noise, with nothing in the
 * container to say so.
 *
 * What is compared is therefore the decoder configuration, the sample entry and
 * the timescale, and not the initialisation segment byte for byte. The two
 * differ on exactly one thing and it matters: a replacement epoch generated for
 * an unreadable interval carries no HDR10 mastering-display metadata, because a
 * colour generator has none to carry, while producing a byte-identical `hvcC`
 * from the same encoder. Those boxes belong to the initialisation assembly
 * keeps, so refusing over them rejected media that joins perfectly — and the
 * published title still carries the film's own values across the gap.
 *
 * So the comparison is not decoration. These tests prove it is load-bearing.
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
        joinKey: {
          mediaTimescale: 15360,
          sampleFormat: "avc1",
          width: 1920,
          height: 1080,
          configDigest: "a".repeat(64),
        },
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
   * The whole point. A changed SPS, a different profile or level, another
   * pixel format or other dimensions all change the decoder configuration, and
   * the decoder configuration is what the fragments are decoded with.
   */
  it("refuses to join epochs whose decoder configuration differs", async () => {
    await expect(
      assemble([
        manifest(0),
        manifest(1, {
          joinKey: {
            mediaTimescale: 15360,
            sampleFormat: "avc1",
            width: 1920,
            height: 1080,
            configDigest: "b".repeat(64),
          },
        }),
        manifest(2),
      ]),
    ).rejects.toThrow(/different decoder configuration/i);
  });

  it("refuses to join epochs encoded at different dimensions", async () => {
    await expect(
      assemble([
        manifest(0),
        manifest(1, {
          joinKey: {
            mediaTimescale: 15360,
            sampleFormat: "avc1",
            width: 1280,
            height: 720,
            configDigest: "a".repeat(64),
          },
        }),
      ]),
    ).rejects.toThrow(/1280x720 where the reference used 1920x1080/);
  });

  /**
   * Metadata that no fragment is decoded with must not refuse a join. This is
   * the salvage case: the replacement's own initialisation segment differs from
   * the film's, and is discarded by assembly anyway.
   */
  it("does not refuse an epoch whose initialisation differs only in metadata", async () => {
    /*
     * These manifests describe media that is not on disk, so assembly cannot
     * finish here — what is under test is that it gets past the compatibility
     * guard and fails on the missing bytes instead of refusing the join.
     */
    await expect(
      assemble([manifest(0), manifest(1, { initDigest: "b".repeat(64) })]),
    ).rejects.toThrow(/ENOENT/);
  });

  it("names the epoch that disagrees, so the right one is rebuilt", async () => {
    await expect(
      assemble([
        manifest(0),
        manifest(1),
        manifest(2, {
          joinKey: {
            mediaTimescale: 15360,
            sampleFormat: "avc1",
            width: 1920,
            height: 1080,
            configDigest: "c".repeat(64),
          },
        }),
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
      assemble([
        manifest(0),
        manifest(1, {
          joinKey: {
            mediaTimescale: 15360,
            sampleFormat: "avc1",
            width: 1920,
            height: 1080,
            configDigest: "b".repeat(64),
          },
        }),
      ]),
    ).rejects.toThrow();
    const staged = await readdir(
      path.join(workspace, "staging", "video", RENDITION),
    ).catch(() => []);
    expect(staged).toEqual([]);
  });

  /**
   * The timescale gets its own message. It is the one field assembly *uses* —
   * every offset is converted through it — so a mismatch is reported as itself
   * rather than as a generic difference an operator cannot act on.
   */
  it("refuses epochs muxed on different timescales, and says so plainly", async () => {
    await expect(
      assemble([
        manifest(0),
        manifest(1, {
          mediaTimescale: 90000,
          joinKey: {
            mediaTimescale: 90000,
            sampleFormat: "avc1",
            width: 1920,
            height: 1080,
            configDigest: "a".repeat(64),
          },
        }),
      ]),
    ).rejects.toThrow(/90000 media timescale where the reference used 15360/);
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
