// @vitest-environment node
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import vercelConfig from "../../../vercel.json";
import ownApiUnavailableHandler from "../../../api/own-api-unavailable";

function responseDouble() {
  const headers = new Map<string, string>();
  let statusCode = 0;
  let body = "";
  return {
    response: {
      set statusCode(value: number) {
        statusCode = value;
      },
      get statusCode() {
        return statusCode;
      },
      setHeader(name: string, value: string | number | readonly string[]) {
        headers.set(name.toLowerCase(), String(value));
      },
      end(value?: string) {
        body = value ?? "";
      },
    } as unknown as ServerResponse,
    result: () => ({ headers, statusCode, body }),
  };
}

describe("production own-API routing guard", () => {
  it("routes own API ahead of the SPA catch-all", () => {
    expect(vercelConfig.rewrites[0]).toEqual({
      source: "/ownAPI/v1/:path*",
      destination: "/api/own-api-unavailable",
    });
    expect(vercelConfig.rewrites.at(-1)?.destination).toBe("/index.html");
  });

  it.each(["/ownAPI/v1/health", "/ownAPI/v1/auth/me"])(
    "returns correlated JSON rather than SPA HTML for %s",
    (url) => {
      const { response, result } = responseDouble();
      ownApiUnavailableHandler(
        {
          method: "GET",
          url,
          headers: { "x-request-id": "production-routing-request" },
        } as unknown as IncomingMessage,
        response,
      );

      const output = result();
      expect(output.statusCode).toBe(503);
      expect(output.headers.get("content-type")).toBe(
        "application/json; charset=utf-8",
      );
      expect(output.headers.get("cache-control")).toBe("no-store");
      expect(output.headers.get("x-request-id")).toBe(
        "production-routing-request",
      );
      expect(output.body).not.toContain("<!doctype html>");
      expect(JSON.parse(output.body)).toEqual({
        error: {
          code: "PRODUCTION_ROUTING_UNAVAILABLE",
          message:
            "The persistent own-API backend is not configured for this deployment.",
          requestId: "production-routing-request",
        },
      });
    },
  );

  it("replaces malformed request IDs without reflecting them", () => {
    const { response, result } = responseDouble();
    ownApiUnavailableHandler(
      {
        method: "GET",
        url: "/ownAPI/v1/health",
        headers: { "x-request-id": "invalid request id" },
      } as unknown as IncomingMessage,
      response,
    );

    const output = result();
    const requestId = output.headers.get("x-request-id");
    expect(requestId).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
    expect(requestId).not.toBe("invalid request id");
    expect(JSON.parse(output.body).error.requestId).toBe(requestId);
  });
});
