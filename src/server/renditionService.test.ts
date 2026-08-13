// @vitest-environment node
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createRenditionService } from "./renditionService";
import { RENDITION_PROFILE_VERSION } from "../renditions/policy";
import type { PlaybackMediaResolver } from "../lib/playback-planner/playbackRoutes";
import {
  ADAPTIVE_POINTER_FILE,
  ADAPTIVE_PROFILE_VERSION,
} from "../renditions/adaptive/profile";

const mediaId = "jellyfin-item";
const renditionId = "11111111-1111-4111-8111-111111111111";
const fingerprint = "a".repeat(64);
const renditionBytes = Buffer.from("complete-mp4-file-data");

async function fixture({
  includeGenerated = true,
  registryStatus = "ready",
  hdr = false,
  includeAdaptive = false,
} = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "seyirlik-routes-"));
  const mediaRoot = path.join(root, "media");
  const renditionRoot = path.join(mediaRoot, ".seyirlik", "renditions");
  const stateRoot = path.join(mediaRoot, ".seyirlik", "state");
  const sourcePath = path.join(mediaRoot, "Movies", "Film.mkv");
  await mkdir(path.dirname(sourcePath), { recursive: true });
  await writeFile(sourcePath, "source");
  const sourceStats = await stat(sourcePath);
  const versionDirectory = `${RENDITION_PROFILE_VERSION}-${fingerprint.slice(0, 16)}`;
  const versionRoot = path.join(renditionRoot, renditionId, versionDirectory);
  await mkdir(versionRoot, { recursive: true });
  await mkdir(stateRoot, { recursive: true });
  await writeFile(
    path.join(stateRoot, "registry.json"),
    JSON.stringify({
      schemaVersion: 1,
      profileVersion: RENDITION_PROFILE_VERSION,
      updatedAt: new Date().toISOString(),
      items: [
        {
          id: renditionId,
          relativePath: "Movies/Film.mkv",
          size: sourceStats.size,
          mtimeMs: sourceStats.mtimeMs,
          sourceFingerprint: fingerprint,
          profileVersion: RENDITION_PROFILE_VERSION,
          lastSeenAt: new Date().toISOString(),
          status: registryStatus,
          ...(includeAdaptive
            ? {
                adaptiveStatus: "ready",
                adaptiveProfileVersion: ADAPTIVE_PROFILE_VERSION,
              }
            : {}),
        },
      ],
    }),
  );
  if (includeGenerated) {
    await writeFile(
      path.join(renditionRoot, renditionId, "current.json"),
      JSON.stringify({
        schemaVersion: 2,
        versionDirectory,
        sourceFingerprint: fingerprint,
        profileVersion: RENDITION_PROFILE_VERSION,
      }),
    );
    await writeFile(path.join(versionRoot, "480p.mp4"), renditionBytes);
    await writeFile(
      path.join(versionRoot, "metadata.json"),
      JSON.stringify({
        schemaVersion: 3,
        mediaId: renditionId,
        sourceFingerprint: fingerprint,
        profileVersion: RENDITION_PROFILE_VERSION,
        createdAt: new Date().toISOString(),
        durationSeconds: 60,
        original: {
          width: 1920,
          height: 1080,
          qualityHeight: 1080,
          codec: "hevc",
        },
        files: [
          {
            qualityHeight: 480,
            width: 854,
            height: 360,
            bitrate: 2_000_000,
            fileSize: renditionBytes.length,
            videoCodec: hdr ? "hevc" : "h264",
            audioCodec: "aac",
            container: "mp4",
            frameRate: 24,
            file: "480p.mp4",
            sourceAudioStreamIndex: 1,
            audioLanguage: "tur",
            ...(hdr ? { hdr: true } : {}),
          },
        ],
        audioStrategy: "default-track-only",
        subtitleStrategy: "original-playback-only",
        validation: {
          validatedAt: new Date().toISOString(),
          durationToleranceSeconds: 2,
        },
      }),
    );
  }
  if (includeAdaptive) {
    const adaptiveDirectory = `${ADAPTIVE_PROFILE_VERSION}-${fingerprint.slice(0, 16)}`;
    const adaptiveRoot = path.join(
      renditionRoot,
      renditionId,
      adaptiveDirectory,
    );
    const videoBytes = Buffer.from("video-cmaf-bytes");
    const audioBytes = Buffer.from("audio-cmaf-bytes");
    await mkdir(path.join(adaptiveRoot, "video", "720p"), {
      recursive: true,
    });
    await mkdir(path.join(adaptiveRoot, "audio", "track-1"), {
      recursive: true,
    });
    await writeFile(path.join(adaptiveRoot, "master.m3u8"), "#EXTM3U\n");
    await writeFile(
      path.join(adaptiveRoot, "video", "720p", "playlist.m3u8"),
      "#EXTM3U\n",
    );
    await writeFile(
      path.join(adaptiveRoot, "audio", "track-1", "playlist.m3u8"),
      "#EXTM3U\n",
    );
    await writeFile(
      path.join(adaptiveRoot, "video", "720p", "media.m4s"),
      videoBytes,
    );
    await writeFile(
      path.join(adaptiveRoot, "audio", "track-1", "media.m4s"),
      audioBytes,
    );
    await writeFile(
      path.join(renditionRoot, renditionId, ADAPTIVE_POINTER_FILE),
      JSON.stringify({
        schemaVersion: 1,
        versionDirectory: adaptiveDirectory,
        sourceFingerprint: fingerprint,
        profileVersion: ADAPTIVE_PROFILE_VERSION,
      }),
    );
    await writeFile(
      path.join(adaptiveRoot, "metadata.json"),
      JSON.stringify({
        schemaVersion: 1,
        profileVersion: ADAPTIVE_PROFILE_VERSION,
        mediaId: renditionId,
        sourceFingerprint: fingerprint,
        createdAt: "2026-08-13T10:00:00.000Z",
        sourceDurationSeconds: 60,
        source: {
          width: 1920,
          height: 1080,
          qualityHeight: 1080,
          codec: "h264",
          frameRate: 24,
          isHdr: false,
          isVariableFrameRate: false,
          rotation: 0,
        },
        segmentTargetSeconds: 2,
        switchingSetDurationSeconds: 60,
        masterPlaylistPath: "master.m3u8",
        videoRenditions: [
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
            peakBitrate: 3_500_000,
            durationSeconds: 60,
            playlistPath: "video/720p/playlist.m3u8",
            mediaPath: "video/720p/media.m4s",
            fileSizeBytes: videoBytes.length,
            keyframeCount: 30,
            keyframeIntervalSeconds: {
              target: 2,
              minimum: 2,
              maximum: 2,
              mean: 2,
            },
            segmentCount: 30,
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
            averageBitrate: 192_000,
            durationSeconds: 60,
            playlistPath: "audio/track-1/playlist.m3u8",
            mediaPath: "audio/track-1/media.m4s",
            fileSizeBytes: audioBytes.length,
            streamCopied: true,
          },
        ],
        validation: {
          validatedAt: "2026-08-13T10:00:00.000Z",
          alignmentToleranceSeconds: 0.05,
          audioDurationToleranceSeconds: 0.5,
          checks: ["segment-alignment"],
        },
        storage: {
          videoBytes: videoBytes.length,
          audioBytes: audioBytes.length,
          totalBytes: videoBytes.length + audioBytes.length,
        },
      }),
    );
  }

  const tokens = new Map<string, string>();
  const resolver: PlaybackMediaResolver = {
    resolveMedia: async (requestedId) => {
      if (requestedId !== mediaId) throw new Error("not found");
      return {
        mediaId,
        filePath: sourcePath,
        size: sourceStats.size,
        mtimeMs: sourceStats.mtimeMs,
      };
    },
    encodeMediaToken: (requestedId) => {
      const token = "opaque-capability";
      tokens.set(token, requestedId);
      return token;
    },
    decodeMediaToken: (token) => {
      const requestedId = tokens.get(token);
      if (!requestedId) throw new Error("invalid token");
      return requestedId;
    },
  };
  const service = createRenditionService({
    mediaRoot,
    renditionRoot,
    stateRoot,
    mediaResolver: resolver,
  });
  return { service, sourcePath, root };
}

