import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientCapabilities, PlaybackPlan } from "./types";

const { buildClientCapabilitiesMock } = vi.hoisted(() => ({
  buildClientCapabilitiesMock: vi.fn(),
}));

vi.mock("./clientCapabilities", () => ({
  buildClientCapabilities: buildClientCapabilitiesMock,
}));

function clientCapabilities(): ClientCapabilities {
  return {
    supportsHlsNative: true,
    supportsMediaSource: true,
    directFileContainers: ["mp4"],
    mseContainers: ["mp4"],
    video: {
      h264: { supported: true },
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

function playbackPlan(sessionId: string): PlaybackPlan {
  return {
    mode: "audio-transcode",
    requiresFfmpeg: true,
    preservesOriginalVideoQuality: true,
    expectedStartup: "fast",
    mediaId: "movie-1",
    selected: {
      videoStreamIndex: 0,
      audioStreamIndex: 1,
    },
    container: {
      input: "mp4",
      output: "hls-fmp4",
      action: "hls",
    },
    video: {
      inputCodec: "h264",
      action: "copy",
    },
    audio: {
      inputCodec: "aac",
      outputCodec: "aac",
      action: "transcode",
    },
    subtitles: {
      action: "none",
    },
    reasons: [],
    delivery: {
      type: "hls",
      sessionId,
      url: `/api/playback/sessions/${sessionId}/master.m3u8`,
    },
  };
}

function directMovPlaybackPlan(): PlaybackPlan {
  return {
    mode: "direct-play",
    requiresFfmpeg: false,
    preservesOriginalVideoQuality: true,
    expectedStartup: "instant",
    mediaId: "movie-1",
    selected: {
      videoStreamIndex: 0,
      audioStreamIndex: 1,
    },
    container: {
      input: "mov",
      output: "original",
      action: "direct",
    },
    video: {
      inputCodec: "h264",
      action: "copy",
    },
    audio: {
      inputCodec: "aac",
      action: "copy",
    },
    subtitles: {
      action: "none",
    },
    reasons: [
      {
        code: "direct_play_supported",
        severity: "info",
        message: "Container and codecs are direct-play compatible.",
      },
    ],
    delivery: {
      type: "file",
      url: "/api/playback/direct/token-1",
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function loadApi() {
  vi.resetModules();
  return import("./customPlaybackApi");
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.stubEnv("VITE_SEYIRLIK_PLAYBACK_BACKEND_URL", "http://backend.test");
  buildClientCapabilitiesMock.mockResolvedValue(clientCapabilities());
});

describe("custom playback API request deduplication", () => {
  it("shares one pending request for simultaneous callers of the same item", async () => {
    const api = await loadApi();
    let resolveFetch: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );

    vi.stubGlobal("fetch", fetchMock);

    const firstRequest = api.requestCustomPlaybackCandidate("movie-1");
    const secondRequest = api.requestCustomPlaybackCandidate("movie-1");

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    resolveFetch?.(jsonResponse(playbackPlan("session-1")));
    const [firstCandidate, secondCandidate] = await Promise.all([
      firstRequest,
      secondRequest,
    ]);

    expect(firstCandidate).toBe(secondCandidate);
    expect(firstCandidate?.playSessionId).toBe("session-1");
  });

  it("performs a new request after a pending request completes", async () => {
    const api = await loadApi();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(playbackPlan("session-1")))
      .mockResolvedValueOnce(jsonResponse(playbackPlan("session-2")));

    vi.stubGlobal("fetch", fetchMock);

    await expect(
      api.requestCustomPlaybackCandidate("movie-1"),
    ).resolves.toMatchObject({
      playSessionId: "session-1",
    });
    await expect(
      api.requestCustomPlaybackCandidate("movie-1"),
    ).resolves.toMatchObject({
      playSessionId: "session-2",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("maps direct MOV backend responses to a native DirectPlay source", async () => {
    const api = await loadApi();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(directMovPlaybackPlan()));

    vi.stubGlobal("fetch", fetchMock);

    await expect(
      api.requestCustomPlaybackCandidate("movie-1"),
    ).resolves.toMatchObject({
      mode: "DirectPlay",
      mimeType: "video/quicktime",
      isHls: false,
      hlsKind: "direct",
      url: "http://backend.test/api/playback/direct/token-1",
      mediaSource: {
        Container: "mov",
        SupportsDirectPlay: true,
      },
    });
  });

  it("allows retry after a failed custom playback request", async () => {
    const api = await loadApi();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("failed", { status: 502 }))
      .mockResolvedValueOnce(jsonResponse(playbackPlan("session-2")));

    vi.stubGlobal("fetch", fetchMock);

    await expect(api.requestCustomPlaybackCandidate("movie-1")).rejects.toThrow(
      "Custom playback request failed with 502",
    );
    await expect(
      api.requestCustomPlaybackCandidate("movie-1"),
    ).resolves.toMatchObject({
      playSessionId: "session-2",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not share requests for different item ids", async () => {
    const api = await loadApi();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(playbackPlan("session-1")))
      .mockResolvedValueOnce(jsonResponse(playbackPlan("session-2")));

    vi.stubGlobal("fetch", fetchMock);

    await Promise.all([
      api.requestCustomPlaybackCandidate("movie-1"),
      api.requestCustomPlaybackCandidate("movie-2"),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body))),
    ).toEqual([
      expect.objectContaining({ mediaId: "movie-1" }),
      expect.objectContaining({ mediaId: "movie-2" }),
    ]);
  });
});
