import { describe, expect, it } from "vitest";
import type { RouteContext, RouteDefinition } from "../api/router";
import type { CatalogueRepository } from "../catalogue/catalogueRepository";
import type { OwnApiError } from "../ownApiHandler";
import type {
  BookPosition,
  BookPositionRepository,
} from "./bookPositionRepository";
import { createBookPositionRoutes } from "./bookPositionRoutes";

const READER = "11111111-1111-4111-8111-111111111111";
const BOOK = "22222222-2222-4222-8222-222222222222";
const MOVIE = "33333333-3333-4333-8333-333333333333";
const HIDDEN = "44444444-4444-4444-8444-444444444444";
const NOW = Date.UTC(2026, 9, 5, 18);

function setup() {
  const kinds: Record<string, string> = { [BOOK]: "book", [MOVIE]: "movie" };
  const catalogue = {
    // A hidden item is indistinguishable from a missing one: visibility is the
    // repository's decision, made per user.
    getItem: async (_userId: string, itemId: string) =>
      itemId === HIDDEN || !kinds[itemId] ? null : { kind: kinds[itemId] },
  } as unknown as CatalogueRepository;

  const stored = new Map<string, BookPosition>();
  const saves: BookPosition[] = [];
  const positions: BookPositionRepository = {
    get: async (userId, itemId) => stored.get(`${userId}:${itemId}`) ?? null,
    save: async (userId, itemId, position) => {
      saves.push(position);
      const key = `${userId}:${itemId}`;
      const current = stored.get(key);
      const accepted = !current || position.readAt >= current.readAt;
      if (accepted) stored.set(key, position);
      return { accepted, position: stored.get(key) ?? null };
    },
  };

  const routes = createBookPositionRoutes({ positions, catalogue });
  const route = (method: string) =>
    routes.find(
      (entry) =>
        entry.method === method && entry.path === "/books/:itemId/position",
    ) as RouteDefinition;

  async function call(method: "GET" | "PUT", itemId: string, body?: unknown) {
    const captured: { status: number; body: unknown } = {
      status: 0,
      body: null,
    };
    const context = {
      request: { headers: {} },
      response: {
        setHeader: () => undefined,
        end: (chunk?: string) => {
          captured.body = chunk ? JSON.parse(chunk) : null;
        },
        set statusCode(status: number) {
          captured.status = status;
        },
        get statusCode() {
          return captured.status;
        },
      },
      requestId: "req",
      url: new URL(`http://localhost/ownAPI/v1/books/${itemId}/position`),
      params: { itemId },
      method,
      requirePrincipal: () => ({ userId: READER, isAdministrator: false }),
      readJson: async () => body,
    } as unknown as RouteContext;

    try {
      await route(method).handle(context);
      return { ...captured, error: undefined as OwnApiError | undefined };
    } catch (error) {
      return { ...captured, error: error as OwnApiError };
    }
  }

  return { call, route, saves };
}

const place = { section: 3, block: 0, offset: -184 };

describe("book reading positions", () => {
  it("is for signed-in readers, and a write needs the CSRF token", () => {
    const { route } = setup();
    expect(route("GET").access).toBe("authenticated");
    expect(route("PUT").access).toBe("authenticated");
    expect(route("PUT").skipCsrf).toBeUndefined();
  });

  it("has nothing until a place is saved, then returns it", async () => {
    const { call } = setup();
    expect((await call("GET", BOOK)).body).toMatchObject({ data: null });

    const saved = await call("PUT", BOOK, {
      cfi: "epubcfi(/6/8!/4/2/1:0)",
      place,
      fraction: 0.02,
      readAt: NOW,
    });
    expect(saved.error).toBeUndefined();
    expect(saved.body).toMatchObject({
      data: {
        accepted: true,
        position: {
          cfi: "epubcfi(/6/8!/4/2/1:0)",
          place,
          fraction: 0.02,
          readAt: new Date(NOW).toISOString(),
        },
      },
    });
    expect((await call("GET", BOOK)).body).toMatchObject({
      data: { place, fraction: 0.02 },
    });
  });

  it("answers a late save with the place that beat it, not an error", async () => {
    const { call } = setup();
    await call("PUT", BOOK, { place, fraction: 0.3, readAt: NOW });
    const late = await call("PUT", BOOK, {
      place: { section: 1, block: 0, offset: 0 },
      fraction: 0.01,
      readAt: NOW - 60_000,
    });

    expect(late.error).toBeUndefined();
    expect(late.body).toMatchObject({
      data: { accepted: false, position: { place, fraction: 0.3 } },
    });
  });

  it("takes a plain document's fraction alone", async () => {
    const { call, saves } = setup();
    const saved = await call("PUT", BOOK, { fraction: 0.5, readAt: NOW });
    expect(saved.error).toBeUndefined();
    expect(saves[0]).toMatchObject({ cfi: null, place: null, fraction: 0.5 });
  });

  it("answers for a film, a hidden book and a missing one exactly alike", async () => {
    const { call, saves } = setup();
    for (const itemId of [
      MOVIE,
      HIDDEN,
      "55555555-5555-4555-8555-555555555555",
    ]) {
      for (const method of ["GET", "PUT"] as const) {
        const { error } = await call(method, itemId, {
          fraction: 0.5,
          readAt: NOW,
        });
        expect(error?.statusCode).toBe(404);
        expect(error?.code).toBe("ITEM_NOT_FOUND");
      }
    }
    expect(saves).toHaveLength(0);
  });

  it("refuses a malformed position before storing anything", async () => {
    const { call, saves } = setup();
    const bad = [
      { fraction: 1.5, readAt: NOW },
      { fraction: -0.1, readAt: NOW },
      { fraction: "0.5", readAt: NOW },
      { readAt: NOW },
      { fraction: 0.5 },
      { fraction: 0.5, readAt: 12 },
      { fraction: 0.5, readAt: NOW + 0.5 },
      { fraction: 0.5, readAt: NOW, cfi: "/6/8!/4" },
      { fraction: 0.5, readAt: NOW, cfi: `epubcfi(${"x".repeat(2_100)})` },
      { fraction: 0.5, readAt: NOW, place: { section: 1, block: 2 } },
      {
        fraction: 0.5,
        readAt: NOW,
        place: { section: -1, block: 0, offset: 0 },
      },
      {
        fraction: 0.5,
        readAt: NOW,
        place: { section: 1, block: 0, offset: 0, extra: 1 },
      },
      { fraction: 0.5, readAt: NOW, place: [1, 2, 3] },
      { fraction: 0.5, readAt: NOW, userId: READER },
      null,
    ];
    for (const body of bad) {
      const { error } = await call("PUT", BOOK, body);
      expect(error?.statusCode, JSON.stringify(body)).toBe(422);
    }
    expect(saves).toHaveLength(0);
  });

  it("rejects an id that is not a UUID", async () => {
    const { call } = setup();
    expect((await call("GET", "nope")).error?.statusCode).toBe(422);
  });
});
