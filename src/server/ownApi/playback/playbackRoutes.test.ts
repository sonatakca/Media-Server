import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { createOwnApiRouter, type RouteContext } from "../api/router";
import { sendOwnApiJson } from "../ownApiHandler";
import {
  createPlaybackRoutes,
  toNativeMode,
  toReasonCodes,
} from "./playbackRoutes";
import type { PlaybackPlan } from "../../../lib/playback-planner/types";

function plan(overrides: Partial<PlaybackPlan> = {}): PlaybackPlan {
  return {
    mode: "DirectPlay",
    requiresFfmpeg: false,
    preservesOriginalVideoQuality: true,
    expectedStartup: "instant",
    mediaId: "file-1",
    selected: { videoStreamIndex: 0 },
    container: { input: "mp4", output: "original", action: "direct" },
    video: { inputCodec: "h264", action: "copy" },
    audio: { inputCodec: "aac", action: "copy" },
    subtitles: { action: "none" },
    reasons: [],
    delivery: { type: "file" },
    ...overrides,
  } as PlaybackPlan;
}

describe("native playback mode mapping", () => {
  it("maps a plan needing no FFmpeg to DIRECT_PLAY", () => {
    expect(toNativeMode(plan())).toBe("DIRECT_PLAY");
  });

  it("maps a container-only change to REMUX", () => {
    expect(
      toNativeMode(
        plan({
          requiresFfmpeg: true,
          container: { input: "mkv", output: "hls-fmp4", action: "hls" },
          video: { inputCodec: "h264", action: "copy" },
          audio: { inputCodec: "aac", action: "copy" },
        }),
      ),
    ).toBe("REMUX");
  });

  it("maps an audio-only transcode to DIRECT_STREAM", () => {
    expect(
      toNativeMode(
        plan({
          requiresFfmpeg: true,
          video: { inputCodec: "h264", action: "copy" },
          audio: { inputCodec: "eac3", outputCodec: "aac", action: "transcode" },
        }),
      ),
    ).toBe("DIRECT_STREAM");
  });

  it("maps a video transcode or a burned-in subtitle to TRANSCODE", () => {
    expect(
      toNativeMode(
        plan({
          requiresFfmpeg: true,
          video: { inputCodec: "hevc", outputCodec: "h264", action: "transcode" },
        }),
      ),
    ).toBe("TRANSCODE");

    expect(
      toNativeMode(
        plan({
          requiresFfmpeg: true,
          video: { inputCodec: "h264", action: "copy" },
          subtitles: { inputCodec: "hdmv_pgs_subtitle", action: "burn" },
        }),
      ),
    ).toBe("TRANSCODE");
  });

  it("emits a stable reason code for every reason the plan needed FFmpeg", () => {
    expect(
      toReasonCodes(
        plan({
          requiresFfmpeg: true,
          container: { input: "mkv", output: "hls-fmp4", action: "hls" },
          video: { inputCodec: "hevc", outputCodec: "h264", action: "transcode" },
          audio: { inputCodec: "eac3", outputCodec: "aac", action: "transcode" },
          subtitles: { inputCodec: "hdmv_pgs_subtitle", action: "burn" },
        }),
      ),
    ).toEqual([
      "CONTAINER_NOT_SUPPORTED",
      "VIDEO_CODEC_NOT_SUPPORTED",
      "AUDIO_CODEC_NOT_SUPPORTED",
      "SUBTITLE_BURN_IN_REQUIRED",
    ]);
  });

  it("emits no reason codes for a direct play", () => {
    expect(toReasonCodes(plan())).toEqual([]);
  });
});

describe("route precedence for session delivery", () => {
  /**
   * The HLS playlist references segments by bare filename, so they arrive at
   * `/sessions/:id/<name>`. That must not shadow `/sessions/:id/file` or
   * `/sessions/:id/master.m3u8`.
   */
  it("prefers a literal segment over a parameter regardless of registration order", async () => {
    const hits: string[] = [];
    const route = (path: string, label: string) => ({
      method: "GET" as const,
      path,
      access: "public" as const,
      handle: async ({ response, requestId }: RouteContext) => {
        hits.push(label);
        sendOwnApiJson(response, 200, { data: { label }, requestId });
      },
    });

    const router = createOwnApiRouter({
      csrfSecret: "x".repeat(32),
      csrfCookieName: "csrf",
      resolveSession: async () => null,
      routes: [
        // Deliberately registered before the literal routes.
        route("/playback/sessions/:sessionId/:segmentName", "segment"),
        route("/playback/sessions/:sessionId/file", "file"),
        route("/playback/sessions/:sessionId/master.m3u8", "playlist"),
      ],
    });

    const call = async (path: string) => {
      const response = {
        statusCode: 200,
        setHeader: () => undefined,
        getHeader: () => undefined,
        end: () => undefined,
      } as unknown as ServerResponse;
      await router.handler(
        {
          method: "GET",
          url: path,
          headers: { host: "seyirlik.test" },
          socket: { remoteAddress: "127.0.0.1" },
        } as unknown as IncomingMessage,
        response,
        { requestId: "req-1", url: new URL(path, "https://seyirlik.test") },
      );
    };

    const sessionId = "11111111-1111-4111-8111-111111111111";
    await call(`/ownAPI/v1/playback/sessions/${sessionId}/file`);
    await call(`/ownAPI/v1/playback/sessions/${sessionId}/master.m3u8`);
    await call(`/ownAPI/v1/playback/sessions/${sessionId}/segment_00003.ts`);

    expect(hits).toEqual(["file", "playlist", "segment"]);
  });

  it("reports the matched template, not the caller's path, for logging", () => {
    const router = createOwnApiRouter({
      csrfSecret: "x".repeat(32),
      csrfCookieName: "csrf",
      resolveSession: async () => null,
      routes: [
        {
          method: "GET",
          path: "/playback/sessions/:sessionId/:segmentName",
          access: "public",
          handle: async () => undefined,
        },
      ],
    });

    expect(
      router.resolveTemplate("/ownAPI/v1/playback/sessions/abc/segment_1.ts"),
    ).toBe("/ownAPI/v1/playback/sessions/:sessionId/:segmentName");
  });
});

