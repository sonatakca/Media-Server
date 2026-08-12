import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { OwnApiError } from "../ownApiHandler";
import { sendAccepted, sendData } from "../api/envelope";
import type { RouteDefinition } from "../api/router";
import { requireUuid, validationError } from "../api/validation";
import type { CatalogueRepository } from "../catalogue/catalogueRepository";
import type { JobQueue } from "../tasks/jobQueue";
import { JOB_TYPES } from "../tasks/jobHandlers";
import { tilesInSprite } from "./trickplayLayout";
import type { TrickplayService } from "./trickplayService";

export interface TrickplayRoutesOptions {
  trickplay: TrickplayService;
  catalogue: CatalogueRepository;
  queue: JobQueue;
}

function notFound(): OwnApiError {
  return new OwnApiError(
    "TRICKPLAY_NOT_FOUND",
    "No preview images are available for this item.",
    404,
  );
}

export function createTrickplayRoutes({
  trickplay,
  catalogue,
  queue,
}: TrickplayRoutesOptions): RouteDefinition[] {
  async function serveSprite(
    context: Parameters<RouteDefinition["handle"]>[0],
    set: Awaited<ReturnType<TrickplayService["findById"]>>,
    rawIndex: string,
  ): Promise<void> {
    if (!set) throw notFound();
    if (!/^\d{1,4}$/.test(rawIndex)) {
      throw validationError("The sprite index is invalid.");
    }

    const spriteIndex = Number(rawIndex);
    if (
      spriteIndex >= set.spriteCount ||
      tilesInSprite(set, spriteIndex) === 0
    ) {
      throw notFound();
    }

    const absolutePath = trickplay.spritePath(set, spriteIndex);
    const stats = await stat(absolutePath).catch(() => null);
    if (!stats?.isFile()) throw notFound();

    // Sheets are immutable once generated, so they can be cached hard.
    context.response.statusCode = 200;
    context.response.setHeader("Content-Type", set.contentType);
    context.response.setHeader("Content-Length", String(stats.size));
    context.response.setHeader("Cache-Control", "private, max-age=604800");
    context.response.setHeader("X-Content-Type-Options", "nosniff");
    context.response.setHeader("ETag", `"${set.id}-${spriteIndex}"`);

    if (context.method === "HEAD") {
      context.response.end();
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(absolutePath);
      context.response.on("close", () => stream.destroy());
      stream.on("error", reject);
      stream.pipe(context.response).on("finish", resolve).on("error", reject);
    });
  }

  return [
    {
      method: "GET",
      path: "/items/:itemId/trickplay",
      access: "authenticated",
      handle: async (context) => {
        const principal = context.requirePrincipal();
        const itemId = requireUuid(context.params.itemId, "itemId");
        if (!(await catalogue.canUserAccessItem(principal.userId, itemId))) {
          throw notFound();
        }

        const set = await trickplay.findForItem(itemId);
        if (!set) throw notFound();

        // The client needs the full geometry to place a tile from a hover
        // position without another round trip.
        sendData(context.response, context.requestId, {
          setId: set.id,
          tileWidth: set.tileWidth,
          tileHeight: set.tileHeight,
          columns: set.columns,
          rows: set.rows,
          intervalMs: set.intervalMs,
          thumbnailCount: set.thumbnailCount,
          spriteCount: set.spriteCount,
          spriteUrlTemplate: `/ownAPI/v1/trickplay/${set.id}/sprites/{index}`,
        });
      },
    },

    {
      /**
       * Per-item sprite access. The seek bar knows an item, not a set, and the
       * set id changes whenever sheets are regenerated — so resolving it here
       * keeps client URLs stable across regeneration.
       */
      method: "GET",
      path: "/items/:itemId/trickplay/sprites/:spriteIndex",
      access: "authenticated",
      skipCsrf: true,
      handle: async (context) => {
        const principal = context.requirePrincipal();
        const itemId = requireUuid(context.params.itemId, "itemId");
        if (!(await catalogue.canUserAccessItem(principal.userId, itemId))) {
          throw notFound();
        }

        const set = await trickplay.findForItem(itemId);
        if (!set) throw notFound();

        await serveSprite(context, set, context.params.spriteIndex ?? "");
      },
    },

    {
      method: "GET",
      path: "/trickplay/:setId/sprites/:spriteIndex",
      access: "authenticated",
      // Requested by an <img>, which cannot send a CSRF header.
      skipCsrf: true,
      handle: async (context) => {
        const principal = context.requirePrincipal();
        const setId = requireUuid(context.params.setId, "setId");
        const set = await trickplay.findById(setId);
        if (!set) throw notFound();

        // Sprites inherit the visibility of the item whose file produced them;
        // holding a set id is not authorization.
        const owningFile = await catalogue.getFileById(set.mediaFileId);
        if (
          !owningFile ||
          !(await catalogue.canUserAccessItem(
            principal.userId,
            owningFile.itemId,
          ))
        ) {
          throw notFound();
        }

        await serveSprite(context, set, context.params.spriteIndex ?? "");
      },
    },

    {
      method: "POST",
      path: "/admin/items/:itemId/trickplay/regenerate",
      access: "admin",
      handle: async (context) => {
        const itemId = requireUuid(context.params.itemId, "itemId");
        const taskId = await queue.enqueue({
          jobType: JOB_TYPES.trickplayGenerate,
          payload: { itemId, force: true },
          dedupeKey: `${JOB_TYPES.trickplayGenerate}:${itemId}`,
          priority: 400,
        });
        sendAccepted(context.response, context.requestId, taskId);
      },
    },
  ];
}
