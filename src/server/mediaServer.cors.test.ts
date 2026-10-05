// @vitest-environment node
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { applyCors } from "./mediaServer";

function exchange(origin: string | undefined) {
  const headers: Record<string, string> = {};
  const request = {
    headers: origin
      ? { origin, host: "playback.example" }
      : { host: "playback.example" },
  } as unknown as IncomingMessage;
  const response = {
    statusCode: 200,
    setHeader: (name: string, value: string) => {
      headers[name.toLowerCase()] = value;
    },
    end: () => undefined,
  } as unknown as ServerResponse;
  const allowed = applyCors(
    request,
    response,
    new Set(["https://www.example"]),
    "https://playback.example",
  );
  return { allowed, headers };
}

describe("CORS and caching", () => {
  it("marks a response to a request without Origin as varying on it", () => {
    // A native player sends no Origin. Without Vary, the browser cached its
    // copy — immutable, with no CORS headers — and handed it to hls.js's CORS
    // request for the same URL, which then failed without reaching the server.
    const { allowed, headers } = exchange(undefined);
    expect(allowed).toBe(true);
    expect(headers.vary).toBe("Origin");
    expect(headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("allows the frontend origin with credentials, varying on Origin", () => {
    const { allowed, headers } = exchange("https://www.example");
    expect(allowed).toBe(true);
    expect(headers.vary).toBe("Origin");
    expect(headers["access-control-allow-origin"]).toBe("https://www.example");
    expect(headers["access-control-allow-credentials"]).toBe("true");
  });
});
