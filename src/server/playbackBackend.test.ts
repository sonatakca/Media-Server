// @vitest-environment node
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPlaybackBackend, type PlaybackBackend } from "./playbackBackend";
import { createMediaRegistry } from "./mediaRegistry";
import type {
  PlaybackMediaResolver,
  PlaybackMediaStore,
  PlaybackResolvedMedia,
} from "../lib/playback-planner/playbackRoutes";
import type {
  PlaybackSession,
  PlaybackSessionManager,
} from "../lib/playback-planner/playbackSessionManager";
import type {
  ClientCapabilities,
  MediaAnalysis,
  PlaybackDiagnostics,
  PlaybackPlan,
} from "../lib/playback-planner/types";

let backends: PlaybackBackend[] = [];
let mediaRoots: string[] = [];

function clientCapabilities(): ClientCapabilities {
  return {
    supportsHlsNative: false,
    supportsMediaSource: true,
    directFileContainers: ["mp4", "m4v", "mov"],
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

function movAnalysis(mediaId: string, filePath: string): MediaAnalysis {
  return {
    ...analysis(mediaId, filePath),
    filePath,
    container: {
      formatName: "mov,mp4,m4a,3gp,3g2,mj2",
      extension: "mov",
      isBrowserDirectPlayableContainer: true,
    },
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

async function writeMediaFile(
  mediaRoot: string,
  relativePath: string,
  contents = "0123456789",
) {
  const filePath = path.join(mediaRoot, ...relativePath.split("/"));

  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, contents);
  return filePath;
}

function hlsAnalysis(mediaId: string, filePath: string): MediaAnalysis {
  return {
    ...analysis(mediaId, filePath),
    videoStreams: [
      {
        index: 0,
        codecName: "hevc",
        profile: "Main 10",
        width: 3840,
        height: 2160,
        bitDepth: 10,
      },
    ],
  };
}

function createFakeResolver(
  mediaRoot: string,
  resolvedMedia: PlaybackResolvedMedia,
): PlaybackMediaResolver & { mediaRoot: string } {
  const mediaIdsByToken = new Map<string, string>();
  let tokenCount = 0;

  return {
    mediaRoot,
    resolveMedia: vi.fn(async (mediaId: string) => {
      if (mediaId !== resolvedMedia.mediaId) {
        throw new Error("Unexpected media id.");
      }

      return resolvedMedia;
    }),
    encodeMediaToken: vi.fn((mediaId: string) => {
      tokenCount += 1;

      const token = `opaque-token-${tokenCount}`;

      mediaIdsByToken.set(token, mediaId);
      return token;
    }),
    decodeMediaToken: vi.fn((token: string) => {
      const mediaId = mediaIdsByToken.get(token);

      if (!mediaId) {
        throw new Error("Invalid token.");
      }

      return mediaId;
    }),
  };
}

function createFakeSessionManager() {
  const createSession = vi.fn(
    async (plan: PlaybackPlan, media: MediaAnalysis) => {
      const sessionId = "session-1";

      return {
        sessionId,
        mediaId: media.mediaId,
        plan: {
          ...plan,
          delivery: {
            type: "hls" as const,
            sessionId,
            url: `/api/playback/sessions/${sessionId}/master.m3u8`,
          },
        },
        process: {
          exitCode: 0,
          killed: true,
          kill: vi.fn(),
        },
        outputDir: path.join(tmpdir(), "seyirlik-fake-hls-session"),
        createdAt: new Date(),
        lastAccessedAt: new Date(),
        stderrTail: "",
      };
    },
  );
  const manager = {
    createSession,
    getSession: vi.fn(() => undefined),
    getActiveSessionIds: vi.fn(() => []),
    touchSession: vi.fn(),
    stopSession: vi.fn(async () => undefined),
    stopAllSessions: vi.fn(async () => undefined),
    cleanupIdleSessions: vi.fn(async () => undefined),
  } as unknown as PlaybackSessionManager;

  return { createSession, manager };
}

function createDeferredReadySessionManager(outputDir: string) {
  const sessions = new Map<string, PlaybackSession>();
  let markReady: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  const createSession = vi.fn(
    async (plan: PlaybackPlan, media: MediaAnalysis) => {
      await ready;
      await mkdir(outputDir, { recursive: true });
      await writeFile(
        path.join(outputDir, "master.m3u8"),
        [
          "#EXTM3U",
          "#EXT-X-VERSION:7",
          "#EXT-X-TARGETDURATION:4",
          '#EXT-X-MAP:URI="init.mp4"',
          "#EXTINF:4.000000,",
          "segment_00000.m4s",
          "",
        ].join("\n"),
      );
      await writeFile(path.join(outputDir, "init.mp4"), "init");
      await writeFile(path.join(outputDir, "segment_00000.m4s"), "segment");

      const sessionId = "session-ready";
      const fakeProcess = new EventEmitter() as EventEmitter & {
        exitCode: number | null;
        killed: boolean;
        kill: ReturnType<typeof vi.fn>;
      };

      fakeProcess.exitCode = null;
      fakeProcess.killed = false;
      fakeProcess.kill = vi.fn(() => {
        fakeProcess.killed = true;
        return true;
      });

      const session: PlaybackSession = {
        sessionId,
        mediaId: media.mediaId,
        plan: {
          ...plan,
          delivery: {
            type: "hls" as const,
            sessionId,
            url: `/api/playback/sessions/${sessionId}/master.m3u8`,
          },
        },
        process: fakeProcess as unknown as PlaybackSession["process"],
        outputDir,
        createdAt: new Date(),
        lastAccessedAt: new Date(),
        stderrTail: "",
      };

      sessions.set(sessionId, session);
      return session;
    },
  );
  const manager = {
    createSession,
    getSession: vi.fn((sessionId: string) => sessions.get(sessionId)),
    getActiveSessionIds: vi.fn(() => Array.from(sessions.keys())),
    touchSession: vi.fn((sessionId: string) => {
      const session = sessions.get(sessionId);

      if (session) {
        session.lastAccessedAt = new Date();
      }
    }),
    stopSession: vi.fn(async (sessionId: string) => {
      sessions.delete(sessionId);
    }),
    stopAllSessions: vi.fn(async () => {
      sessions.clear();
    }),
    cleanupIdleSessions: vi.fn(async () => undefined),
  } as unknown as PlaybackSessionManager;

  return { createSession, manager, markReady: markReady! };
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

async function listenBackend(backend: PlaybackBackend) {
  await new Promise<void>((resolveListen) => {
    backend.server.listen(0, "127.0.0.1", resolveListen);
  });

  const address = backend.server.address() as AddressInfo;

  return `http://127.0.0.1:${address.port}`;
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

  it("reports bounded transcode runtime status", async () => {
    const { baseUrl } = await createFixtureBackend();
    const response = await fetch(`${baseUrl}/api/playback/runtime`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      activeVideoTranscodes: 0,
      maxConcurrentVideoTranscodes: 1,
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
      diagnostics?: PlaybackDiagnostics;
    };

    expect(response.status).toBe(200);
    expect(payload.mode).toBe("direct-play");
    expect(payload.diagnostics?.decision.directPlaySupported).toBe(true);
    expect(payload.diagnostics?.media.fileName).toBe("sample.mp4");
    expect(payload.diagnostics?.media).not.toHaveProperty("filePath");
    expect(payload.delivery.type).toBe("file");
    expect(payload.delivery.url).toMatch(
      /^\/api\/playback\/direct\/[A-Za-z0-9_-]+$/,
    );
    expect(payload.delivery.url).not.toContain("Movies/sample.mp4");
  });

  it("direct plays MOV H264/AAC from the backend without creating an HLS session", async () => {
    const mediaRoot = await mkdtemp(
      path.join(tmpdir(), "seyirlik-http-media-"),
    );
    const filePath = await writeMediaFile(
      mediaRoot,
      "Movies/sample.mov",
      "quicktime-media",
    );
    const resolvedMedia = {
      mediaId: "cca0673dea01eba8cd3fe7749a25f110",
      filePath,
      size: 15,
      mtimeMs: 1,
    };
    const mediaResolver = createFakeResolver(mediaRoot, resolvedMedia);
    const mediaStore: PlaybackMediaStore = {
      getMediaAnalysis: vi.fn((media) =>
        Promise.resolve(movAnalysis(media.mediaId, media.filePath)),
      ),
      saveClientCapabilities: vi.fn(),
    };
    const { createSession, manager } = createFakeSessionManager();
    const backend = await createPlaybackBackend({
      host: "127.0.0.1",
      port: 0,
      mediaRoot,
      mediaResolver,
      mediaStore,
      sessionManager: manager,
      allowedOrigins: ["http://allowed.test"],
      cleanupIntervalMs: 1_000,
    });
    const baseUrl = await listenBackend(backend);

    backends.push(backend);
    mediaRoots.push(mediaRoot);

    const response = await fetch(`${baseUrl}/api/playback/request`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mediaId: resolvedMedia.mediaId,
        clientCapabilities: {
          ...clientCapabilities(),
          supportsHlsNative: true,
          supportsManagedMediaSource: true,
          directFileContainers: ["mp4", "m4v", "mov", "webm"],
          video: {
            h264: { supported: false },
          },
          audio: {
            aac: { supported: false },
          },
        } satisfies ClientCapabilities,
      }),
    });
    const payload = (await response.json()) as {
      mode: string;
      container: { input: string };
      video: { inputCodec: string };
      audio: { inputCodec?: string };
      delivery: { type: string; url: string };
      diagnostics?: PlaybackDiagnostics;
    };

    expect(response.status).toBe(200);
    expect(payload.mode).toBe("direct-play");
    expect(payload.container.input).toBe("mov");
    expect(payload.video.inputCodec).toBe("h264");
    expect(payload.audio.inputCodec).toBe("aac");
    expect(payload.delivery.type).toBe("file");
    expect(payload.delivery.url).toMatch(
      /^\/api\/playback\/direct\/[A-Za-z0-9_-]+$/,
    );
    expect(payload.diagnostics?.decision).toMatchObject({
      byteRangeSupported: true,
      directMediaUrl: payload.delivery.url,
      directPlaySupported: true,
      ffmpegStarted: false,
      mode: "direct-play",
      requiresFfmpeg: false,
      source: {
        container: "mov",
        videoCodec: "h264",
        audioCodec: "aac",
      },
    });
    expect(
      payload.diagnostics?.decision.reasons.map((reason) => reason.code),
    ).toEqual(["direct_play_supported"]);
    expect(createSession).not.toHaveBeenCalled();

    const rangeResponse = await fetch(`${baseUrl}${payload.delivery.url}`, {
      headers: {
        Origin: "http://allowed.test",
        Range: "bytes=0-4",
      },
    });

    expect(rangeResponse.status).toBe(206);
    expect(rangeResponse.headers.get("access-control-allow-origin")).toBe(
      "http://allowed.test",
    );
    expect(rangeResponse.headers.get("accept-ranges")).toBe("bytes");
    expect(rangeResponse.headers.get("content-type")).toBe("video/quicktime");
    expect(rangeResponse.headers.get("content-range")).toBe("bytes 0-4/15");
    expect(rangeResponse.headers.get("content-length")).toBe("5");
    await expect(rangeResponse.text()).resolves.toBe("quick");
  });

  it("resolves opaque Jellyfin item ids before analysing media", async () => {
    const mediaRoot = await mkdtemp(
      path.join(tmpdir(), "seyirlik-http-media-"),
    );
    const filePath = await writeMediaFile(mediaRoot, "Movies/sample.mp4");
    const resolvedMedia = {
      mediaId: "3cb1ddd87cbc4fd9bb70e179e7990755",
      filePath,
      size: 10,
      mtimeMs: 1,
    };
    const mediaResolver = createFakeResolver(mediaRoot, resolvedMedia);
    const mediaStore: PlaybackMediaStore = {
      getMediaAnalysis: vi.fn((media) =>
        Promise.resolve(analysis(media.mediaId, media.filePath)),
      ),
      saveClientCapabilities: vi.fn(),
    };
    const backend = await createPlaybackBackend({
      host: "127.0.0.1",
      port: 0,
      mediaRoot,
      mediaResolver,
      mediaStore,
      allowedOrigins: ["http://allowed.test"],
      cleanupIntervalMs: 1_000,
    });
    const baseUrl = await listenBackend(backend);

    backends.push(backend);
    mediaRoots.push(mediaRoot);

    const response = await fetch(`${baseUrl}/api/playback/request`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mediaId: resolvedMedia.mediaId,
        clientCapabilities: clientCapabilities(),
      }),
    });
    const payload = (await response.json()) as {
      delivery: { type: string; url: string };
    };

    expect(response.status).toBe(200);
    expect(mediaResolver.resolveMedia).toHaveBeenCalledWith(
      resolvedMedia.mediaId,
    );
    expect(mediaStore.getMediaAnalysis).toHaveBeenCalledWith(resolvedMedia);
    expect(payload.delivery.type).toBe("file");
    expect(payload.delivery.url).not.toContain(resolvedMedia.mediaId);
  });

  it("creates HLS sessions from trusted resolver output", async () => {
    const mediaRoot = await mkdtemp(
      path.join(tmpdir(), "seyirlik-http-media-"),
    );
    const filePath = await writeMediaFile(mediaRoot, "Movies/hevc.mkv");
    const resolvedMedia = {
      mediaId: "cca06700000000000000000000000000",
      filePath,
      size: 10,
      mtimeMs: 1,
    };
    const mediaResolver = createFakeResolver(mediaRoot, resolvedMedia);
    const mediaStore: PlaybackMediaStore = {
      getMediaAnalysis: vi.fn((media) =>
        Promise.resolve(hlsAnalysis(media.mediaId, media.filePath)),
      ),
      saveClientCapabilities: vi.fn(),
    };
    const { createSession, manager } = createFakeSessionManager();
    const backend = await createPlaybackBackend({
      host: "127.0.0.1",
      port: 0,
      mediaRoot,
      mediaResolver,
      mediaStore,
      sessionManager: manager,
      allowedOrigins: ["http://allowed.test"],
      cleanupIntervalMs: 1_000,
    });
    const baseUrl = await listenBackend(backend);

    backends.push(backend);
    mediaRoots.push(mediaRoot);

    const response = await fetch(`${baseUrl}/api/playback/request`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mediaId: resolvedMedia.mediaId,
        clientCapabilities: clientCapabilities(),
      }),
    });
    const payload = (await response.json()) as {
      mode: string;
      delivery: { type: string; sessionId?: string; url?: string };
      diagnostics?: PlaybackDiagnostics;
    };

    expect(response.status).toBe(200);
    expect(payload.mode).toBe("video-transcode");
    expect(payload.diagnostics?.decision.directPlaySupported).toBe(false);
    expect(payload.diagnostics?.decision.requiresFfmpeg).toBe(true);
    expect(payload.diagnostics?.decision.blockingReasons).not.toHaveLength(0);
    expect(payload.delivery).toEqual({
      type: "hls",
      sessionId: "session-1",
      url: "/api/playback/sessions/session-1/master.m3u8",
    });
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(createSession.mock.calls[0]?.[1]).toMatchObject({
      mediaId: resolvedMedia.mediaId,
      filePath,
    });
  });

  it("does not return an HLS playback response until the playlist is ready", async () => {
    const mediaRoot = await mkdtemp(
      path.join(tmpdir(), "seyirlik-http-media-"),
    );
    const filePath = await writeMediaFile(mediaRoot, "Movies/hevc.mkv");
    const outputDir = path.join(mediaRoot, "hls-output");
    const resolvedMedia = {
      mediaId: "cca06700000000000000000000000000",
      filePath,
      size: 10,
      mtimeMs: 1,
    };
    const mediaResolver = createFakeResolver(mediaRoot, resolvedMedia);
    const mediaStore: PlaybackMediaStore = {
      getMediaAnalysis: vi.fn((media) =>
        Promise.resolve(hlsAnalysis(media.mediaId, media.filePath)),
      ),
      saveClientCapabilities: vi.fn(),
    };
    const { createSession, manager, markReady } =
      createDeferredReadySessionManager(outputDir);
    const backend = await createPlaybackBackend({
      host: "127.0.0.1",
      port: 0,
      mediaRoot,
      mediaResolver,
      mediaStore,
      sessionManager: manager,
      allowedOrigins: ["http://allowed.test"],
      cleanupIntervalMs: 1_000,
    });
    const baseUrl = await listenBackend(backend);

    backends.push(backend);
    mediaRoots.push(mediaRoot);

    let requestSettled = false;
    const requestPromise = fetch(`${baseUrl}/api/playback/request`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mediaId: resolvedMedia.mediaId,
        clientCapabilities: clientCapabilities(),
      }),
    }).then(async (response) => {
      requestSettled = true;
      return {
        response,
        payload: (await response.json()) as {
          delivery: { type: string; sessionId?: string; url?: string };
        },
      };
    });

    await vi.waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(requestSettled).toBe(false);

    markReady();

    const { response, payload } = await requestPromise;
    expect(response.status).toBe(200);
    expect(payload.delivery).toMatchObject({
      type: "hls",
      sessionId: "session-ready",
      url: "/api/playback/sessions/session-ready/master.m3u8",
    });

    const playlistResponse = await fetch(`${baseUrl}${payload.delivery.url}`);

    expect(playlistResponse.status).toBe(200);
    expect(playlistResponse.headers.get("content-type")).toBe(
      "application/vnd.apple.mpegurl",
    );
    await expect(playlistResponse.text()).resolves.toContain(
      '#EXT-X-MAP:URI="init.mp4"',
    );

    const initResponse = await fetch(
      `${baseUrl}/api/playback/sessions/${payload.delivery.sessionId}/init.mp4`,
    );

    expect(initResponse.status).toBe(200);
    expect(initResponse.headers.get("content-type")).toBe("video/mp4");
    await expect(initResponse.text()).resolves.toBe("init");

    const segmentResponse = await fetch(
      `${baseUrl}/api/playback/sessions/${payload.delivery.sessionId}/segment_00000.m4s`,
    );

    expect(segmentResponse.status).toBe(200);
    expect(segmentResponse.headers.get("content-type")).toBe(
      "video/iso.segment",
    );
    await expect(segmentResponse.text()).resolves.toBe("segment");
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

  it("rejects direct media files returned outside the configured media root", async () => {
    const mediaRoot = await mkdtemp(
      path.join(tmpdir(), "seyirlik-http-media-"),
    );
    const outsideRoot = await mkdtemp(
      path.join(tmpdir(), "seyirlik-outside-media-"),
    );
    const filePath = await writeMediaFile(
      outsideRoot,
      "Movies/outside.mp4",
      "outside",
    );
    const resolvedMedia = {
      mediaId: "outside-media",
      filePath,
      size: 7,
      mtimeMs: 1,
    };
    const mediaResolver = createFakeResolver(mediaRoot, resolvedMedia);
    const mediaStore: PlaybackMediaStore = {
      getMediaAnalysis: vi.fn((media) =>
        Promise.resolve(analysis(media.mediaId, media.filePath)),
      ),
      saveClientCapabilities: vi.fn(),
    };
    const backend = await createPlaybackBackend({
      host: "127.0.0.1",
      port: 0,
      mediaRoot,
      mediaResolver,
      mediaStore,
      allowedOrigins: ["http://allowed.test"],
      cleanupIntervalMs: 1_000,
    });
    const baseUrl = await listenBackend(backend);

    backends.push(backend);
    mediaRoots.push(mediaRoot, outsideRoot);

    const planResponse = await fetch(`${baseUrl}/api/playback/request`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mediaId: resolvedMedia.mediaId,
        clientCapabilities: clientCapabilities(),
      }),
    });
    const payload = (await planResponse.json()) as {
      delivery: { url: string };
    };
    const mediaResponse = await fetch(`${baseUrl}${payload.delivery.url}`);

    expect(planResponse.status).toBe(200);
    expect(mediaResponse.status).toBe(403);
    await expect(mediaResponse.json()).resolves.toMatchObject({
      error: { code: "MEDIA_OUTSIDE_ROOT" },
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
