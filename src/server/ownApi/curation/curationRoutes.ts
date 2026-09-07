import { sendData, sendNoContent } from "../api/envelope";
import type { RouteContext, RouteDefinition } from "../api/router";
import {
  asObjectBody,
  isUuid,
  parseEnum,
  parseOptionalUuid,
  validationError,
} from "../api/validation";
import type { CatalogueRepository } from "../catalogue/catalogueRepository";
import {
  CURATED_SURFACES,
  LIBRARY_SCOPED_SURFACE,
  type CuratedEntry,
  type CuratedListKey,
  type CurationRepository,
} from "./curationRepository";

export interface CurationRoutesOptions {
  curation: CurationRepository;
  catalogue: CatalogueRepository;
}

/**
 * An ordering is never larger than the shelf it orders, and no shelf is a
 * hundred thousand titles. The cap is here so a malformed client cannot ask the
 * server to hold an unbounded array in memory before the first validation runs.
 */
const MAX_ENTRIES = 5_000;

/**
 * Reads the list identity from the path and, for a library order, from the
 * caller-supplied library id.
 *
 * Both halves are validated here rather than at each call site: the surface
 * against the closed set, the library id for shape, and the two against each
 * other, so a `home-hero` carrying a library id is rejected rather than
 * quietly stored as a list nothing reads.
 */
function readListKey(
  surfaceParam: string | undefined,
  libraryId: string | undefined,
): CuratedListKey {
  if (!surfaceParam) {
    throw validationError("The surface is invalid.");
  }

  // No fallback: an unrecognised surface is a mistake to report, never a
  // default shelf to write into.
  const surface = parseEnum(
    surfaceParam,
    CURATED_SURFACES,
    CURATED_SURFACES[0],
    "surface",
  );

  if (surface === LIBRARY_SCOPED_SURFACE) {
    if (!libraryId) {
      throw validationError("libraryId is required for a library order.");
    }
    return { surface, libraryId };
  }

  if (libraryId) {
    throw validationError("libraryId applies only to a library order.");
  }

  return { surface };
}

function readEntries(body: Record<string, unknown>): CuratedEntry[] {
  const value = body.entries;

  if (!Array.isArray(value) || value.length > MAX_ENTRIES) {
    throw validationError("entries is invalid.");
  }

  const seen = new Set<string>();

  return value.map((candidate) => {
    const entry = asObjectBody(
      candidate,
      ["itemId", "hidden"],
      "entries is invalid.",
    );
    const itemId = entry.itemId;

    if (!isUuid(itemId)) {
      throw validationError("entries is invalid.");
    }
    if (entry.hidden !== undefined && typeof entry.hidden !== "boolean") {
      throw validationError("entries is invalid.");
    }

    const hidden = entry.hidden === true;

    // A repeated id would give one title two positions; the unique index would
    // reject it anyway, but a 422 explains it and a constraint violation does
    // not.
    if (seen.has(itemId.toLowerCase())) {
      throw validationError("entries contains a duplicate itemId.");
    }
    seen.add(itemId.toLowerCase());

    return { itemId: itemId.toLowerCase(), hidden };
  });
}

export function createCurationRoutes({
  curation,
  catalogue,
}: CurationRoutesOptions): RouteDefinition[] {
  async function requireWritableKey(
    context: RouteContext,
    libraryId: string | undefined,
  ): Promise<CuratedListKey> {
    const key = readListKey(context.params.surface, libraryId);

    if (key.libraryId && !(await curation.libraryExists(key.libraryId))) {
      throw validationError("libraryId is invalid.");
    }

    return key;
  }

  return [
    {
      method: "GET",
      path: "/curation/:surface",
      access: "authenticated",
      handle: async (context) => {
        const principal = context.requirePrincipal();
        const key = readListKey(
          context.params.surface,
          parseOptionalUuid(
            context.url.searchParams.get("libraryId"),
            "libraryId",
          ),
        );

        /*
         * A library the caller cannot see reads as an empty ordering rather
         * than a 403: the answer for "no order saved" and "not yours to see"
         * has to be the same, or the endpoint becomes a way to enumerate the
         * libraries somebody else was granted.
         */
        if (
          key.libraryId &&
          !(await catalogue.getLibrary(principal.userId, key.libraryId))
        ) {
          sendData(context.response, context.requestId, {
            surface: key.surface,
            libraryId: key.libraryId,
            updatedAt: null,
            entries: [],
          });
          return;
        }

        const list = await curation.get(key);
        const visibleIds = await curation.filterVisibleItemIds(
          principal.userId,
          list.entries.map((entry) => entry.itemId),
        );

        sendData(context.response, context.requestId, {
          surface: list.surface,
          libraryId: list.libraryId ?? null,
          updatedAt: list.updatedAt ? list.updatedAt.toISOString() : null,
          entries: list.entries.filter((entry) => visibleIds.has(entry.itemId)),
        });
      },
    },
    {
      method: "PUT",
      path: "/admin/curation/:surface",
      access: "admin",
      handle: async (context) => {
        const principal = context.requirePrincipal();
        const body = asObjectBody(await context.readJson(512 * 1_024), [
          "libraryId",
          "entries",
        ]);
        const rawLibraryId = body.libraryId;

        if (rawLibraryId !== undefined && !isUuid(rawLibraryId)) {
          throw validationError("libraryId is invalid.");
        }

        const key = await requireWritableKey(
          context,
          rawLibraryId === undefined
            ? undefined
            : (rawLibraryId as string).toLowerCase(),
        );
        const entries = readEntries(body);

        /*
         * An id that names nothing is refused rather than dropped. Silently
         * discarding it would hand back a shorter list than the operator saved
         * and give no clue which title went missing.
         */
        const existing = await curation.filterExistingItemIds(
          entries.map((entry) => entry.itemId),
        );
        if (entries.some((entry) => !existing.has(entry.itemId))) {
          throw validationError("entries names an item that does not exist.");
        }

        await curation.replace(key, entries, principal.userId);

        sendData(context.response, context.requestId, {
          surface: key.surface,
          libraryId: key.libraryId ?? null,
          entryCount: entries.length,
        });
      },
    },
    {
      method: "DELETE",
      path: "/admin/curation/:surface",
      access: "admin",
      handle: async (context) => {
        const key = await requireWritableKey(
          context,
          parseOptionalUuid(
            context.url.searchParams.get("libraryId"),
            "libraryId",
          ),
        );

        // Idempotent: clearing an ordering that was never saved is a success,
        // because the state the caller asked for is the state that results.
        await curation.clear(key);
        sendNoContent(context.response);
      },
    },
  ];
}
