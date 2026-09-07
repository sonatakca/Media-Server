import { createHmac } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createOwnApiRouter, type RoutePrincipal } from "../api/router";
import { createCsrfToken } from "../auth/csrf";
import { OwnApiError } from "../ownApiHandler";
import type { CatalogueRepository } from "../catalogue/catalogueRepository";
import { createCurationRoutes } from "./curationRoutes";
import type {
  CuratedList,
  CuratedListKey,
  CurationRepository,
} from "./curationRepository";

const CSRF_SECRET = "s".repeat(32);
const SESSION_HASH = createHmac("sha256", "k").update("session").digest();
const USER = "11111111-1111-4111-8111-111111111111";
const LIBRARY = "22222222-2222-4222-8222-222222222222";
const OTHER_LIBRARY = "33333333-3333-4333-8333-333333333333";
const ITEM_A = "aaaaaaaa-1111-4111-8111-111111111111";
const ITEM_B = "bbbbbbbb-2222-4222-8222-222222222222";
/** Exists in the catalogue but sits in a library this user was never granted. */
const UNSEEN_ITEM = "cccccccc-3333-4333-8333-333333333333";

function keyOf(key: CuratedListKey): string {
  return `${key.surface}:${key.libraryId ?? ""}`;
}

function fakeCuration(seed: CuratedList[] = []) {
  const stored = new Map<string, CuratedList>(
    seed.map((list) => [keyOf(list), list]),
  );
  const repository: CurationRepository = {
    get: async (key) =>
      stored.get(keyOf(key)) ?? { ...key, entries: [], updatedAt: null },
    replace: async (key, entries) => {
      stored.set(keyOf(key), {
        ...key,
        entries,
        updatedAt: new Date("2026-05-05T00:00:00Z"),
      });
    },
    clear: async (key) => {
      stored.delete(keyOf(key));
    },
    filterExistingItemIds: async (itemIds) =>
      new Set(
        itemIds.filter((itemId) =>
          [ITEM_A, ITEM_B, UNSEEN_ITEM].includes(itemId),
        ),
      ),
    filterVisibleItemIds: async (_userId, itemIds) =>
      new Set(itemIds.filter((itemId) => itemId !== UNSEEN_ITEM)),
    libraryExists: async (libraryId) =>
      libraryId === LIBRARY || libraryId === OTHER_LIBRARY,
  };

  return { repository, stored };
}

/** Only `LIBRARY` is granted to this user; `OTHER_LIBRARY` is somebody else's. */
function fakeCatalogue(): CatalogueRepository {
  return {
    getLibrary: async (_userId: string, libraryId: string) =>
      libraryId === LIBRARY
        ? {
            id: LIBRARY,
            slug: "movies",
            name: "Movies",
            kind: "movies",
            sortOrder: 0,
            itemCount: 2,
          }
        : null,
  } as unknown as CatalogueRepository;
}

function buildRouter(
  options: { isAdministrator?: boolean; seed?: CuratedList[] } = {},
) {
  const { repository, stored } = fakeCuration(options.seed ?? []);

  const router = createOwnApiRouter({
    csrfSecret: CSRF_SECRET,
    csrfCookieName: "seyirlik_csrf",
    publicOrigin: "https://seyirlik.test",
    resolveSession: async (): Promise<RoutePrincipal> => ({
      userId: USER,
      username: "viewer",
      displayName: "Viewer",
      isAdministrator: options.isAdministrator ?? true,
      sessionId: "dddddddd-4444-4444-8444-444444444444",
      sessionTokenHash: SESSION_HASH,
    }),
    routes: createCurationRoutes({
      curation: repository,
      catalogue: fakeCatalogue(),
    }),
  });

  return { router, stored };
}

