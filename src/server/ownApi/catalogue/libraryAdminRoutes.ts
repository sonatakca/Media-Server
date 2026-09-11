import type { RouteDefinition } from "../api/router";
import { sendData } from "../api/envelope";
import {
  asObjectBody,
  requireBodyString,
  requireUuid,
  validationError,
} from "../api/validation";
import type { TmdbClient } from "../metadata/tmdbClient";
import { OwnApiError } from "../ownApiHandler";
import { loadTitleDetail, type LibraryAdminRepository } from "./libraryAdmin";
import { TitleRemovalError, type TitleRemoval } from "./titleRemoval";

const REMOVAL_STATUS: Record<TitleRemovalError["code"], number> = {
  "not-found": 404,
  confirmation: 400,
  busy: 409,
  unsafe: 409,
};

/** Administrator-only: every title, including the ones with nothing to play. */
export function createLibraryAdminRoutes(options: {
  repository: LibraryAdminRepository;
  tmdb: TmdbClient | undefined;
  removal: TitleRemoval;
}): RouteDefinition[] {
  return [
    {
      method: "GET",
      path: "/library/titles",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        const kind = context.url.searchParams.get("kind") ?? "movie";
        if (kind !== "movie" && kind !== "series")
          throw validationError("Choose movies or shows.");
        sendData(context.response, context.requestId, {
          items: await options.repository.listTitles(kind),
        });
      },
    },
    {
      method: "GET",
      path: "/library/titles/:itemId",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        const detail = await loadTitleDetail(
          options.repository,
          options.tmdb,
          requireUuid(context.params.itemId, "itemId"),
        );
        if (!detail)
          throw new OwnApiError("NOT_FOUND", "No such movie or show.", 404);
        sendData(context.response, context.requestId, detail);
      },
    },
    {
      /**
       * Irreversible. The body must repeat the title, so a request cannot be
       * produced by a stray click or a replayed id alone.
       */
      method: "POST",
      path: "/library/titles/:itemId/remove",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        const itemId = requireUuid(context.params.itemId, "itemId");
        const body = asObjectBody(await context.readJson(), ["confirmTitle"]);
        const confirmTitle = requireBodyString(body, "confirmTitle", {
          maxLength: 500,
        });
        try {
          sendData(
            context.response,
            context.requestId,
            await options.removal.remove(itemId, confirmTitle),
          );
        } catch (error) {
          if (error instanceof TitleRemovalError)
            throw new OwnApiError(
              `REMOVAL_${error.code.toUpperCase().replace("-", "_")}`,
              error.message,
              REMOVAL_STATUS[error.code],
            );
          throw error;
        }
      },
    },
  ];
}
