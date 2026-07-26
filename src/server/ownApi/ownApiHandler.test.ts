// @vitest-environment node
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createOwnApiRequestHandler,
  createStaticHealthService,
  buildOwnApiHealthStatus,
  OwnApiError,
  requireOwnApiAccess,
  type OwnApiPrincipal,
  type OwnApiRequestContext,
} from "./ownApiHandler";

const servers: Server[] = [];

async function startServer(
  handler: ReturnType<typeof createOwnApiRequestHandler>,
): Promise<string> {
  const server = createServer(async (request, response) => {
    const handled = await handler(request, response);

    if (!handled) {
      response.statusCode = 418;
      response.end("legacy route");
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  servers.push(server);

  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

function healthService() {
  return createStaticHealthService({
    database: "unavailable",
    jobs: "disabled",
    ffmpeg: "available",
    ffprobe: "available",
    mediaStorage: "available",
    generatedStorage: "writable",
  });
}

afterEach(async () => {
  const currentServers = servers.splice(0);

  await Promise.all(
    currentServers.map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

describe("Seyirlik own API foundation", () => {
  it("serves dependency-aware health with a generated request ID", async () => {
    const handler = createOwnApiRequestHandler({
      healthService: healthService(),
      requestIdFactory: () => "generated-request-id",
    });
    const baseUrl = await startServer(handler);

    const response = await fetch(`${baseUrl}/ownAPI/v1/health`);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-request-id")).toBe("generated-request-id");
    expect(payload).toEqual({
      data: {
        status: "ok",
        alive: true,
        ready: false,
        checks: {
          database: "unavailable",
          jobs: "disabled",
          ffmpeg: "available",
          ffprobe: "available",
          mediaStorage: "available",
          generatedStorage: "writable",
        },
      },
      requestId: "generated-request-id",
    });
  });

  it("does not report ready while the durable job subsystem is disabled", () => {
    expect(
      buildOwnApiHealthStatus({
        database: "available",
        jobs: "disabled",
        ffmpeg: "available",
        ffprobe: "available",
        mediaStorage: "available",
        generatedStorage: "writable",
      }).ready,
    ).toBe(false);
  });

  it("keeps liveness public and independent from session storage", async () => {
    const authenticator = vi.fn(async () => {
      throw new Error("session database unavailable");
    });
    const handler = createOwnApiRequestHandler({
      healthService: healthService(),
      authenticator,
      requestIdFactory: () => "public-health-request",
    });
    const baseUrl = await startServer(handler);
    const response = await fetch(`${baseUrl}/ownAPI/v1/health`);

    expect(response.status).toBe(200);
    expect(authenticator).not.toHaveBeenCalled();
  });

  it("preserves a safe caller request ID", async () => {
    const handler = createOwnApiRequestHandler({
      healthService: healthService(),
      requestIdFactory: () => "replacement-request-id",
    });
    const baseUrl = await startServer(handler);

    const safeResponse = await fetch(`${baseUrl}/ownAPI/v1/health`, {
      headers: { "X-Request-Id": "caller-request_123" },
    });
    const unsafeResponse = await fetch(`${baseUrl}/ownAPI/v1/health`, {
      headers: { "X-Request-Id": "unsafe request id with spaces" },
    });
    const oversizedResponse = await fetch(`${baseUrl}/ownAPI/v1/health`, {
      headers: { "X-Request-Id": `request-${"x".repeat(128)}` },
    });
    const duplicateResponse = await fetch(`${baseUrl}/ownAPI/v1/health`, {
      headers: [
        ["X-Request-Id", "first-request"],
        ["X-Request-Id", "second-request"],
      ],
    });

    expect(safeResponse.headers.get("x-request-id")).toBe("caller-request_123");
    expect(unsafeResponse.headers.get("x-request-id")).toBe(
      "replacement-request-id",
    );
    expect(oversizedResponse.headers.get("x-request-id")).toBe(
      "replacement-request-id",
    );
    expect(duplicateResponse.headers.get("x-request-id")).toBe(
      "replacement-request-id",
    );
  });

  it("returns request-correlated method and unknown-route errors", async () => {
    const handler = createOwnApiRequestHandler({
      healthService: healthService(),
      requestIdFactory: () => "error-request-id",
    });
    const baseUrl = await startServer(handler);

    const methodResponse = await fetch(`${baseUrl}/ownAPI/v1/health`, {
      method: "POST",
    });
    const notFoundResponse = await fetch(`${baseUrl}/ownAPI/v1/not-real`);

    expect(methodResponse.status).toBe(405);
    expect(methodResponse.headers.get("allow")).toBe("GET, OPTIONS");
    expect(await methodResponse.json()).toEqual({
      error: {
        code: "METHOD_NOT_ALLOWED",
        message: "HTTP method is not allowed for this route.",
        requestId: "error-request-id",
      },
    });
    expect(notFoundResponse.status).toBe(404);
    expect(await notFoundResponse.json()).toEqual({
      error: {
        code: "NOT_FOUND",
        message: "Route not found.",
        requestId: "error-request-id",
      },
    });
  });

  it("leaves non-own-API routes for existing handlers", async () => {
    const handler = createOwnApiRequestHandler({
      healthService: healthService(),
    });
    const baseUrl = await startServer(handler);

    const response = await fetch(`${baseUrl}/health`);

    expect(response.status).toBe(418);
    expect(await response.text()).toBe("legacy route");
  });

  it("logs only a sanitized path and structured request metadata", async () => {
    const info = vi.fn();
    const handler = createOwnApiRequestHandler({
      healthService: healthService(),
      requestIdFactory: () => "logged-request-id",
      logger: { info },
    });
    const baseUrl = await startServer(handler);

    await fetch(
      `${baseUrl}/ownAPI/v1/health?access_token=must-not-appear&path=/private/file`,
    );

    expect(info).toHaveBeenCalledWith("http.request.completed", {
      requestId: "logged-request-id",
      method: "GET",
      path: "/ownAPI/v1/health",
      statusCode: 200,
      durationMs: expect.any(Number),
    });

    await fetch(
      `${baseUrl}/ownAPI/v1/sessions/secret-session-identifier/private-file`,
    );

    expect(info).toHaveBeenLastCalledWith("http.request.completed", {
      requestId: "logged-request-id",
      method: "GET",
      path: "/ownAPI/v1/*",
      statusCode: 404,
      durationMs: expect.any(Number),
    });
    expect(JSON.stringify(info.mock.calls)).not.toContain("must-not-appear");
    expect(JSON.stringify(info.mock.calls)).not.toContain("private/file");
    expect(JSON.stringify(info.mock.calls)).not.toContain(
      "secret-session-identifier",
    );
  });
});

describe("own API authorization middleware", () => {
  function context(principal: OwnApiPrincipal | null): OwnApiRequestContext {
    return {
      requestId: "authorization-request-id",
      principal,
    };
  }

  it("rejects anonymous access to authenticated routes", () => {
    expect(() => requireOwnApiAccess(context(null), "authenticated")).toThrow(
      expect.objectContaining<Partial<OwnApiError>>({
        code: "AUTH_REQUIRED",
        statusCode: 401,
      }),
    );
  });

  it("rejects ordinary users from admin routes and accepts administrators", () => {
    const user: OwnApiPrincipal = {
      userId: "user-1",
      sessionId: "session-1",
      deviceId: "device-1",
      roles: ["USER"],
    };
    const admin: OwnApiPrincipal = {
      ...user,
      roles: ["USER", "ADMIN"],
    };

    expect(() => requireOwnApiAccess(context(user), "admin")).toThrow(
      expect.objectContaining<Partial<OwnApiError>>({
        code: "FORBIDDEN",
        statusCode: 403,
      }),
    );
    expect(requireOwnApiAccess(context(admin), "admin")).toBe(admin);
  });
});
