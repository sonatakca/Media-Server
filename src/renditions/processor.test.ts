import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { RenditionAnalysisItem, RenditionPaths } from "./analysis";
import { processRenditionItem } from "./processor";

function itemFor(fingerprint = "a".repeat(64)): RenditionAnalysisItem {
  return {
    mediaId: "11111111-1111-4111-8111-111111111111",
    relativePath: "Movies/Film.mkv",
    library: "Movies",
    sourceSizeBytes: 10,
    sourceMtimeMs: 1,
    sourceFingerprint: fingerprint,
    status: "pending",
    probe: {
      durationSeconds: 12,
      video: {
        streamIndex: 0,
        codec: "hevc",
        width: 1920,
        height: 1080,
        rotation: 0,
        frameRate: 24,
      },
      audioTracks: [
        {
          streamIndex: 1,
          codec: "aac",
          language: "tur",
          isDefault: true,
        },
      ],
      subtitleTracks: [],
      chapters: [],
    },
    existingHeights: [],
    requiredHeights: [480],
    jobs: [{ qualityHeight: 480, estimatedBytes: 1_000 }],
  };
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "seyirlik-process-"));
  const paths: RenditionPaths = {
    mediaRoot: path.join(root, "media"),
    renditionRoot: path.join(root, "media", ".seyirlik", "renditions"),
    workRoot: path.join(root, "media", ".seyirlik", "work"),
    stateRoot: path.join(root, "media", ".seyirlik", "state"),
    logsRoot: path.join(root, "media", ".seyirlik", "logs"),
  };
  await mkdir(path.join(paths.mediaRoot, "Movies"), { recursive: true });
  await writeFile(path.join(paths.mediaRoot, "Movies", "Film.mkv"), "source");
  return paths;
}

async function fakeEncode(_command: string, args: string[]) {
  const outputPath = args[args.length - 1] as string;
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, "complete-standalone-mp4");
}

const validProbe = async () => ({
  durationSeconds: 12,
  width: 854,
  height: 480,
  videoCodec: "h264",
  audioCodec: "aac",
  audioLanguage: "tur",
  frameRate: 24,
  averageBitrate: 1_900_000,
});

describe("resumable standalone rendition processing", () => {
  it("validates, atomically promotes, and skips the same completed MP4 version", async () => {
    const paths = await fixture();
    let encodeCount = 0;
    const options = {
      ffmpegPath: "ffmpeg",
      reserveBytes: 100,
      verifySourceFingerprint: false,
      driveSpaceProvider: async () => ({
        totalBytes: 10_000,
        freeBytes: 9_000,
      }),
      runEncoder: async (command: string, args: string[]) => {
        encodeCount += 1;
        await fakeEncode(command, args);
      },
      probeVariant: validProbe,
    };

    const first = await processRenditionItem(itemFor(), paths, options);
    const second = await processRenditionItem(itemFor(), paths, options);

    expect(first).toMatchObject({ status: "ready" });
    expect(second.status).toBe("already-valid");
    expect(encodeCount).toBe(1);
    const versionRoot = path.join(
      paths.renditionRoot,
      itemFor().mediaId,
      first.versionDirectory as string,
    );
    await expect(
      readFile(path.join(versionRoot, "480p.mp4"), "utf8"),
    ).resolves.toBe("complete-standalone-mp4");
    const metadata = JSON.parse(
      await readFile(path.join(versionRoot, "metadata.json"), "utf8"),
    );
    expect(metadata.files).toEqual([
      expect.objectContaining({
        file: "480p.mp4",
        container: "mp4",
        videoCodec: "h264",
        audioCodec: "aac",
        sourceAudioStreamIndex: 1,
        audioLanguage: "tur",
      }),
    ]);
  });

  it("uses a complete MP4 encoder command and never requests HLS artifacts", async () => {
    const paths = await fixture();
    let capturedArgs: string[] = [];
    const result = await processRenditionItem(itemFor(), paths, {
      reserveBytes: 100,
      verifySourceFingerprint: false,
      driveSpaceProvider: async () => ({
        totalBytes: 10_000,
        freeBytes: 9_000,
      }),
      runEncoder: async (command, args) => {
        capturedArgs = args;
        await fakeEncode(command, args);
      },
      probeVariant: validProbe,
    });

    expect(result.status).toBe("ready");
    expect(capturedArgs).toContain("+faststart");
    expect(capturedArgs.at(-1)).toMatch(/480p\.partial\.mp4$/);
    expect(capturedArgs.join(" ")).not.toMatch(
      /m3u8|m4s|hls_segment|\s-f\s+hls/i,
    );
  });

  it("never promotes partial work after an encoding failure", async () => {
    const paths = await fixture();
    const result = await processRenditionItem(itemFor(), paths, {
      ffmpegPath: "ffmpeg",
      reserveBytes: 100,
      verifySourceFingerprint: false,
      driveSpaceProvider: async () => ({
        totalBytes: 10_000,
        freeBytes: 9_000,
      }),
      runEncoder: async (_command, args) => {
        const outputPath = args[args.length - 1] as string;
        await mkdir(path.dirname(outputPath), { recursive: true });
        await writeFile(outputPath, "truncated");
        throw new Error("encoder interrupted");
      },
      probeVariant: async () => {
        throw new Error("must not validate");
      },
    });

    expect(result.status).toBe("failed");
    await expect(
      readFile(
        path.join(paths.renditionRoot, itemFor().mediaId, "current.json"),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rechecks free space immediately before encoding each complete file", async () => {
    const paths = await fixture();
    let checks = 0;
    const result = await processRenditionItem(itemFor(), paths, {
      reserveBytes: 100,
      verifySourceFingerprint: false,
      driveSpaceProvider: async () => {
        checks += 1;
        return checks === 1
          ? { totalBytes: 10_000, freeBytes: 9_000 }
          : { totalBytes: 10_000, freeBytes: 1_000 };
      },
      runEncoder: async () => {
        throw new Error("must not encode");
      },
      probeVariant: validProbe,
    });

    expect(result.status).toBe("deferred-for-storage");
    expect(checks).toBe(2);
  });
});
