// @vitest-environment node
import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { createJellyfinPlaybackAuthorizer } from "./jellyfinPlaybackAuth";

function request(headers: Record<string, string> = {}): IncomingMessage {
  const value = new EventEmitter() as IncomingMessage;
  value.headers = headers;
  return value;
}

describe("Jellyfin playback authorization", () => {
  it("rejects missing credentials without contacting Jellyfin", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const authorize = createJellyfinPlaybackAuthorizer({
      jellyfinServerUrl: "http://127.0.0.1:8096",
      fetchImpl,
    });

    expect(await authorize(request())).toMatchObject({
      authorized: false,
      statusCode: 401,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("validates the browser token with Jellyfin", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ Id: "user-id" }), { status: 200 }),
      );
    const authorize = createJellyfinPlaybackAuthorizer({
      jellyfinServerUrl: "http://127.0.0.1:8096",
      fetchImpl,
    });

    expect(
      await authorize(request({ "x-emby-token": "private-token" })),
    ).toEqual({ authorized: true, userId: "user-id" });
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:8096/Users/Me",
      expect.objectContaining({
        headers: expect.objectContaining({ "X-Emby-Token": "private-token" }),
      }),
    );
  });
});
