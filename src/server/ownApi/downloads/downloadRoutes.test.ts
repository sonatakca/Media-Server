import { describe, expect, it } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createOwnApiRouter } from "../api/router";
import type { OwnApiError } from "../ownApiHandler";
import { createDownloadRoutes } from "./downloadRoutes";

const VIEWER = "11111111-1111-4111-8111-111111111111";
const ITEM = "22222222-2222-4222-8222-222222222222";

function build(options: { allowDownloads: boolean; packaged: boolean }) {
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
    routes: createDownloadRoutes({
      mediaRoot: "/media",
      users: {
        findById: async () =>
          ({ allowDownloads: options.allowDownloads }) as never,
      },
      catalogue: {
        canUserAccessItem: async () => true,
        getPrimaryFile: async () =>
          ({
            id: "file-1",
            relativePath: "Film/Film.mkv",
            sizeBytes: "1",
            mtimeMs: "1",
          }) as never,
      },
      renditions: {
        createManifest: async () =>
          ({
            mediaId: "file-1",
            qualities: [],
            ...(options.packaged
              ? {
                  adaptive: {
                    playbackUrl:
                      "/ownAPI/v1/playback/renditions/file-1/adaptive/abc/master.m3u8",
                    segmentTargetSeconds: 6,
                    qualities: [
                      {
                        id: "v720",
                        label: "720p",
                        width: 1280,
                        height: 720,
                        bitrate: 3e6,
                        videoCodec: "h264",
                        hdr: false,
                      },
                    ],
                    audioTracks: [
                      {
                        id: "a1",
                        sourceStreamIndex: 1,
                        label: "Türkçe",
                        language: "tur",
                        channels: 2,
                        isDefault: true,
                      },
                    ],
                  },
                }
              : {}),
          }) as never,
      },
    }),
  });
}

async function call(router: ReturnType<typeof build>) {
  const pathname = `/ownAPI/v1/downloads/items/${ITEM}/plan`;
  let body = "";
  try {
    await router.handler(
      {
        method: "GET",
        url: pathname,
        headers: { host: "seyirlik.test" },
        socket: { remoteAddress: "127.0.0.1" },
      } as unknown as IncomingMessage,
      {
        statusCode: 200,
        setHeader() {},
        getHeader() {
          return undefined;
        },
        end(value?: string) {
          body = value ?? "";
        },
      } as unknown as ServerResponse,
      { requestId: "req", url: new URL(pathname, "https://seyirlik.test") },
    );
  } catch (caught) {
    return { error: (caught as OwnApiError).code };
  }
  return JSON.parse(body) as { data: { masterUrl: string } };
}

describe("download plan", () => {
  it("refuses an account without the download permission", async () => {
    expect(
      await call(build({ allowDownloads: false, packaged: true })),
    ).toEqual({
      error: "DOWNLOADS_NOT_ALLOWED",
    });
  });

  it("refuses a title with no package to store", async () => {
    expect(
      await call(build({ allowDownloads: true, packaged: false })),
    ).toEqual({
      error: "DOWNLOAD_UNAVAILABLE",
    });
  });

  it("hands over the package's master playlist and rungs", async () => {
    const result = await call(build({ allowDownloads: true, packaged: true }));
    expect(result).toMatchObject({
      data: {
        masterUrl:
          "/ownAPI/v1/playback/renditions/file-1/adaptive/abc/master.m3u8",
      },
    });
  });
});
