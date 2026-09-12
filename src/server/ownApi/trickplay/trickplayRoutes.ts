import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { OwnApiError } from "../ownApiHandler";
import { sendData } from "../api/envelope";
import type { RouteDefinition } from "../api/router";
import { asObjectBody, requireUuid, validationError } from "../api/validation";
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

    /*
     * The server resolves the file; the client never sees a path. A sprite URL
     * carries a set id and an index and nothing else, so there is no filesystem
     * location in it for anyone to walk out of.
     */
    const absolutePath = await trickplay.spritePath(set, spriteIndex);
    if (!absolutePath) throw notFound();
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
      /**
       * Trickplay for one title: a film, an episode, a season or a whole show.
       *
       * A season or a show fans out to its episodes, one job each, keyed per
       * title exactly as the library-wide pass keys them, so pressing this
       * while that pass is running collapses onto the same attempts instead of
       * decoding a file twice. Without `force` an episode that already has
       * sheets is left alone; with it the sheets are rebuilt, and the service
       * swaps the new set in only once it has been validated.
       */
      method: "POST",
      path: "/admin/items/:itemId/trickplay",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        const itemId = requireUuid(context.params.itemId, "itemId");
        const body = asObjectBody((await context.readJson()) ?? {}, ["force"]);
        if (body.force !== undefined && typeof body.force !== "boolean")
          throw validationError("Choose whether to rebuild existing sheets.");
        const force = body.force === true;
        const kind = await catalogue.getItemKind(itemId);
        if (!kind) throw notFound();
        const titles =
          kind === "movie" || kind === "episode"
            ? (await catalogue.listProcessableTitles({ kinds: [kind] })).filter(
                (title) => title.itemId === itemId,
              )
            : kind === "series"
              ? await catalogue.listProcessableTitles({
                  kinds: ["episode"],
                  seriesId: itemId,
                })
              : kind === "season"
                ? await catalogue.listProcessableTitles({
                    kinds: ["episode"],
                    seasonId: itemId,
                  })
                : [];
        // The same eligibility the library-wide pass uses: a probed file that is there.
        const ready = titles.filter(
          (title) =>
            title.mediaFileId !== null &&
            title.fileMissingSince === null &&
            title.itemMissingSince === null &&
            title.probeState === "probed" &&
            title.durationMs !== null &&
            (title.width ?? 0) > 0,
        );
        const generated = force
          ? new Set<string>()
          : await trickplay.listGeneratedMediaFileIds(
              ready.map((title) => title.mediaFileId as string),
            );
        let queued = 0;
        for (const title of ready) {
          if (generated.has(title.mediaFileId as string)) continue;
          await queue.enqueue({
            jobType: JOB_TYPES.trickplayGenerate,
            payload: {
              itemId: title.itemId,
              ...(force ? { force: true } : {}),
            },
            dedupeKey: `${JOB_TYPES.trickplayGenerate}:${title.itemId}`,
            priority: 400,
          });
          queued += 1;
        }
        sendData(context.response, context.requestId, {
          queued,
          alreadyGenerated: generated.size,
          notReady: titles.length - ready.length,
        });
      },
    },
  ];
}
