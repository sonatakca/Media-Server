import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { OWN_API_V1_BASE_PATH, OwnApiError } from "../ownApiHandler";
import type { RouteDefinition } from "../api/router";
import { requireUuid } from "../api/validation";
import { sendData } from "../api/envelope";
import type { ShareCards } from "./shareCards";

function notFound(): OwnApiError {
  return new OwnApiError(
    "ITEM_NOT_FOUND",
    "The requested item could not be found.",
    404,
  );
}

/** Where the card is served, carrying its version so a new card is a new URL. */
export function shareImagePath(itemId: string, version: string): string {
  return `${OWN_API_V1_BASE_PATH}/share/items/${itemId}/image?v=${version}`;
}

/**
 * What a link preview reads: the only routes a caller with no session can
 * reach in the catalogue.
 *
 * They are public because the readers are WhatsApp's, iMessage's and
 * Telegram's crawlers, which carry no cookie. They answer only for a title's
 * id — a random UUID that exists in a link only because someone who could see
 * the title shared it — and only with what the preview shows: a name, an
 * overview, and the card the site already draws for it.
 */
export function createShareRoutes(cards: ShareCards): RouteDefinition[] {
  return [
    {
      method: "GET",
      path: "/share/items/:itemId",
      access: "public",
      handle: async (context) => {
        const itemId = requireUuid(context.params.itemId, "itemId");
        const card = await cards.describe(itemId);
        if (!card) throw notFound();
        sendData(context.response, context.requestId, {
          kind: card.kind,
          title: card.title,
          description: card.description,
          image: card.image
            ? {
                path: shareImagePath(itemId, card.image.version),
                width: card.image.width,
                height: card.image.height,
                type: "image/jpeg",
              }
            : null,
        });
      },
    },

    {
      method: "GET",
      path: "/share/items/:itemId/image",
      access: "public",
      handle: async (context) => {
        const itemId = requireUuid(context.params.itemId, "itemId");
        const card = await cards.image(itemId);
        if (!card) throw notFound();
        const stats = await stat(card.path).catch(() => null);
        if (!stats?.isFile()) throw notFound();

        const { response } = context;
        const etag = `"${card.version}"`;
        response.setHeader("Content-Type", "image/jpeg");
        response.setHeader("X-Content-Type-Options", "nosniff");
        response.setHeader("ETag", etag);
        // A URL naming the current version never changes meaning, so it may
        // be kept forever; one naming an older card is answered with the
        // current one, briefly, so a preview cached before an adjustment
        // still shows a picture and soon shows the right one.
        response.setHeader(
          "Cache-Control",
          context.url.searchParams.get("v") === card.version
            ? "public, max-age=31536000, immutable"
            : "public, max-age=300",
        );
        if (context.request.headers["if-none-match"] === etag) {
          response.statusCode = 304;
          response.end();
          return;
        }
        response.statusCode = 200;
        response.setHeader("Content-Length", String(stats.size));
        if (context.method === "HEAD") {
          response.end();
          return;
        }
        await new Promise<void>((resolve, reject) => {
          const stream = createReadStream(card.path);
          response.on("close", () => stream.destroy());
          stream.on("error", reject);
          stream.pipe(response).on("finish", resolve).on("error", reject);
        });
      },
    },
  ];
}
