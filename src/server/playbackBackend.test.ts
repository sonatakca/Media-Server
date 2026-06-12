// @vitest-environment node
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createPlaybackBackend, type PlaybackBackend } from "./playbackBackend";
import { createMediaRegistry } from "./mediaRegistry";
import type { PlaybackMediaStore } from "../lib/playback-planner/playbackRoutes";
import type {
  ClientCapabilities,
  MediaAnalysis,
} from "../lib/playback-planner/types";

let backends: PlaybackBackend[] = [];
let mediaRoots: string[] = [];

function clientCapabilities(): ClientCapabilities {
  return {
    supportsHlsNative: false,
    supportsMediaSource: true,
    directFileContainers: ["mp4"],
    mseContainers: ["mp4"],
    video: {
      h264: { supported: true, supports10Bit: false, supportsHdr: false },
    },
    audio: {
      aac: { supported: true, maxChannels: 2 },
    },
    subtitles: {
      srtExternal: false,
      webvttExternal: true,
      assExternal: false,
      imageBasedExternal: false,
    },
    testedAt: "2026-01-01T00:00:00.000Z",
  };
}

function analysis(mediaId: string, filePath: string): MediaAnalysis {
  return {
    mediaId,
    filePath,
    container: {
      formatName: "mov,mp4,m4a,3gp,3g2,mj2",
      extension: "mp4",
      isBrowserDirectPlayableContainer: true,
    },
    durationSeconds: 10,
    videoStreams: [
      {
        index: 0,
        codecName: "h264",
        profile: "High",
        width: 1920,
        height: 1080,
        bitDepth: 8,
      },
    ],
    audioStreams: [
      {
        index: 1,
        codecName: "aac",
        channels: 2,
        isDefault: true,
      },
    ],
    subtitleStreams: [],
    analysedAt: "2026-01-01T00:00:00.000Z",
  };
}

async function createFixtureBackend() {
  const mediaRoot = await mkdtemp(path.join(tmpdir(), "seyirlik-http-media-"));

  await mkdir(path.join(mediaRoot, "Movies"), { recursive: true });
  await writeFile(path.join(mediaRoot, "Movies", "sample.mp4"), "0123456789");

  const mediaRegistry = await createMediaRegistry(mediaRoot);
  const mediaStore: PlaybackMediaStore = {
    getMediaAnalysis: (media) =>
      Promise.resolve(analysis(media.mediaId, media.filePath)),
    saveClientCapabilities: () => undefined,
  };
  const backend = await createPlaybackBackend({
    host: "127.0.0.1",
    port: 0,
    mediaRegistry,
    mediaStore,
    allowedOrigins: ["http://allowed.test"],
    cleanupIntervalMs: 1_000,
  });

  await new Promise<void>((resolveListen) => {
    backend.server.listen(0, "127.0.0.1", resolveListen);
  });

  backends.push(backend);
  mediaRoots.push(mediaRoot);

  const address = backend.server.address() as AddressInfo;

  return {
    backend,
    mediaRoot,
    baseUrl: `http://127.0.0.1:${address.port}`,
    mediaToken: mediaRegistry.encodeMediaToken("Movies/sample.mp4"),
    traversalToken: mediaRegistry.encodeMediaToken("../secret.mp4"),
  };
}

afterEach(async () => {
  const currentBackends = backends;
  const currentMediaRoots = mediaRoots;

  backends = [];
  mediaRoots = [];

  await Promise.all(currentBackends.map((backend) => backend.close()));
  await Promise.all(
    currentMediaRoots.map((mediaRoot) =>
      rm(mediaRoot, { recursive: true, force: true }),
    ),
  );
});