/** Splits a manifest playback URL back into the pair the resolver takes. */
function addressOf(playbackUrl: string): { token: string; fileId: string } {
  const parts = playbackUrl.split("/");
  return {
    token: decodeURIComponent(parts[parts.length - 2] ?? ""),
    fileId: decodeURIComponent(parts[parts.length - 1] ?? ""),
  };
}

describe("complete-file rendition routes", () => {
  it("returns only ready complete files and resolves them to real bytes", async () => {
    const { service, sourcePath } = await fixture();
    const sourceStats = await stat(sourcePath);
    const manifest = await service.createManifest(
      {
        mediaId,
        filePath: sourcePath,
        size: sourceStats.size,
        mtimeMs: sourceStats.mtimeMs,
      },
      {
        width: 1920,
        height: 1080,
        codec: "hevc",
        playableUrl: "/api/playback/direct/original",
      },
    );

    expect(
      manifest.qualities.map((quality) => [quality.kind, quality.height]),
    ).toEqual([
      ["original", 1080],
      ["generated", 480],
    ]);
    const generated = manifest.qualities.find(
      (quality) => quality.kind === "generated",
    );
    expect(generated?.playbackUrl).toMatch(
      /^\/api\/playback\/renditions\/opaque-capability\/480-[a-f0-9]{12}\.mp4$/,
    );
    expect(JSON.stringify(manifest)).not.toContain(sourcePath);
    expect(JSON.stringify(manifest)).not.toContain("480p.mp4");

    // Resolution hands back the validated file; the playback route streams it
    // with the same byte-range implementation the original file uses.
    const address = addressOf(generated?.playbackUrl ?? "");
    const resolved = await service.resolveFile(address.token, address.fileId);
    expect(resolved?.sizeBytes).toBe(renditionBytes.length);
    expect(await readFile(resolved?.absolutePath ?? "", "utf8")).toBe(
      renditionBytes.toString("utf8"),
    );
  });

  it("returns an original-only manifest when no validated generated file exists", async () => {
    const { service, sourcePath } = await fixture({ includeGenerated: false });
    const sourceStats = await stat(sourcePath);
    const manifest = await service.createManifest(
      {
        mediaId,
        filePath: sourcePath,
        size: sourceStats.size,
        mtimeMs: sourceStats.mtimeMs,
      },
      {
        width: 1920,
        height: 1080,
        codec: "hevc",
        playableUrl: "/api/playback/direct/original",
      },
    );

    expect(manifest.qualities).toEqual([
      expect.objectContaining({ kind: "original", height: 1080 }),
    ]);
  });

  it("omits complete files whose registry record is not ready", async () => {
    const { service, sourcePath } = await fixture({ registryStatus: "failed" });
    const sourceStats = await stat(sourcePath);
    const manifest = await service.createManifest(
      {
        mediaId,
        filePath: sourcePath,
        size: sourceStats.size,
        mtimeMs: sourceStats.mtimeMs,
      },
      {
        width: 1920,
        height: 1080,
        codec: "hevc",
        playableUrl: "/api/playback/direct/original",
      },
    );

    expect(manifest.qualities).toEqual([
      expect.objectContaining({ kind: "original", height: 1080 }),
    ]);
  });

  it.each(["already-valid", "pending"])(
    "still exposes validated complete files when the registry record is %s",
    async (registryStatus) => {
      const { service, sourcePath } = await fixture({ registryStatus });
      const sourceStats = await stat(sourcePath);
      const manifest = await service.createManifest(
        {
          mediaId,
          filePath: sourcePath,
          size: sourceStats.size,
          mtimeMs: sourceStats.mtimeMs,
        },
        {
          width: 1920,
          height: 1080,
          codec: "hevc",
          playableUrl: "/api/playback/direct/original",
        },
      );

      expect(
        manifest.qualities.map((quality) => [quality.kind, quality.height]),
      ).toEqual([
        ["original", 1080],
        ["generated", 480],
      ]);
    },
  );

  it("offers an HDR HEVC rendition only to a client that can decode HEVC", async () => {
    const { service, sourcePath } = await fixture({ hdr: true });
    const sourceStats = await stat(sourcePath);
    const media = {
      mediaId,
      filePath: sourcePath,
      size: sourceStats.size,
      mtimeMs: sourceStats.mtimeMs,
    };
    const original = {
      width: 1920,
      height: 1080,
      codec: "hevc",
      playableUrl: "/api/playback/direct/original",
    };

    const hevcClient = await service.createManifest(media, original, {
      hevc: true,
      h264: true,
    });
    expect(
      hevcClient.qualities.map((quality) => [quality.kind, quality.hdr]),
    ).toEqual([
      ["original", undefined],
      ["generated", true],
    ]);

    // Without HEVC the file is undecodable, so it must not be offered at all —
    // playback falls back to the existing transcode path instead.
    const h264OnlyClient = await service.createManifest(media, original, {
      hevc: false,
      h264: true,
    });
    expect(h264OnlyClient.qualities).toEqual([
      expect.objectContaining({ kind: "original" }),
    ]);
  });

  it("rejects traversal and unregistered files without exposing filesystem paths", async () => {
    const { service, sourcePath, root } = await fixture();
    const sourceStats = await stat(sourcePath);
    await service.createManifest(
      {
        mediaId,
        filePath: sourcePath,
        size: sourceStats.size,
        mtimeMs: sourceStats.mtimeMs,
      },
      { width: 1920, height: 1080, codec: "hevc" },
    );
    // Nothing outside the validated output root resolves, and neither does a
    // file that was never registered — possession of the token is not enough.
    expect(
      await service.resolveFile("opaque-capability", "../metadata.mp4"),
    ).toBeNull();
    expect(
      await service.resolveFile("opaque-capability", "not-registered.mp4"),
    ).toBeNull();
    expect(
      await service.resolveFile("unknown-token", "480-abc123def456.mp4"),
    ).toBeNull();
    expect(root).toBeTruthy();
  });

  it("offers and resolves only registered adaptive package assets", async () => {
    const { service, sourcePath } = await fixture({ includeAdaptive: true });
    const sourceStats = await stat(sourcePath);
    const manifest = await service.createManifest(
      {
        mediaId,
        filePath: sourcePath,
        size: sourceStats.size,
        mtimeMs: sourceStats.mtimeMs,
      },
      undefined,
      { h264: true, hevc: false },
    );

    expect(manifest.adaptive).toMatchObject({
      profileVersion: ADAPTIVE_PROFILE_VERSION,
      switching: "aligned-cmaf-hls",
      qualities: [{ id: "720p", height: 720 }],
    });
    const versionId = fingerprint.slice(0, 12);
    const master = await service.resolveAdaptiveAsset(
      "opaque-capability",
      versionId,
      "master.m3u8",
    );
    const media = await service.resolveAdaptiveAsset(
      "opaque-capability",
      versionId,
      "video/720p/media.m4s",
    );
    expect(master?.contentType).toBe("application/vnd.apple.mpegurl");
    expect(await readFile(media?.absolutePath ?? "", "utf8")).toBe(
      "video-cmaf-bytes",
    );
    await expect(
      service.resolveAdaptiveAsset(
        "opaque-capability",
        versionId,
        "video/720p/../../metadata.json",
      ),
    ).resolves.toBeNull();
  });
});
