import { createHmac } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createOwnApiRouter, type RoutePrincipal } from "../api/router";
import { createCsrfToken } from "../auth/csrf";
import type { JobQueue } from "../tasks/jobQueue";
import { NFO_JOB_TYPES } from "./nfoJobs";
import { createNfoRoutes } from "./nfoRoutes";
import type { NfoPreview, NfoService } from "./nfoService";

const CSRF_SECRET = "s".repeat(32);
const SESSION_HASH = createHmac("sha256", "k").update("session").digest();
const MOVIE = "aaaaaaaa-1111-4111-8111-111111111111";
const MISSING = "aaaaaaaa-1111-4111-8111-111111111112";
const LIBRARY = "bbbbbbbb-2222-4222-8222-222222222222";

const PREVIEW: NfoPreview = {
  itemId: MOVIE,
  kind: "movie",
  mode: "sidecar",
  overwritePolicy: "managed-only",
  destination: "media-root",
  files: [
    {
      relativePath: "Movies/Dune (2021)/movie.nfo",
      xml: "<movie/>",
      existing: "absent",
      identical: false,
    },
  ],
};

function fakeService(overrides: Partial<NfoService> = {}): NfoService {
  return {
    config: {
      mode: "sidecar",
      overwritePolicy: "managed-only",
      arrManagedLibrarySlugs: new Set(),
    },
    preview: async (itemId) => (itemId === MOVIE ? PREVIEW : null),
    exportItem: async () => null,
    exportLibrary: async () => null,
    ...overrides,
  };
}

function fakeQueue(overrides: Partial<JobQueue> = {}): JobQueue {
  return {
    enqueue: async () => "dddddddd-4444-4444-8444-44444444444a",
    ...overrides,
  } as JobQueue;
}

function buildRouter(
  parts: {
    service?: NfoService;
    queue?: JobQueue;
    administrator?: boolean;
  } = {},
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
    routes: createNfoRoutes({
      service: parts.service ?? fakeService(),
      queue: parts.queue ?? fakeQueue(),
    }),
  });
}