describe("playback backend HTTP routes", () => {
  it("serves the health route", async () => {
    const { baseUrl } = await createFixtureBackend();
    const response = await fetch(`${baseUrl}/health`);

    await expect(response.json()).resolves.toEqual({
      status: "ok",
      service: "seyirlik-playback-backend",
    });
  });

  it("sets CORS headers for valid origins", async () => {
    const { baseUrl } = await createFixtureBackend();
    const response = await fetch(`${baseUrl}/health`, {
      headers: { Origin: "http://allowed.test" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "http://allowed.test",
    );
    expect(response.headers.get("vary")).toBe("Origin");
  });

  it("rejects disallowed CORS origins", async () => {
    const { baseUrl } = await createFixtureBackend();
    const response = await fetch(`${baseUrl}/health`, {
      headers: { Origin: "http://evil.test" },
    });

    expect(response.status).toBe(403);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("handles valid OPTIONS preflight", async () => {
    const { baseUrl } = await createFixtureBackend();
    const response = await fetch(`${baseUrl}/api/playback/request`, {
      method: "OPTIONS",
      headers: {
        Origin: "http://allowed.test",
        "Access-Control-Request-Method": "POST",
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-methods")).toContain(
      "POST",
    );
  });

  it("returns a direct playback plan with an opaque media token", async () => {
    const { baseUrl } = await createFixtureBackend();
    const response = await fetch(`${baseUrl}/api/playback/request`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mediaId: "Movies/sample.mp4",
        clientCapabilities: clientCapabilities(),
      }),
    });
    const payload = (await response.json()) as {
      mode: string;
      delivery: { type: string; url: string };
    };

    expect(response.status).toBe(200);
    expect(payload.mode).toBe("direct-play");
    expect(payload.delivery.type).toBe("file");
    expect(payload.delivery.url).toMatch(
      /^\/api\/playback\/direct\/[A-Za-z0-9_-]+$/,
    );
    expect(payload.delivery.url).not.toContain("Movies/sample.mp4");
  });

  it("streams a full direct response", async () => {
    const { baseUrl, mediaToken } = await createFixtureBackend();
    const response = await fetch(
      `${baseUrl}/api/playback/direct/${mediaToken}`,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("content-length")).toBe("10");
    await expect(response.text()).resolves.toBe("0123456789");
  });

  it("streams valid byte ranges with 206", async () => {
    const { baseUrl, mediaToken } = await createFixtureBackend();
    const response = await fetch(
      `${baseUrl}/api/playback/direct/${mediaToken}`,
      {
        headers: { Range: "bytes=2-5" },
      },
    );

    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(response.headers.get("content-length")).toBe("4");
    await expect(response.text()).resolves.toBe("2345");
  });

  it("responds to direct HEAD requests without a body", async () => {
    const { baseUrl, mediaToken } = await createFixtureBackend();
    const response = await fetch(
      `${baseUrl}/api/playback/direct/${mediaToken}`,
      {
        method: "HEAD",
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("content-length")).toBe("10");
    await expect(response.text()).resolves.toBe("");
  });

  it("returns 416 for unsatisfiable ranges", async () => {
    const { baseUrl, mediaToken } = await createFixtureBackend();
    const response = await fetch(
      `${baseUrl}/api/playback/direct/${mediaToken}`,
      {
        headers: { Range: "bytes=99-100" },
      },
    );

    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe("bytes */10");
  });

  it("rejects invalid media tokens", async () => {
    const { baseUrl } = await createFixtureBackend();
    const response = await fetch(`${baseUrl}/api/playback/direct/not+a+token`);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "MEDIA_TOKEN_INVALID" },
    });
  });

  it("rejects traversal attempts after token decoding", async () => {
    const { baseUrl, traversalToken } = await createFixtureBackend();
    const response = await fetch(
      `${baseUrl}/api/playback/direct/${traversalToken}`,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "MEDIA_ID_INVALID" },
    });
  });

  it("stops missing sessions idempotently", async () => {
    const { baseUrl } = await createFixtureBackend();
    const response = await fetch(
      `${baseUrl}/api/playback/sessions/missing-session/stop`,
      { method: "POST" },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      stopped: false,
    });
  });
});
