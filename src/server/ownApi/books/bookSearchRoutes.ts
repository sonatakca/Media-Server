import path from "node:path";

import { sendData } from "../api/envelope";
import type { RouteDefinition } from "../api/router";
import {
  asObjectBody,
  optionalBodyString,
  requireUuid,
} from "../api/validation";
import type {
  CatalogueRepository,
  MediaFileRow,
} from "../catalogue/catalogueRepository";
import { resolveBookFile } from "./bookRoutes";
import type { BookSearch, BookToSearch } from "./bookSearch";

export interface BookSearchRoutesOptions {
  search: BookSearch;
  catalogue: CatalogueRepository;
  mediaRoot: string;
}

/**
 * A book as the search knows it. The key changes whenever the file does, so
 * the route and the library sweep must build it the same way: here.
 */
export function bookToSearch(
  itemId: string,
  file: Pick<MediaFileRow, "id" | "fingerprint">,
  filePath: string,
): BookToSearch {
  return { itemId, filePath, sourceKey: `${file.id}:${file.fingerprint}` };
}

/** Long enough to describe a scene; a question, not a chapter. */
const MAX_QUERY_LENGTH = 300;

export function createBookSearchRoutes({
  search,
  catalogue,
  mediaRoot,
}: BookSearchRoutesOptions): RouteDefinition[] {
  const resolvedMediaRoot = path.resolve(mediaRoot);

  return [
    {
      /**
       * Passages of a book that mean what the query says. A POST because the
       * first search of a book starts preparing it; an empty query only does
       * that. The reply is `ready` with hits, `preparing` (ask again), or
       * `unavailable` with the reason.
       */
      method: "POST",
      path: "/books/:itemId/search",
      access: "authenticated",
      handle: async (context) => {
        const principal = context.requirePrincipal();
        const itemId = requireUuid(context.params.itemId, "itemId");
        const body = asObjectBody(await context.readJson(4 * 1_024), ["query"]);
        const query = (
          optionalBodyString(body, "query", { maxLength: MAX_QUERY_LENGTH }) ??
          ""
        ).trim();

        const { file, absolutePath } = await resolveBookFile(
          catalogue,
          resolvedMediaRoot,
          principal.userId,
          itemId,
        );
        sendData(
          context.response,
          context.requestId,
          await search.search(bookToSearch(itemId, file, absolutePath), query),
        );
      },
    },
  ];
}