describe("rendition delivery", () => {
  const VIEWER = "11111111-1111-4111-8111-111111111111";
  const FILE = "22222222-2222-4222-8222-222222222222";
  const HIDDEN_FILE = "33333333-3333-4333-8333-333333333333";

  function buildRenditionRouter(options: { served: string[] }) {
    const catalogue = {
      getFileById: async (id: string) =>
        id === FILE
          ? { id: FILE, itemId: "item-visible", missingSince: null }
          : id === HIDDEN_FILE
            ? { id: HIDDEN_FILE, itemId: "item-hidden", missingSince: null }
            : null,
      canUserAccessItem: async (_userId: string, itemId: string) =>
        itemId === "item-visible",
    } as unknown as Parameters<typeof createPlaybackRoutes>[0]["catalogue"];

    const renditions = {
      createManifest: async () => ({ mediaId: FILE, qualities: [] }),
      handleRequest: async (request: IncomingMessage) => {
        options.served.push(request.url ?? "");
        return true;
      },
    } as unknown as NonNullable<
      Parameters<typeof createPlaybackRoutes>[0]["renditions"]
    >;

    return createOwnApiRouter({
      csrfSecret: "s".repeat(32),
      csrfCookieName: "seyirlik_csrf",
      publicOrigin: "https://seyirlik.test",
      resolveSession: async () => ({
        userId: VIEWER,
        username: "viewer",
        displayName: "Viewer",
        isAdministrator: false,
        sessionId: "44444444-4444-4444-8444-444444444444",
        sessionTokenHash: Buffer.alloc(32),
      }),
      routes: createPlaybackRoutes({
        catalogue,
        sessions: {} as never,
        sessionManager: {} as never,
        mediaRoot: "/media",
        renditions,
      }),
    });
  }

  async function get(
    router: ReturnType<typeof buildRenditionRouter>,
    pathname: string,
  ) {
    const request = {
      method: "GET",
      url: pathname,
      headers: { host: "seyirlik.test" },
      socket: { remoteAddress: "127.0.0.1" },
    } as unknown as IncomingMessage;
    const response = {
      statusCode: 200,
      setHeader() {},
      getHeader() {
        return undefined;
      },
      end() {},
    } as unknown as ServerResponse;

    let error: unknown;
    let handled = false;
    try {
      handled = await router.handler(request, response, {
        requestId: "req-1",
        url: new URL(pathname, "https://seyirlik.test"),
      });
    } catch (caught) {
      error = caught;
    }
    return { error, handled };
  }

  it("serves a rendition for a file the viewer can see", async () => {
    const served: string[] = [];
    const router = buildRenditionRouter({ served });

    const { error } = await get(
      router,
      `/ownAPI/v1/playback/renditions/${FILE}/720-abcdef123456.mp4`,
    );

    expect(error).toBeUndefined();
    expect(served).toEqual([
      `/ownAPI/v1/playback/renditions/${FILE}/720-abcdef123456.mp4`,
    ]);
  });

  it("refuses a rendition of a file in a library the viewer cannot see", async () => {
    // The token is minted from the media file id, so it is guessable. Access has
    // to be re-checked on every request rather than inferred from possession.
    const served: string[] = [];
    const router = buildRenditionRouter({ served });

    const { error } = await get(
      router,
      `/ownAPI/v1/playback/renditions/${HIDDEN_FILE}/720-abcdef123456.mp4`,
    );

    expect((error as { statusCode?: number }).statusCode).toBe(404);
    expect(served).toEqual([]);
  });

  it("rejects a token that is not a media file id before touching the service", async () => {
    const served: string[] = [];
    const router = buildRenditionRouter({ served });

    // An encoded separator never reaches a handler at all; a well-formed but
    // non-UUID token is refused by validation. Neither may reach the service.
    const traversal = await get(
      router,
      "/ownAPI/v1/playback/renditions/..%2F..%2Fsecret/720-abcdef123456.mp4",
    );
    expect(traversal.handled).toBe(false);

    const notAUuid = await get(
      router,
      "/ownAPI/v1/playback/renditions/not-a-uuid/720-abcdef123456.mp4",
    );
    expect((notAUuid.error as { statusCode?: number }).statusCode).toBe(422);

    expect(served).toEqual([]);
  });
});
