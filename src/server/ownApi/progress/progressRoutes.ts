import { OwnApiError } from "../ownApiHandler";
import { sendData, sendNoContent } from "../api/envelope";
import type { RouteDefinition } from "../api/router";
import {
  asObjectBody,
  optionalBodyInteger,
  requireBodyInteger,
  requireUuid,
} from "../api/validation";
import type { CatalogueRepository } from "../catalogue/catalogueRepository";
import type { UserStateRepository } from "./userStateRepository";
import { toUserStateDto } from "../catalogue/itemDto";

export interface ProgressRoutesOptions {
  userState: UserStateRepository;
  catalogue: CatalogueRepository;
}

function notFound(): OwnApiError {
  return new OwnApiError(
    "ITEM_NOT_FOUND",
    "The requested item could not be found.",
    404,
  );
}

export function createProgressRoutes({
  userState,
  catalogue,
}: ProgressRoutesOptions): RouteDefinition[] {
  /**
   * Every state mutation re-checks item visibility. Possession of an item id is
   * not authorization, and a progress write is the cheapest way to probe for
   * the existence of content in a library the caller cannot see.
   */
  async function requireAccess(userId: string, itemId: string): Promise<void> {
    if (!(await catalogue.canUserAccessItem(userId, itemId))) {
      throw notFound();
    }
  }

  return [
    {
      method: "PUT",
      path: "/progress/:itemId",
      access: "authenticated",
      handle: async (context) => {
        const principal = context.requirePrincipal();
        const itemId = requireUuid(context.params.itemId, "itemId");
        await requireAccess(principal.userId, itemId);

        const body = asObjectBody(await context.readJson(4 * 1_024), [
          "positionMs",
          "sequence",
          "audioStreamIndex",
          "subtitleStreamIndex",
        ]);

        const accepted = await userState.updateProgress({
          userId: principal.userId,
          itemId,
          positionMs: requireBodyInteger(body, "positionMs", {
            min: 0,
            max: 100 * 60 * 60 * 1_000,
          }),
          sequence: requireBodyInteger(body, "sequence", {
            min: 1,
            max: Number.MAX_SAFE_INTEGER,
          }),
          audioStreamIndex:
            optionalBodyInteger(body, "audioStreamIndex", {
              min: 0,
              max: 100_000,
            }) ?? null,
          subtitleStreamIndex:
            optionalBodyInteger(body, "subtitleStreamIndex", {
              min: 0,
              max: 100_000,
            }) ?? null,
        });

        if (!accepted) {
          // The client's write lost to a newer one. This is expected during
          // normal playback, so it is reported rather than treated as an error
          // the UI must surface.
          throw new OwnApiError(
            "PROGRESS_STALE",
            "A newer playback position has already been recorded.",
            409,
          );
        }

        const state = await userState.get(principal.userId, itemId);
        const item = await catalogue.getItem(principal.userId, itemId);
        sendData(
          context.response,
          context.requestId,
          toUserStateDto(
            state ?? undefined,
            item?.runtimeMs === null || item?.runtimeMs === undefined
              ? undefined
              : Number(item.runtimeMs),
          ) ?? null,
        );
      },
    },

    {
      method: "POST",
      path: "/items/:itemId/played",
      access: "authenticated",
      handle: async (context) => {
        const principal = context.requirePrincipal();
        const itemId = requireUuid(context.params.itemId, "itemId");
        await requireAccess(principal.userId, itemId);
        await userState.setPlayed(principal.userId, itemId, true);
        sendNoContent(context.response);
      },
    },
    {
      method: "DELETE",
      path: "/items/:itemId/played",
      access: "authenticated",
      handle: async (context) => {
        const principal = context.requirePrincipal();
        const itemId = requireUuid(context.params.itemId, "itemId");
        await requireAccess(principal.userId, itemId);
        await userState.setPlayed(principal.userId, itemId, false);
        sendNoContent(context.response);
      },
    },

    {
      method: "POST",
      path: "/favourites/:itemId",
      access: "authenticated",
      handle: async (context) => {
        const principal = context.requirePrincipal();
        const itemId = requireUuid(context.params.itemId, "itemId");
        await requireAccess(principal.userId, itemId);
        await userState.setFavourite(principal.userId, itemId, true);
        sendNoContent(context.response);
      },
    },
    {
      method: "DELETE",
      path: "/favourites/:itemId",
      access: "authenticated",
      handle: async (context) => {
        const principal = context.requirePrincipal();
        const itemId = requireUuid(context.params.itemId, "itemId");
        await requireAccess(principal.userId, itemId);
        await userState.setFavourite(principal.userId, itemId, false);
        sendNoContent(context.response);
      },
    },

    // Seyirlik's own bulk watched behaviour: resetting a series clears progress
    // for every episode beneath it, and marking one marks them all. Preserved
    // from the existing product behaviour rather than left to the client to
    // emulate with N requests.
    {
      method: "POST",
      path: "/items/:itemId/watched/reset",
      access: "authenticated",
      handle: async (context) => {
        const principal = context.requirePrincipal();
        const itemId = requireUuid(context.params.itemId, "itemId");
        await requireAccess(principal.userId, itemId);
        const affected = await userState.resetWatchedRecursively(
          principal.userId,
          itemId,
        );
        sendData(context.response, context.requestId, { affected });
      },
    },
    {
      method: "POST",
      path: "/items/:itemId/watched/mark",
      access: "authenticated",
      handle: async (context) => {
        const principal = context.requirePrincipal();
        const itemId = requireUuid(context.params.itemId, "itemId");
        await requireAccess(principal.userId, itemId);
        const affected = await userState.markWatchedRecursively(
          principal.userId,
          itemId,
        );
        sendData(context.response, context.requestId, { affected });
      },
    },
  ];
}
