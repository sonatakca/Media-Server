import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { RenditionAnalysisItem, RenditionPaths } from "./analysis";
import { processRenditionItem } from "./processor";

function itemFor(
  fingerprint = "a".repeat(64),
  overrides: Partial<RenditionAnalysisItem> = {},
): RenditionAnalysisItem {
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
        isHdr: false,
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
    adaptive: {
      status: "missing",
      eligible: true,
      estimatedVideoBytes: 1_000,
      estimatedAudioBytes: 100,
      estimatedTotalBytes: 1_100,
      expectedFileCount: 6,
      expectedSegmentCount: 12,
      isHdr: false,
    },
    ...overrides,
  };
}

/** A 4K letterboxed HDR master needing the full ladder from one decode. */
function scopeHdrItem(): RenditionAnalysisItem {
  const item = itemFor();
  return {
    ...item,
    probe: {
      ...item.probe!,
      video: {
        ...item.probe!.video,
        width: 3840,
        height: 1604,
        isHdr: true,
      },
    },
    requiredHeights: [480, 720, 1080],
    jobs: [
      { qualityHeight: 480, estimatedBytes: 1_000 },
      { qualityHeight: 720, estimatedBytes: 1_000 },
      { qualityHeight: 1080, estimatedBytes: 1_000 },
    ],
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
  const outputPaths = args.filter((argument) =>
    /\.partial\.mp4$/.test(argument),
  );
  for (const outputPath of outputPaths) {
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, "complete-standalone-mp4");
  }
}

const hdrLadderSizes: Record<string, { width: number; height: number }> = {
  "1080p.partial.mp4": { width: 1920, height: 802 },
  "720p.partial.mp4": { width: 1280, height: 534 },
  "480p.partial.mp4": { width: 854, height: 356 },
};

const hdrLadderProbe =
  (videoCodec: "h264" | "hevc" = "hevc") =>
  async (filePath: string) => {
    const size = hdrLadderSizes[path.basename(filePath)];
    if (!size) throw new Error(`unexpected variant ${filePath}`);
    return {
      durationSeconds: 12,
      width: size.width,
      height: size.height,
      videoCodec,
      audioCodec: "aac",
      audioLanguage: "tur",
      frameRate: 24,
      averageBitrate: 1_900_000,
    };
  };

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
      videoEncoder: "libx264" as const,
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
      videoEncoder: "libx264" as const,
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
      videoEncoder: "libx264" as const,
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

  it("rechecks free space immediately before the encode pass", async () => {
    const paths = await fixture();
    let checks = 0;
    const result = await processRenditionItem(itemFor(), paths, {
      reserveBytes: 100,
      verifySourceFingerprint: false,
      videoEncoder: "libx264" as const,
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

  it("produces the whole ladder from one decode and keeps HDR as HEVC Main 10", async () => {
    const paths = await fixture();
    const commands: string[][] = [];

    const result = await processRenditionItem(scopeHdrItem(), paths, {
      reserveBytes: 100,
      verifySourceFingerprint: false,
      videoEncoder: "libx264" as const,
      hdrVideoEncoder: "libx265" as const,
      driveSpaceProvider: async () => ({
        totalBytes: 10_000,
        freeBytes: 9_000,
      }),
      runEncoder: async (command, args) => {
        commands.push(args);
        await fakeEncode(command, args);
      },
      probeVariant: hdrLadderProbe("hevc"),
    });

    expect(result.status).toBe("ready");
    // One FFmpeg invocation, not one per rendition.
    expect(commands).toHaveLength(1);
    const [args] = commands;
    expect(args.filter((argument) => argument === "-i")).toHaveLength(1);
    expect(args.join(" ")).toContain("split=3");
    // HDR is carried through, so nothing is tone mapped and the codec is HEVC.
    expect(args.join(" ")).not.toContain("tonemap");
    expect(args).toContain("libx265");
    expect(args).toContain("smpte2084");
    expect(args).toContain("hvc1");
    expect(args.join(" ")).toContain("format=yuv420p10le");

    const versionRoot = path.join(
      paths.renditionRoot,
      scopeHdrItem().mediaId,
      result.versionDirectory as string,
    );
    const metadata = JSON.parse(
      await readFile(path.join(versionRoot, "metadata.json"), "utf8"),
    );
    expect(
      metadata.files.map(
        (file: { qualityHeight: number; width: number; height: number }) => [
          file.qualityHeight,
          file.width,
          file.height,
        ],
      ),
    ).toEqual([
      [480, 854, 356],
      [720, 1280, 534],
      [1080, 1920, 802],
    ]);
    expect(metadata.files[0]).toMatchObject({
      videoCodec: "hevc",
      videoEncoder: "libx265",
      hdr: true,
    });
    expect(metadata.files[0].tonemappedFromHdr).toBeUndefined();
  });

  it("tone maps HDR to SDR H.264 when the policy asks for it", async () => {
    const paths = await fixture();
    const commands: string[][] = [];

    const result = await processRenditionItem(scopeHdrItem(), paths, {
      reserveBytes: 100,
      verifySourceFingerprint: false,
      videoEncoder: "libx264" as const,
      hdrPolicy: "tonemap" as const,
      driveSpaceProvider: async () => ({
        totalBytes: 10_000,
        freeBytes: 9_000,
      }),
      runEncoder: async (command, args) => {
        commands.push(args);
        await fakeEncode(command, args);
      },
      probeVariant: hdrLadderProbe("h264"),
    });

    expect(result.status).toBe("ready");
    const [args] = commands;
    expect(args.join(" ")).toContain("tonemap=tonemap=hable");
    // Tone mapping runs once for the whole ladder, not per rendition.
    expect(args.join(" ").match(/tonemap=tonemap/g)).toHaveLength(1);
    expect(args).toContain("libx264");
    expect(args).not.toContain("libx265");

    const versionRoot = path.join(
      paths.renditionRoot,
      scopeHdrItem().mediaId,
      result.versionDirectory as string,
    );
    const metadata = JSON.parse(
      await readFile(path.join(versionRoot, "metadata.json"), "utf8"),
    );
    expect(metadata.files[0]).toMatchObject({
      videoCodec: "h264",
      tonemappedFromHdr: true,
    });
    expect(metadata.files[0].hdr).toBeUndefined();
  });
});
