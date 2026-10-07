import path from "node:path";
import { describe, expect, it } from "vitest";
import type { RouteContext, RouteDefinition } from "../api/router";
import type { CatalogueRepository } from "../catalogue/catalogueRepository";
import type { OwnApiError } from "../ownApiHandler";
import type { BookSearch, BookToSearch } from "./bookSearch";
import { createBookSearchRoutes } from "./bookSearchRoutes";

const READER = "11111111-1111-4111-8111-111111111111";
const BOOK = "22222222-2222-4222-8222-222222222222";
const MOVIE = "33333333-3333-4333-8333-333333333333";
const HIDDEN = "44444444-4444-4444-8444-444444444444";
const ESCAPING = "55555555-5555-4555-8555-555555555555";
const MEDIA_ROOT = path.resolve("/srv/media");

function setup() {
  const kinds: Record<string, string> = {
    [BOOK]: "book",
    [MOVIE]: "movie",
    [ESCAPING]: "book",
  };
  const catalogue = {
    getItem: async (_userId: string, itemId: string) =>
      itemId === HIDDEN || !kinds[itemId] ? null : { kind: kinds[itemId] },
    getPrimaryFile: async (itemId: string) => ({
      id: "file-1",
      fingerprint: "abc",
      relativePath:
        itemId === ESCAPING ? "../outside.epub" : "Books/Madonna.epub",
      missingSince: null,
    }),
  } as unknown as CatalogueRepository;

  const asked: Array<{ book: BookToSearch; query: string }> = [];
  const search: BookSearch = {
    search: async (book, query) => {
      asked.push({ book, query });
      return { state: "preparing", progress: null };
    },
    close: () => undefined,
  };

  const route = createBookSearchRoutes({
    search,
    catalogue,
    mediaRoot: MEDIA_ROOT,
  })[0] as RouteDefinition;

  async function call(itemId: string, body: unknown) {
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
      url: new URL(`http://localhost/ownAPI/v1/books/${itemId}/search`),
      params: { itemId },
      method: "POST",
      requirePrincipal: () => ({ userId: READER, isAdministrator: false }),
      readJson: async () => body,
    } as unknown as RouteContext;

    try {
      await route.handle(context);
      return { ...captured, error: undefined as OwnApiError | undefined };
    } catch (error) {
      return { ...captured, error: error as OwnApiError };
    }
  }

  return { call, route, asked };
}

describe("searching a book", () => {
  it("is for signed-in readers and needs the CSRF token", () => {
    const { route } = setup();
    expect(route).toMatchObject({
      method: "POST",
      path: "/books/:itemId/search",
      access: "authenticated",
    });
    expect(route.skipCsrf).toBeUndefined();
  });

  it("asks about the book's file by a key that changes with the file", async () => {
    const { call, asked } = setup();
    const result = await call(BOOK, { query: "  Maria güldü  " });
    expect(result.error).toBeUndefined();
    expect(result.body).toMatchObject({
      data: { state: "preparing", progress: null },
    });
    expect(asked).toEqual([
      {
        book: {
          itemId: BOOK,
          filePath: path.join(MEDIA_ROOT, "Books", "Madonna.epub"),
          sourceKey: "file-1:abc",
        },
        query: "Maria güldü",
      },
    ]);
  });

  it("treats a missing query as preparing the book", async () => {
    const { call, asked } = setup();
    await call(BOOK, {});
    expect(asked[0]?.query).toBe("");
  });

  it("answers a hidden book exactly like a missing one", async () => {
    const { call, asked } = setup();
    const hidden = await call(HIDDEN, { query: "x" });
    const missing = await call("66666666-6666-4666-8666-666666666666", {
      query: "x",
    });
    expect(hidden.error?.statusCode).toBe(404);
    expect(missing.error?.code).toBe(hidden.error?.code);
    expect(asked).toEqual([]);
  });

  it("searches only books, and only files inside the media root", async () => {
    const { call, asked } = setup();
    expect((await call(MOVIE, { query: "x" })).error?.code).toBe("NOT_A_BOOK");
    expect((await call(ESCAPING, { query: "x" })).error?.statusCode).toBe(404);
    expect(asked).toEqual([]);
  });

  it("refuses a query longer than a question, and unknown fields", async () => {
    const { call, asked } = setup();
    expect(
      (await call(BOOK, { query: "a".repeat(301) })).error?.statusCode,
    ).toBe(422);
    expect((await call(BOOK, { query: "x", extra: 1 })).error?.statusCode).toBe(
      422,
    );
    expect(asked).toEqual([]);
  });
});
