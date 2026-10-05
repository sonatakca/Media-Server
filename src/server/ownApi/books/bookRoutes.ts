import path from "node:path";
import { OwnApiError } from "../ownApiHandler";
import type { RouteDefinition } from "../api/router";
import { requireUuid } from "../api/validation";
import { serveFile } from "../api/fileDelivery";
import { readBinaryBody } from "../api/http";
import { sendData } from "../api/envelope";
import { isPathInsideRoot } from "../../pathSecurity";
import type { CatalogueRepository } from "../catalogue/catalogueRepository";
import {
  BookRejectedError,
  MAX_BOOK_UPLOAD_BYTES,
  type BookUploader,
} from "./bookUpload";

export interface BookRoutesOptions {
  catalogue: CatalogueRepository;
  mediaRoot: string;
  /** Absent when no Books library is configured. */
  uploads?: {
    uploader: BookUploader;
    /** Reads the Books library again so a new file becomes a title. */
    scan(): Promise<void>;
  };
}

export function createBookRoutes({
  catalogue,
  mediaRoot,
  uploads,
}: BookRoutesOptions): RouteDefinition[] {
  const resolvedMediaRoot = path.resolve(mediaRoot);

  const uploadRoutes: RouteDefinition[] = uploads
    ? [
        {
          /**
           * An EPUB from the caller's own computer, filed in the Books library.
           *
           * The bytes are the body; the file's original name comes in the query
           * and is only a fallback title for a book that does not name itself.
           * It is never a path.
           */
          method: "POST",
          path: "/library/books/upload",
          access: "admin",
          handle: async (context) => {
            context.requirePrincipal();
            const fileName = (context.url.searchParams.get("name") ?? "")
              .split(/[\\/]/)
              .pop()!
              .slice(0, 255);
            let bytes: Buffer;
            try {
              bytes = await readBinaryBody(
                context.request,
                MAX_BOOK_UPLOAD_BYTES,
              );
            } catch (error) {
              // The shared reader words its refusals for images.
              if (error instanceof OwnApiError && error.statusCode === 413)
                throw new OwnApiError(
                  "BOOK_TOO_LARGE",
                  "The book is larger than the 95 MB an upload can carry.",
                  413,
                );
              if (error instanceof OwnApiError)
                throw new OwnApiError(
                  "BOOK_UPLOAD_INTERRUPTED",
                  "The book did not arrive whole. Try it again.",
                  error.statusCode,
                );
              throw error;
            }
            let result;
            try {
              result = await uploads.uploader.upload(bytes, fileName);
            } catch (error) {
              if (error instanceof BookRejectedError)
                throw new OwnApiError("BOOK_REJECTED", error.message, 422);
              throw error;
            }
            await uploads.scan();
            sendData(context.response, context.requestId, result);
          },
        },
      ]
    : [];

  return [
    ...uploadRoutes,
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