async function call(
  router: ReturnType<typeof buildRouter>["router"],
  method: string,
  path: string,
  options: { body?: unknown } = {},
) {
  const payload =
    options.body === undefined ? undefined : JSON.stringify(options.body);
  const csrfToken = createCsrfToken(SESSION_HASH, CSRF_SECRET);
  const headers: Record<string, string> = {
    host: "seyirlik.test",
    origin: "https://seyirlik.test",
    cookie: `seyirlik_csrf=${csrfToken}`,
    "x-csrf-token": csrfToken,
    ...(payload === undefined ? {} : { "content-type": "application/json" }),
  };

  const request = Object.assign(
    Readable.from(payload === undefined ? [] : [Buffer.from(payload)]),
    { method, url: path, headers, socket: { remoteAddress: "127.0.0.1" } },
  ) as unknown as IncomingMessage;

  const sent = {
    statusCode: 200,
    headers: {} as Record<string, string | string[]>,
    body: "",
  };
  const response = {
    get statusCode() {
      return sent.statusCode;
    },
    set statusCode(value: number) {
      sent.statusCode = value;
    },
    setHeader(name: string, value: string | string[]) {
      sent.headers[name] = value;
    },
    getHeader(name: string) {
      return sent.headers[name];
    },
    end(chunk?: string) {
      sent.body = chunk ?? "";
    },
  } as unknown as ServerResponse;

  let error: unknown;
  try {
    await router.handler(request, response, {
      requestId: "req-1",
      url: new URL(path, "https://seyirlik.test"),
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

const BASE = "/ownAPI/v1";

describe("curation routes", () => {
  it("returns an empty ordering for a shelf nobody has curated", async () => {
    const { router } = buildRouter();
    const result = await call(router, "GET", `${BASE}/curation/home-hero`);

    expect(result.sent.statusCode).toBe(200);
    expect(result.json).toMatchObject({
      data: { surface: "home-hero", libraryId: null, entries: [] },
    });
  });

  it("returns the saved ordering in position order", async () => {
    const { router } = buildRouter({
      seed: [
        {
          surface: "home-hero",
          entries: [
            { itemId: ITEM_B, hidden: false },
            { itemId: ITEM_A, hidden: true },
          ],
          updatedAt: new Date("2026-05-05T00:00:00Z"),
        },
      ],
    });
    const result = await call(router, "GET", `${BASE}/curation/home-hero`);

    expect(result.json?.data).toMatchObject({
      entries: [
        { itemId: ITEM_B, hidden: false },
        { itemId: ITEM_A, hidden: true },
      ],
      updatedAt: "2026-05-05T00:00:00.000Z",
    });
  });

  it("omits entries for titles the caller cannot see", async () => {
    const { router } = buildRouter({
      seed: [
        {
          surface: "home-hero",
          entries: [
            { itemId: UNSEEN_ITEM, hidden: false },
            { itemId: ITEM_A, hidden: false },
          ],
          updatedAt: null,
        },
      ],
    });
    const result = await call(router, "GET", `${BASE}/curation/home-hero`);

    expect(result.json?.data).toMatchObject({
      entries: [{ itemId: ITEM_A, hidden: false }],
    });
  });

  it("reads a library grid the caller was granted", async () => {
    const { router } = buildRouter({
      seed: [
        {
          surface: "library",
          libraryId: LIBRARY,
          entries: [{ itemId: ITEM_A, hidden: false }],
          updatedAt: null,
        },
      ],
    });
    const result = await call(
      router,
      "GET",
      `${BASE}/curation/library?libraryId=${LIBRARY}`,
    );

    expect(result.json?.data).toMatchObject({
      libraryId: LIBRARY,
      entries: [{ itemId: ITEM_A, hidden: false }],
    });
  });

  it("answers for an ungranted library exactly as it does for an empty one", async () => {
    const { router } = buildRouter({
      seed: [
        {
          surface: "library",
          libraryId: OTHER_LIBRARY,
          entries: [{ itemId: ITEM_A, hidden: false }],
          updatedAt: new Date("2026-05-05T00:00:00Z"),
        },
      ],
    });
    const result = await call(
      router,
      "GET",
      `${BASE}/curation/library?libraryId=${OTHER_LIBRARY}`,
    );

    expect(result.sent.statusCode).toBe(200);
    expect(result.json?.data).toMatchObject({ entries: [], updatedAt: null });
  });

  it("rejects a surface that is not one of the known shelves", async () => {
    const { router } = buildRouter();
    const result = await call(
      router,
      "GET",
      `${BASE}/curation/home-everything`,
    );

    expect((result.error as OwnApiError).statusCode).toBe(422);
  });

  it("requires a library id for a library grid and refuses one elsewhere", async () => {
    const { router } = buildRouter();

    expect(
      (
        (await call(router, "GET", `${BASE}/curation/library`))
          .error as OwnApiError
      ).statusCode,
    ).toBe(422);
    expect(
      (
        (
          await call(
            router,
            "GET",
            `${BASE}/curation/home-hero?libraryId=${LIBRARY}`,
          )
        ).error as OwnApiError
      ).statusCode,
    ).toBe(422);
  });

  it("stores an ordering an administrator saves", async () => {
    const { router, stored } = buildRouter();
    const result = await call(
      router,
      "PUT",
      `${BASE}/admin/curation/home-hero`,
      {
        body: {
          entries: [{ itemId: ITEM_B }, { itemId: ITEM_A, hidden: true }],
        },
      },
    );

    expect(result.sent.statusCode).toBe(200);
    expect(result.json?.data).toMatchObject({ entryCount: 2 });
    expect(stored.get("home-hero:")?.entries).toEqual([
      { itemId: ITEM_B, hidden: false },
      { itemId: ITEM_A, hidden: true },
    ]);
  });

  it("refuses a save from a user who is not an administrator", async () => {
    const { router, stored } = buildRouter({ isAdministrator: false });
    const result = await call(
      router,
      "PUT",
      `${BASE}/admin/curation/home-hero`,
      { body: { entries: [{ itemId: ITEM_A }] } },
    );

    expect((result.error as OwnApiError).statusCode).toBe(403);
    expect(stored.size).toBe(0);
  });

  it("refuses a save naming an item that does not exist", async () => {
    const { router, stored } = buildRouter();
    const result = await call(
      router,
      "PUT",
      `${BASE}/admin/curation/home-hero`,
      {
        body: { entries: [{ itemId: "eeeeeeee-5555-4555-8555-555555555555" }] },
      },
    );

    expect((result.error as OwnApiError).statusCode).toBe(422);
    expect(stored.size).toBe(0);
  });

  it("refuses a save that names one title twice", async () => {
    const { router, stored } = buildRouter();
    const result = await call(
      router,
      "PUT",
      `${BASE}/admin/curation/home-hero`,
      { body: { entries: [{ itemId: ITEM_A }, { itemId: ITEM_A }] } },
    );

    expect((result.error as OwnApiError).statusCode).toBe(422);
    expect(stored.size).toBe(0);
  });

  it("refuses a body carrying an unknown field", async () => {
    const { router } = buildRouter();
    const result = await call(
      router,
      "PUT",
      `${BASE}/admin/curation/home-hero`,
      { body: { entries: [], surface: "home-hero" } },
    );

    expect((result.error as OwnApiError).statusCode).toBe(422);
  });

  it("refuses a save for a library that does not exist", async () => {
    const { router } = buildRouter();
    const result = await call(router, "PUT", `${BASE}/admin/curation/library`, {
      body: {
        libraryId: "eeeeeeee-6666-4666-8666-666666666666",
        entries: [{ itemId: ITEM_A }],
      },
    });

    expect((result.error as OwnApiError).statusCode).toBe(422);
  });

  it("clears an ordering, and clearing an absent one still succeeds", async () => {
    const { router, stored } = buildRouter({
      seed: [
        {
          surface: "home-hero",
          entries: [{ itemId: ITEM_A, hidden: false }],
          updatedAt: null,
        },
      ],
    });

    const first = await call(
      router,
      "DELETE",
      `${BASE}/admin/curation/home-hero`,
    );
    expect(first.sent.statusCode).toBe(204);
    expect(stored.size).toBe(0);

    const second = await call(
      router,
      "DELETE",
      `${BASE}/admin/curation/home-hero`,
    );
    expect(second.sent.statusCode).toBe(204);
  });
});
