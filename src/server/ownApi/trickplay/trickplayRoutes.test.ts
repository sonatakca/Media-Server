import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RouteContext, RouteDefinition } from "../api/router";
import type { CatalogueRepository } from "../catalogue/catalogueRepository";
import type { JobQueue } from "../tasks/jobQueue";
import { OwnApiError } from "../ownApiHandler";
import { buildTrickplayLayout } from "./trickplayLayout";
import { createTrickplayRoutes } from "./trickplayRoutes";
import { writeTrickplaySheets } from "./trickplayTestFixtures";
import type { TrickplaySet, TrickplayService } from "./trickplayService";
import { spritePathIn, trickplayDirectoryFor } from "./trickplayStorage";

const ITEM_ID = "a504de76-a209-450e-8035-10b36fa56b3e";
const SET_ID = "3f2ab1de-0000-4000-8000-000000000001";
const FILE_ID = "3f2ab1de-0000-4000-8000-000000000002";

const LAYOUT = buildTrickplayLayout({
  durationMs: 3_600_000,
  sourceWidth: 1920,
  sourceHeight: 1080,
});
const WIDTH = LAYOUT.columns * LAYOUT.tileWidth;
const HEIGHT = LAYOUT.rows * LAYOUT.tileHeight;

/**
 * Serving a sheet.
 *
 * A sprite URL carries a set id and an index; the filesystem location is
 * resolved on the server and never leaves it. These tests exist to keep it that
 * way, and to keep the boundary between "this sheet does not exist" and "this
 * sheet is not yours" where it is.
 */
