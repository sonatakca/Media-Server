import path from "node:path";
import { OwnApiError } from "../ownApiHandler";
import type { RouteDefinition } from "../api/router";
import { requireUuid } from "../api/validation";
import { serveFile } from "../api/fileDelivery";
import { isPathInsideRoot } from "../../pathSecurity";
import type { CatalogueRepository } from "../catalogue/catalogueRepository";

export interface BookRoutesOptions {
  catalogue: CatalogueRepository;
  mediaRoot: string;
}

export function createBookRoutes({
  catalogue,
  mediaRoot,
}: BookRoutesOptions): RouteDefinition[] {
  const resolvedMediaRoot = path.resolve(mediaRoot);

  return [
    {
      /**
       * The file behind a book.
       *
       * A book has no playback session — there is nothing to plan, transcode or
       * seek — so the reader was asking the playback route for one and getting
       * a 404 for a session that could never exist. It reads the file directly
       * instead, authorized the same way everything else is: by whether the
       * caller can see the library it belongs to.
       */
      method: "GET",
      path: "/items/:itemId/file",
      access: "authenticated",
      // Fetched by the reader and by an <object> element, neither of which can
      // attach a CSRF header. Safe: the method is read-only and the session
      // cookie still authorizes it.
      skipCsrf: true,
      handle: async (context) => {
        const principal = context.requirePrincipal();
        const itemId = requireUuid(context.params.itemId, "itemId");

        const notFound = () =>
          new OwnApiError(
            "ITEM_NOT_FOUND",
            "The requested item could not be found.",
            404,
          );

        const item = await catalogue.getItem(principal.userId, itemId);
        if (!item) throw notFound();

        // Only books. Everything else is delivered through a playback session,
        // which is where the decisions about container and codec are made; a
        // second way in would bypass all of them.
        if (item.kind !== "book") {
          throw new OwnApiError(
            "NOT_A_BOOK",
            "Only a book is read directly; everything else is played.",
            422,
          );
        }

        // Visibility was already established by getItem above, so the file
        // lookup is by item alone.
        const file = await catalogue.getPrimaryFile(itemId);
        if (!file || file.missingSince !== null) throw notFound();

        const absolutePath = path.resolve(
          resolvedMediaRoot,
          ...file.relativePath.split("/"),
        );
        if (!isPathInsideRoot(resolvedMediaRoot, absolutePath)) {
          throw notFound();
        }

        await serveFile(
          context.response,
          absolutePath,
          context.request.headers.range as string | undefined,
          context.method === "HEAD",
          // A book's bytes never change under the same id, but it is behind a
          // session, so it is private rather than shared.
          "private, max-age=3600",
        );
      },
    },
  ];
}
