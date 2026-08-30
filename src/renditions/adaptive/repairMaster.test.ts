import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  MASTER_LAYOUT_VERSION,
  recordedMasterLayoutVersion,
  repairTitleMaster,
} from "./repairMaster";

/**
 * Repairing the description of a package without touching the media.
 *
 * The case that motivated this: variants were listed cheapest-first, so a
 * native player opened every title on the smallest rung. Correcting the order
 * changes only the master, and re-encoding hours of video to obtain a new
 * playlist would be absurd — but without a repair path that is the only way an
 * existing title could receive the fix.
 */

function buildRecord(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    profileVersion: "cmaf-hls-aligned-v3",
    mediaId: "media-1",
    sourceFingerprint: "f".repeat(64),
    createdAt: "2026-08-30T00:00:00.000Z",
    sourceDurationSeconds: 90,
    masterPlaylistPath: ".seyirlik/master.m3u8",
    videoRenditions: [
      {
        id: "144p",
        qualityHeight: 144,
        width: 256,
        height: 144,
        codec: "h264",
        codecString: "avc1.64000c",
        pixelFormat: "yuv420p",
        hdr: "sdr",
        frameRate: 24,
        averageBitrate: 180_000,
        peakBitrate: 200_000,
        durationSeconds: 90,
        playlistPath: ".seyirlik/video/144p.m3u8",
        mediaPath: "video/144p.mp4",
        fileSizeBytes: 100,
      },
      {
        id: "720p",
        qualityHeight: 720,
        width: 1280,
        height: 720,
        codec: "h264",
        codecString: "avc1.64001f",
        pixelFormat: "yuv420p",
        hdr: "sdr",
        frameRate: 24,
        averageBitrate: 3_000_000,
        peakBitrate: 3_400_000,
        durationSeconds: 90,
        playlistPath: ".seyirlik/video/720p.m3u8",
        mediaPath: "video/720p.mp4",
        fileSizeBytes: 900,
      },
    ],
    audioRenditions: [
      {
        id: "track-1",
        sourceStreamIndex: 1,
        language: "eng",
        isDefault: true,
        isForced: false,
        codec: "aac",
        codecString: "mp4a.40.2",
        channels: 2,
        sampleRate: 48_000,
        averageBitrate: 128_000,
        durationSeconds: 90,
        playlistPath: ".seyirlik/audio/english.m3u8",
        mediaPath: "audio/english.m4a",
        fileSizeBytes: 50,
        streamCopied: false,
      },
    ],
    subtitleRenditions: [],
    ...overrides,
  };
}

async function titleWith(record: Record<string, unknown>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "seyirlik-repair-"));
  await mkdir(path.join(root, ".seyirlik"), { recursive: true });
  await writeFile(
    path.join(root, ".seyirlik", "build.json"),
    JSON.stringify(record, null, 2),
    "utf8",
  );
  await writeFile(
    path.join(root, ".seyirlik", "master.m3u8"),
    "#EXTM3U\n# stale\n",
    "utf8",
  );
  return root;
}

describe("repairing a package's master playlist", () => {
  it("rewrites a pre-versioned master and leads with the opening rung", async () => {
    const root = await titleWith(buildRecord());

    const result = await repairTitleMaster(root);
    expect(result.status).toBe("updated");
    expect(result.previousVersion).toBe(1);

    const master = await readFile(
      path.join(root, ".seyirlik", "master.m3u8"),
      "utf8",
    );
    expect(master.indexOf("video/720p.m3u8")).toBeLessThan(
      master.indexOf("video/144p.m3u8"),
    );
    // The playlist names its neighbours relative to itself, not to the title.
    expect(master).not.toContain(".seyirlik/video/");
    expect(master).toContain('URI="audio/english.m3u8"');
  });

  it("stamps the version so the same repair does not run twice", async () => {
    const root = await titleWith(buildRecord());

    await repairTitleMaster(root);
    const second = await repairTitleMaster(root);

    expect(second.status).toBe("current");
    expect(second.previousVersion).toBe(MASTER_LAYOUT_VERSION);
  });

  it("leaves a package alone when it is already current", async () => {
    const root = await titleWith(
      buildRecord({ masterLayoutVersion: MASTER_LAYOUT_VERSION }),
    );

    const before = await readFile(
      path.join(root, ".seyirlik", "master.m3u8"),
      "utf8",
    );
    expect((await repairTitleMaster(root)).status).toBe("current");
    expect(
      await readFile(path.join(root, ".seyirlik", "master.m3u8"), "utf8"),
    ).toBe(before);
  });

  /**
   * A master can only be regenerated faithfully from codec strings measured off
   * the real bitstream. Inventing them would produce a playlist that lies about
   * what a player is about to decode.
   */
  it("refuses to guess when the build record has no codec strings", async () => {
    const record = buildRecord();
    (record.videoRenditions as Array<Record<string, unknown>>)[0].codecString =
      "";
    const root = await titleWith(record);

    const result = await repairTitleMaster(root);
    expect(result.status).toBe("unsupported");
    expect(result.reason).toMatch(/codec/i);
  });

  it("reports a package with no build record rather than throwing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "seyirlik-repair-"));
    await mkdir(path.join(root, ".seyirlik"), { recursive: true });

    const result = await repairTitleMaster(root);
    expect(result.status).toBe("unsupported");
  });

  it("treats a record without a version as the original layout", () => {
    expect(
      recordedMasterLayoutVersion({
        masterPlaylistPath: ".seyirlik/master.m3u8",
      }),
    ).toBe(1);
    expect(
      recordedMasterLayoutVersion({
        masterPlaylistPath: ".seyirlik/master.m3u8",
        masterLayoutVersion: 5,
      }),
    ).toBe(5);
  });
});
