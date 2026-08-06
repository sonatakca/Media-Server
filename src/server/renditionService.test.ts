// @vitest-environment node
import { createServer } from "node:http";
import { mkdtemp, mkdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  createRenditionService,
  type RenditionService,
} from "./renditionService";
import { RENDITION_PROFILE_VERSION } from "../renditions/policy";
import type { PlaybackMediaResolver } from "../lib/playback-planner/playbackRoutes";

const mediaId = "jellyfin-item";
const renditionId = "11111111-1111-4111-8111-111111111111";
const fingerprint = "a".repeat(64);
const renditionBytes = Buffer.from("complete-mp4-file-data");
let closeServer: (() => Promise<void>) | undefined;

async function fixture({
  includeGenerated = true,
  registryStatus = "ready",
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
            videoCodec: "h264",
            audioCodec: "aac",
            container: "mp4",
            frameRate: 24,
            file: "480p.mp4",
            sourceAudioStreamIndex: 1,
            audioLanguage: "tur",
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

async function listen(service: RenditionService) {
  const server = createServer(async (request, response) => {
    if (!(await service.handleRequest(request, response))) {
      response.statusCode = 404;
      response.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closeServer = () =>
    new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  await closeServer?.();
  closeServer = undefined;
});

describe("complete-file rendition routes", () => {
  it("returns only ready complete files and serves MP4 byte ranges", async () => {
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

    const origin = await listen(service);
    const response = await fetch(`${origin}${generated?.playbackUrl}`, {
      headers: { Range: "bytes=0-7" },
    });
    expect(response.status).toBe(206);
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("content-range")).toBe(
      `bytes 0-7/${renditionBytes.length}`,
    );
    expect(response.headers.get("content-length")).toBe("8");
    expect(await response.text()).toBe("complete");
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
    const origin = await listen(service);

    const traversal = await fetch(
      `${origin}/api/playback/renditions/opaque-capability/..%2Fmetadata.mp4`,
    );
    expect([400, 404]).toContain(traversal.status);
    expect(await traversal.text()).not.toContain(root);

    const unregistered = await fetch(
      `${origin}/api/playback/renditions/opaque-capability/not-registered.mp4`,
    );
    expect(unregistered.status).toBe(404);
    expect(await unregistered.text()).not.toContain("D:\\media");
  });
});