async function call(
  router: ReturnType<typeof buildRouter>,
  method: string,
  routePath: string,
  body?: unknown,
) {
  const payload =
    body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  const csrfToken = createCsrfToken(SESSION_HASH, CSRF_SECRET);
  const request = Object.assign(
    Readable.from(payload === undefined ? [] : [payload]),
    {
      method,
      url: routePath,
      headers: {
        host: "seyirlik.test",
        origin: "https://seyirlik.test",
        cookie: `seyirlik_csrf=${csrfToken}`,
        "x-csrf-token": csrfToken,
        ...(payload === undefined
          ? {}
          : {
              "content-type": "application/json",
              "content-length": String(payload.length),
            }),
      },
      socket: { remoteAddress: "127.0.0.1" },
    },
  ) as unknown as IncomingMessage;

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

describe("nfo routes", () => {
  describe("preview", () => {
    it("returns the generated XML and its intended path", async () => {
      const result = await call(
        buildRouter(),
        "GET",
        `/ownAPI/v1/admin/items/${MOVIE}/nfo/preview`,
      );

      expect(result.sent.statusCode).toBe(200);
      expect(result.json?.data).toMatchObject({
        itemId: MOVIE,
        kind: "movie",
        mode: "sidecar",
        destination: "media-root",
      });
      expect((result.json?.data as NfoPreview).files[0]?.relativePath).toBe(
        "Movies/Dune (2021)/movie.nfo",
      );
    });

    it("is 404 for an unknown item", async () => {
      const result = await call(
        buildRouter(),
        "GET",
        `/ownAPI/v1/admin/items/${MISSING}/nfo/preview`,
      );

      expect((result.error as { statusCode?: number })?.statusCode).toBe(404);
    });

    it("rejects an invalid item id before touching the service", async () => {
      const preview = vi.fn(async () => PREVIEW);
      const result = await call(
        buildRouter({ service: fakeService({ preview }) }),
        "GET",
        "/ownAPI/v1/admin/items/not-a-uuid/nfo/preview",
      );

      expect((result.error as { statusCode?: number })?.statusCode).toBe(422);
      expect(preview).not.toHaveBeenCalled();
    });

    it("is refused for a non-administrator", async () => {
      const result = await call(
        buildRouter({ administrator: false }),
        "GET",
        `/ownAPI/v1/admin/items/${MOVIE}/nfo/preview`,
      );

      expect((result.error as { statusCode?: number })?.statusCode).toBe(403);
    });
  });

  describe("item export", () => {
    it("queues a task and reports it as accepted", async () => {
      const enqueue = vi.fn(async () => "dddddddd-4444-4444-8444-44444444444a");
      const result = await call(
        buildRouter({ queue: fakeQueue({ enqueue }) }),
        "POST",
        `/ownAPI/v1/admin/items/${MOVIE}/nfo/export`,
        {},
      );

      expect(result.sent.statusCode).toBe(202);
      expect(result.json?.data).toMatchObject({ status: "queued" });
      expect(enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          jobType: NFO_JOB_TYPES.exportItem,
          payload: { itemId: MOVIE, force: false },
        }),
      );
    });

    it("passes an explicit force through to the task", async () => {
      const enqueue = vi.fn(async () => "dddddddd-4444-4444-8444-44444444444a");
      await call(
        buildRouter({ queue: fakeQueue({ enqueue }) }),
        "POST",
        `/ownAPI/v1/admin/items/${MOVIE}/nfo/export`,
        { force: true },
      );

      expect(enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ payload: { itemId: MOVIE, force: true } }),
      );
    });

    it("keeps a forced export from collapsing onto an unforced one", async () => {
      const keys: string[] = [];
      const enqueue = vi.fn(async (options: { dedupeKey?: string }) => {
        keys.push(options.dedupeKey ?? "");
        return "dddddddd-4444-4444-8444-44444444444a";
      });
      const router = buildRouter({ queue: fakeQueue({ enqueue } as never) });

      await call(
        router,
        "POST",
        `/ownAPI/v1/admin/items/${MOVIE}/nfo/export`,
        {},
      );
      await call(router, "POST", `/ownAPI/v1/admin/items/${MOVIE}/nfo/export`, {
        force: true,
      });

      expect(new Set(keys).size).toBe(2);
    });

    it("rejects a body field it does not know", async () => {
      const result = await call(
        buildRouter(),
        "POST",
        `/ownAPI/v1/admin/items/${MOVIE}/nfo/export`,
        { forse: true },
      );

      expect((result.error as { statusCode?: number })?.statusCode).toBe(422);
    });

    it("is 404 for an unknown item rather than a task that fails later", async () => {
      const enqueue = vi.fn(async () => "dddddddd-4444-4444-8444-44444444444a");
      const result = await call(
        buildRouter({ queue: fakeQueue({ enqueue }) }),
        "POST",
        `/ownAPI/v1/admin/items/${MISSING}/nfo/export`,
        {},
      );

      expect((result.error as { statusCode?: number })?.statusCode).toBe(404);
      expect(enqueue).not.toHaveBeenCalled();
    });

    it("is refused for a non-administrator", async () => {
      const result = await call(
        buildRouter({ administrator: false }),
        "POST",
        `/ownAPI/v1/admin/items/${MOVIE}/nfo/export`,
        {},
      );

      expect((result.error as { statusCode?: number })?.statusCode).toBe(403);
    });
  });

  describe("library export", () => {
    it("queues a library task", async () => {
      const enqueue = vi.fn(async () => "dddddddd-4444-4444-8444-44444444444a");
      const result = await call(
        buildRouter({ queue: fakeQueue({ enqueue }) }),
        "POST",
        `/ownAPI/v1/admin/libraries/${LIBRARY}/nfo/export`,
        {},
      );

      expect(result.sent.statusCode).toBe(202);
      expect(enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          jobType: NFO_JOB_TYPES.exportLibrary,
          payload: { libraryId: LIBRARY, force: false },
        }),
      );
    });

    it("rejects an invalid library id", async () => {
      const result = await call(
        buildRouter(),
        "POST",
        "/ownAPI/v1/admin/libraries/nope/nfo/export",
        {},
      );

      expect((result.error as { statusCode?: number })?.statusCode).toBe(422);
    });

    it("is refused for a non-administrator", async () => {
      const result = await call(
        buildRouter({ administrator: false }),
        "POST",
        `/ownAPI/v1/admin/libraries/${LIBRARY}/nfo/export`,
        {},
      );

      expect((result.error as { statusCode?: number })?.statusCode).toBe(403);
    });
  });
});
