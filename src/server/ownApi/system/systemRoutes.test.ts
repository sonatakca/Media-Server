import { createHmac } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createOwnApiRouter, type RoutePrincipal } from "../api/router";
import { createCsrfToken } from "../auth/csrf";
import type { RestartController } from "../../restartController";
import { createSystemRoutes } from "./systemRoutes";

const CSRF_SECRET = "s".repeat(32);
const SESSION_HASH = createHmac("sha256", "k").update("session").digest();

function fakeController(
  overrides: Partial<RestartController> = {},
): RestartController {
  return {
    status: () => ({ mode: "respawn", available: true, inProgress: false }),
    request: () => ({
      mode: "respawn",
      available: true,
      accepted: true,
      inProgress: true,
    }),
    settled: async () => undefined,
    ...overrides,
  };
}

function buildRouter(
  parts: { restart?: RestartController; administrator?: boolean } = {},
) {
  return createOwnApiRouter({
    csrfSecret: CSRF_SECRET,
    csrfCookieName: "seyirlik_csrf",
    publicOrigin: "https://seyirlik.test",
    resolveSession: async (): Promise<RoutePrincipal> => ({
      userId: "dddddddd-4444-4444-8444-444444444444",
      username: "root",
      displayName: "Root",
      isAdministrator: parts.administrator !== false,
      sessionId: "eeeeeeee-5555-4555-8555-555555555555",
      sessionTokenHash: SESSION_HASH,
    }),
    routes: createSystemRoutes({ restart: parts.restart ?? fakeController() }),
  });
}

async function call(
  router: ReturnType<typeof buildRouter>,
  method: string,
  routePath: string,
  { csrf = true }: { csrf?: boolean } = {},
) {
  const csrfToken = createCsrfToken(SESSION_HASH, CSRF_SECRET);
  const request = Object.assign(Readable.from([]), {
    method,
    url: routePath,
    headers: {
      host: "seyirlik.test",
      origin: "https://seyirlik.test",
      ...(csrf
        ? { cookie: `seyirlik_csrf=${csrfToken}`, "x-csrf-token": csrfToken }
        : {}),
    },
    socket: { remoteAddress: "127.0.0.1" },
  }) as unknown as IncomingMessage;

  const sent = { statusCode: 200, body: "" };
  const response = {
    get statusCode() {
      return sent.statusCode;
    },
    set statusCode(value: number) {
      sent.statusCode = value;
    },
    setHeader() {},
    getHeader() {
      return undefined;
    },
    end(chunk?: string) {
      sent.body = chunk ?? "";
    },
  } as unknown as ServerResponse;

  let error: unknown;
  try {
    await router.handler(request, response, {
      requestId: "req-1",
      url: new URL(routePath, "https://seyirlik.test"),
    });
  } catch (caught) {
    error = caught;
  }

  return {
    sent,
    error,
    json: sent.body ? (JSON.parse(sent.body) as Record<string, unknown>) : null,
  };
}

const PATH = "/ownAPI/v1/admin/system/restart";

describe("system routes", () => {
  describe("status", () => {
    it("reports the mode so the page can explain itself", async () => {
      const result = await call(buildRouter(), "GET", PATH);

      expect(result.sent.statusCode).toBe(200);
      expect(result.json?.data).toEqual({
        mode: "respawn",
        available: true,
        inProgress: false,
      });
    });

    it("reports an unavailable restart rather than hiding the route", async () => {
      // The page needs to tell "not available here" from "it failed", and only
      // a successful response carrying `available: false` says the first.
      const result = await call(
        buildRouter({
          restart: fakeController({
            status: () => ({
              mode: "disabled",
              available: false,
              inProgress: false,
            }),
          }),
        }),
        "GET",
        PATH,
      );

      expect(result.sent.statusCode).toBe(200);
      expect(result.json?.data).toMatchObject({ available: false });
    });

    it("is refused for a non-administrator", async () => {
      const result = await call(
        buildRouter({ administrator: false }),
        "GET",
        PATH,
      );

      expect((result.error as { statusCode?: number })?.statusCode).toBe(403);
    });
  });

  describe("restart", () => {
    it("accepts the request and answers before anything stops", async () => {
      const request = vi.fn(() => ({
        mode: "respawn" as const,
        available: true,
        accepted: true,
        inProgress: true,
      }));

      const result = await call(
        buildRouter({ restart: fakeController({ request }) }),
        "POST",
        PATH,
      );

      expect(result.sent.statusCode).toBe(202);
      expect(result.json?.data).toEqual({
        status: "restarting",
        mode: "respawn",
      });
      expect(request).toHaveBeenCalledTimes(1);
    });

    it("is a conflict, not a silent success, when restarts are disabled", async () => {
      const result = await call(
        buildRouter({
          restart: fakeController({
            request: () => ({
              mode: "disabled",
              available: false,
              accepted: false,
              inProgress: false,
            }),
          }),
        }),
        "POST",
        PATH,
      );

      expect((result.error as { statusCode?: number })?.statusCode).toBe(409);
      expect((result.error as { code?: string })?.code).toBe(
        "RESTART_UNAVAILABLE",
      );
    });

    it("still accepts a restart already under way", async () => {
      const result = await call(
        buildRouter({
          restart: fakeController({
            request: () => ({
              mode: "respawn",
              available: true,
              accepted: true,
              inProgress: true,
            }),
          }),
        }),
        "POST",
        PATH,
      );

      expect(result.sent.statusCode).toBe(202);
    });

    it("is refused for a non-administrator, without asking the controller", async () => {
      const request = vi.fn(() => ({
        mode: "respawn" as const,
        available: true,
        accepted: true,
        inProgress: true,
      }));

      const result = await call(
        buildRouter({
          administrator: false,
          restart: fakeController({ request }),
        }),
        "POST",
        PATH,
      );

      expect((result.error as { statusCode?: number })?.statusCode).toBe(403);
      expect(request).not.toHaveBeenCalled();
    });

    it("is refused without a CSRF token", async () => {
      const request = vi.fn(() => ({
        mode: "respawn" as const,
        available: true,
        accepted: true,
        inProgress: true,
      }));

      const result = await call(
        buildRouter({ restart: fakeController({ request }) }),
        "POST",
        PATH,
        { csrf: false },
      );

      expect((result.error as { statusCode?: number })?.statusCode).toBe(403);
      expect(request).not.toHaveBeenCalled();
    });
  });
});