describe("serving trickplay sheets", () => {
  let mediaRoot: string;
  let titleRoot: string;
  let set: TrickplaySet | null;
  let canAccess: boolean;

  function service(): TrickplayService {
    return {
      findForItem: async () => set,
      findById: async () => set,
      spritePath: async (candidate, index) => {
        if (candidate.storagePrefix) return null;
        return spritePathIn(trickplayDirectoryFor(titleRoot), index);
      },
      generateForItem: async () => set,
      listGeneratedMediaFileIds: async () => new Set<string>(),
      deleteForItem: async () => undefined,
    };
  }

  function routes(): RouteDefinition[] {
    const catalogue = {
      canUserAccessItem: async () => canAccess,
      getFileById: async () => ({ id: FILE_ID, itemId: ITEM_ID }),
    } as unknown as CatalogueRepository;
    const queue = { enqueue: async () => "task-1" } as unknown as JobQueue;
    return createTrickplayRoutes({ trickplay: service(), catalogue, queue });
  }

  function route(routePath: string): RouteDefinition {
    const found = routes().find((candidate) => candidate.path === routePath);
    if (!found) throw new Error(`No route at ${routePath}`);
    return found;
  }

  interface Captured {
    statusCode: number;
    headers: Record<string, string>;
    body: Buffer;
  }

  async function call(
    routePath: string,
    params: Record<string, string>,
  ): Promise<{ captured: Captured; error: unknown }> {
    const captured: Captured = {
      statusCode: 0,
      headers: {},
      body: Buffer.alloc(0),
    };
    const chunks: Buffer[] = [];
    const response = {
      statusCode: 200,
      setHeader: (name: string, value: string) => {
        captured.headers[name.toLowerCase()] = String(value);
      },
      on: () => undefined,
      write: (chunk: Buffer) => {
        chunks.push(Buffer.from(chunk));
        return true;
      },
      end: () => undefined,
      once: () => undefined,
      emit: () => undefined,
    } as unknown as ServerResponse;

    const context = {
      request: { headers: {} } as unknown as IncomingMessage,
      response,
      requestId: "req-1",
      url: new URL("https://seyirlik.test/"),
      params,
      method: "HEAD",
      principal: { userId: "user-1" },
      requirePrincipal: () => ({ userId: "user-1" }),
      readJson: async () => ({}),
    } as unknown as RouteContext;

    const error = await route(routePath)
      .handle(context)
      .then(
        () => null,
        (thrown: unknown) => thrown,
      );
    captured.statusCode = response.statusCode;
    captured.body = Buffer.concat(chunks);
    return { captured, error };
  }

  const SPRITE_ROUTE = "/trickplay/:setId/sprites/:spriteIndex";

  beforeEach(async () => {
    mediaRoot = await mkdtemp(path.join(tmpdir(), "trickplay-routes-"));
    titleRoot = path.join(mediaRoot, "Movies", "Dune (2021)");
    await mkdir(titleRoot, { recursive: true });
    await writeTrickplaySheets({
      directory: trickplayDirectoryFor(titleRoot),
      count: LAYOUT.spriteCount,
      width: WIDTH,
      height: HEIGHT,
    });
    canAccess = true;
    set = {
      id: SET_ID,
      mediaFileId: FILE_ID,
      storagePrefix: null,
      contentType: "image/jpeg",
      ...LAYOUT,
    };
  });

  afterEach(async () => {
    await rm(mediaRoot, { recursive: true, force: true });
  });

  it("serves the first sheet as a JPEG", async () => {
    const { captured, error } = await call(SPRITE_ROUTE, {
      setId: SET_ID,
      spriteIndex: "0",
    });

    expect(error).toBeNull();
    expect(captured.statusCode).toBe(200);
    expect(captured.headers["content-type"]).toBe("image/jpeg");
    expect(captured.headers["x-content-type-options"]).toBe("nosniff");
    expect(Number(captured.headers["content-length"])).toBeGreaterThan(0);
  });

  it("serves a middle sheet and the last one", async () => {
    for (const index of [1, LAYOUT.spriteCount - 1]) {
      const { error } = await call(SPRITE_ROUTE, {
        setId: SET_ID,
        spriteIndex: String(index),
      });
      expect(error).toBeNull();
    }
  });

  it("refuses one past the end rather than reading a file that is not there", async () => {
    const { error } = await call(SPRITE_ROUTE, {
      setId: SET_ID,
      spriteIndex: String(LAYOUT.spriteCount),
    });

    expect((error as OwnApiError).statusCode).toBe(404);
  });

  it("reports a missing sheet as missing, not as a server error", async () => {
    await rm(spritePathIn(trickplayDirectoryFor(titleRoot), 0));

    const { error } = await call(SPRITE_ROUTE, {
      setId: SET_ID,
      spriteIndex: "0",
    });

    expect((error as OwnApiError).statusCode).toBe(404);
  });

  it("reports a missing set as missing", async () => {
    set = null;

    const { error } = await call(SPRITE_ROUTE, {
      setId: SET_ID,
      spriteIndex: "0",
    });

    expect((error as OwnApiError).statusCode).toBe(404);
  });

  /*
   * Holding a set id is not authorization. Sheets inherit the visibility of the
   * item whose file produced them.
   */
  it("refuses a set the viewer cannot reach the item for", async () => {
    canAccess = false;

    const { error } = await call(SPRITE_ROUTE, {
      setId: SET_ID,
      spriteIndex: "0",
    });

    expect((error as OwnApiError).statusCode).toBe(404);
  });

  /*
   * The index is the only part of a sprite URL that reaches the filesystem, and
   * it is constrained to digits before it gets there. These are the shapes a
   * traversal would have to take.
   */
  it("rejects an index that is not a plain number", async () => {
    for (const spriteIndex of [
      "../../etc/passwd",
      "0/../..",
      "-1",
      "0.jpg",
      "",
    ]) {
      const { error } = await call(SPRITE_ROUTE, {
        setId: SET_ID,
        spriteIndex,
      });
      expect(error).toBeInstanceOf(OwnApiError);
      expect([404, 422]).toContain((error as OwnApiError).statusCode);
    }
  });

  it("gives the client geometry and a URL template, never a path", async () => {
    const body: Record<string, unknown> = {};
    const context = {
      request: { headers: {} } as unknown as IncomingMessage,
      response: {
        statusCode: 200,
        setHeader: () => undefined,
        end: (payload: string) => {
          Object.assign(body, JSON.parse(payload) as Record<string, unknown>);
        },
      } as unknown as ServerResponse,
      requestId: "req-1",
      url: new URL("https://seyirlik.test/"),
      params: { itemId: ITEM_ID },
      method: "GET",
      principal: { userId: "user-1" },
      requirePrincipal: () => ({ userId: "user-1" }),
      readJson: async () => ({}),
    } as unknown as RouteContext;

    await route("/items/:itemId/trickplay").handle(context);

    const data = body.data as Record<string, unknown>;
    expect(data.spriteUrlTemplate).toBe(
      `/ownAPI/v1/trickplay/${SET_ID}/sprites/{index}`,
    );
    expect(data.tileWidth).toBe(LAYOUT.tileWidth);
    expect(JSON.stringify(body)).not.toContain(mediaRoot);
    expect(JSON.stringify(body)).not.toContain("trickplay/sprite_");
  });
});
