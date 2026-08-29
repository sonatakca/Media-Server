import type { ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { PlaybackSessionStartupError } from "../../../lib/playback-planner/playbackSessionManager";
import { createPlaybackRoutes } from "./playbackRoutes";

/**
 * A session that FFmpeg never gets ready must reach the viewer as the typed
 * 409 the error itself declares, not as an internal server error.
 *
 * A 500 tells a viewer the server is broken and tells an operator nothing about
 * which stage failed; the startup error already carries a code and diagnostics,
 * and losing them on the way out is what made a healthy-but-slow remux look
 * like a crash.
 */

const ITEM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FILE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function buildSessionsRoute(createSession: () => Promise<never>) {
  const catalogue = {
    canUserAccessItem: async () => true,
    getFileById: async () => ({
      id: FILE,
      itemId: ITEM,
      missingSince: null,
      probeState: "probed",
      relativePath: "lab/source.mkv",
      container: "matroska,webm",
      durationMs: "300000",
      bitrateBps: null,
    }),
    listStreams: async () => [
      {
        streamIndex: 0,
        kind: "video",
        codec: "hevc",
        profile: "Main 10",
        level: null,
        width: 3840,
        height: 1608,
        frameRate: 24,
        bitrateBps: null,
        pixelFormat: "yuv420p10le",
        bitDepth: 10,
        colorSpace: "bt2020nc",
        colorTransfer: "smpte2084",
        colorPrimaries: "bt2020",
        videoRange: "HDR",
        isDefault: true,
      },
      {
        streamIndex: 1,
        kind: "audio",
        codec: "eac3",
        channels: 6,
        sampleRate: 48_000,
        bitrateBps: null,
        language: "eng",
        title: null,
        isDefault: true,
      },
    ],
    listChapters: async () => [],
  } as unknown as Parameters<typeof createPlaybackRoutes>[0]["catalogue"];

  const routes = createPlaybackRoutes({
    catalogue,
    sessions: {
      nextId: async () => "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    } as never,
    sessionManager: { createSession } as never,
    mediaRoot: "/media",
  });

  const route = routes.find(
    (entry) => entry.method === "POST" && entry.path === "/playback/sessions",
  );
  if (!route) throw new Error("The sessions route is not registered.");
  return route;
}

const CAPABILITIES = {
  supportsHlsNative: true,
  supportsMediaSource: false,
  directFileContainers: ["mp4"],
  mseContainers: [],
  video: {
    h264: { supported: true, maxWidth: 4096, maxHeight: 2160 },
    hevc: {
      supported: true,
      supports10Bit: true,
      supportsHdr: true,
      maxWidth: 4096,
      maxHeight: 2160,
    },
  },
  audio: {
    aac: { supported: true, maxChannels: 2 },
    eac3: { supported: true, maxChannels: 6 },
  },
  subtitles: { srtExternal: true, webvttExternal: true },
};

async function callRoute(createSession: () => Promise<never>) {
  const route = buildSessionsRoute(createSession);
  const context = {
    requirePrincipal: () => ({
      userId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    }),
    readJson: async () => ({
      itemId: ITEM,
      mediaFileId: FILE,
      clientCapabilities: CAPABILITIES,
    }),
    requestId: "req-startup",
    response: {
      statusCode: 200,
      setHeader() {},
      getHeader: () => undefined,
      end() {},
    } as unknown as ServerResponse,
  };

  try {
    await route.handle(context as never);
  } catch (error) {
    return error as { code?: string; statusCode?: number };
  }
  return undefined;
}

describe("a session FFmpeg never brings up", () => {
  it("surfaces the startup failure as its own 409, not a 500", async () => {
    const error = await callRoute(async () => {
      throw new PlaybackSessionStartupError(
        "FFmpeg remained alive but did not produce playable HLS output before the startup timeout.",
        "playlist-timeout-process-alive",
        { processStillRunning: true, elapsedMs: 2_502 },
      );
    });

    expect(error?.statusCode).toBe(409);
    expect(error?.code).toBe("playlist-timeout-process-alive");
  });
});
