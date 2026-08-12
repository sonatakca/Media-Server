import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createOwnApiRouter, type RoutePrincipal } from "../api/router";
import { OwnApiError } from "../ownApiHandler";
import { createBookRoutes } from "./bookRoutes";
import type { CatalogueRepository } from "../catalogue/catalogueRepository";

const VIEWER = "11111111-1111-4111-8111-111111111111";
const BOOK = "22222222-2222-4222-8222-222222222222";
const MOVIE = "33333333-3333-4333-8333-333333333333";
const HIDDEN = "44444444-4444-4444-8444-444444444444";
const MISSING_FILE = "55555555-5555-4555-8555-555555555555";

const EPUB_BYTES = "PK pretend epub";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "seyirlik-books-"));
  await mkdir(path.join(root, "Books", "1984"), { recursive: true });
  await writeFile(path.join(root, "Books", "1984", "1984.epub"), EPUB_BYTES);

  const items: Record<string, { kind: string }> = {
    [BOOK]: { kind: "book" },
    [MOVIE]: { kind: "movie" },
    [MISSING_FILE]: { kind: "book" },
  };

  const catalogue = {
    // A hidden item is indistinguishable from a missing one here, which is the
    // point: visibility is decided by the repository, not by the route.
    getItem: async (_userId: string, itemId: string) =>
      itemId === HIDDEN ? null : (items[itemId] ?? null),
    getPrimaryFile: async (itemId: string) =>
      itemId === BOOK
        ? { relativePath: "Books/1984/1984.epub", missingSince: null }
        : itemId === MISSING_FILE
          ? { relativePath: "Books/gone/gone.epub", missingSince: new Date() }
          : null,
  } as unknown as CatalogueRepository;

  return { root, catalogue };
}

async function call(root: string, catalogue: CatalogueRepository, path_: string) {
  const router = createOwnApiRouter({
    csrfSecret: "s".repeat(32),
    csrfCookieName: "seyirlik_csrf",
    publicOrigin: "https://seyirlik.test",
    resolveSession: async (): Promise<RoutePrincipal> => ({
      userId: VIEWER,
      username: "viewer",
      displayName: "Viewer",
      isAdministrator: false,
      sessionId: "66666666-6666-4666-8666-666666666666",
      sessionTokenHash: Buffer.alloc(32),
    }),
    routes: createBookRoutes({ catalogue, mediaRoot: root }),
  });

  const request = {
    method: "GET",
    url: path_,
    headers: { host: "seyirlik.test" },
    socket: { remoteAddress: "127.0.0.1" },
  } as unknown as IncomingMessage;

  // A real writable, because serveFile pipes a read stream into it — a plain
  // object with an `end` method is not something you can pipe to.
  const sent = { statusCode: 200, headers: {} as Record<string, unknown>, body: "" };
  const response = Object.assign(
    new Writable({
      write(chunk, _encoding, callback) {
        sent.body += String(chunk);
        callback();
      },
    }),
    {
      get statusCode() {
        return sent.statusCode;
      },
      set statusCode(value: number) {
        sent.statusCode = value;
      },
      setHeader(name: string, value: unknown) {
        sent.headers[name] = value;
      },
      getHeader(name: string) {
        return sent.headers[name];
      },
    },
  ) as unknown as ServerResponse;

  let error: unknown;
  try {
    await router.handler(request, response, {
      requestId: "req-1",
      url: new URL(path_, "https://seyirlik.test"),
    });
  } catch (caught) {
    error = caught;
  }
  return { sent, error };
}

describe("reading a book", () => {
  it("serves the file with a type epub.js will accept", async () => {
    // epub.js refuses an archive it is not told the type of, so the content
    // type is as load-bearing here as the bytes.
    const { root, catalogue } = await fixture();
    const { sent, error } = await call(
      root,
      catalogue,
      `/ownAPI/v1/items/${BOOK}/file`,
    );

    expect(error).toBeUndefined();
    expect(sent.headers["Content-Type"]).toBe("application/epub+zip");
    expect(sent.headers["Accept-Ranges"]).toBe("bytes");
    expect(sent.headers["Content-Length"]).toBe(String(EPUB_BYTES.length));
    expect(sent.body).toBe(EPUB_BYTES);
  });

  it("refuses anything that is not a book", async () => {
    // Everything else goes through a playback session, which is where the
    // container and codec decisions are made; a second way in would skip them.
    const { root, catalogue } = await fixture();
    const { error } = await call(
      root,
      catalogue,
      `/ownAPI/v1/items/${MOVIE}/file`,
    );

    expect((error as OwnApiError).statusCode).toBe(422);
    expect((error as OwnApiError).code).toBe("NOT_A_BOOK");
  });

  it("refuses a book in a library the viewer cannot see", async () => {
    const { root, catalogue } = await fixture();
    const { error } = await call(
      root,
      catalogue,
      `/ownAPI/v1/items/${HIDDEN}/file`,
    );

    expect((error as OwnApiError).statusCode).toBe(404);
  });

  it("reports a book whose file has gone as not found", async () => {
    const { root, catalogue } = await fixture();
    const { error } = await call(
      root,
      catalogue,
      `/ownAPI/v1/items/${MISSING_FILE}/file`,
    );

    expect((error as OwnApiError).statusCode).toBe(404);
  });

  it("rejects an id that is not a UUID before touching the catalogue", async () => {
    const { root, catalogue } = await fixture();
    const { error } = await call(root, catalogue, "/ownAPI/v1/items/nope/file");

    expect((error as OwnApiError).statusCode).toBe(422);
  });
});
