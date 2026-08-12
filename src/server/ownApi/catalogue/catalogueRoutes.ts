import { OwnApiError } from "../ownApiHandler";
import {
  buildPagination,
  decodeCursor,
  sendCollection,
  sendData,
  type Pagination,
} from "../api/envelope";
import type { RouteContext, RouteDefinition } from "../api/router";
import {
  parseEnum,
  parseLimit,
  parseOptionalUuid,
  parseSearchQuery,
  requireUuid,
} from "../api/validation";
import type { CatalogueRepository, ItemKind } from "./catalogueRepository";
import type { CatalogueService } from "./catalogueService";
import type { ItemDto } from "./itemDto";

export interface CatalogueRoutesOptions {
  service: CatalogueService;
  catalogue: CatalogueRepository;
}

const SORT_VALUES = [
  "title",
  "dateCreated",
  "premiereDate",
  "communityRating",
  "index",
] as const;
const ORDER_VALUES = ["asc", "desc"] as const;

function notFound(): OwnApiError {
  // Absent and forbidden are deliberately indistinguishable: an item id must not
  // become an oracle for what exists in a library the caller cannot see.
  return new OwnApiError(
    "ITEM_NOT_FOUND",
    "The requested item could not be found.",
    404,
  );
}

function readListQuery(context: RouteContext) {
  const { url } = context;
  return {
    limit: parseLimit(url.searchParams.get("limit")),
    cursor: decodeCursor(url.searchParams.get("cursor")),
    sort: parseEnum(url.searchParams.get("sort"), SORT_VALUES, "title", "sort"),
    order: parseEnum(
      url.searchParams.get("order"),
      ORDER_VALUES,
      "asc",
      "order",
    ),
    genre: url.searchParams.get("genre") ?? undefined,
    libraryId: parseOptionalUuid(
      url.searchParams.get("libraryId"),
      "libraryId",
    ),
  };
}

function paginationFor(
  items: ItemDto[],
  limit: number,
  nextCursorKey: string | null,
  nextCursorId: string | null,
): Pagination {
  return buildPagination(
    limit,
    nextCursorId ? [{ cursorKey: nextCursorKey ?? "", id: nextCursorId }] : [],
    nextCursorId !== null,
  );
}

export function createCatalogueRoutes({
  service,
  catalogue,
}: CatalogueRoutesOptions): RouteDefinition[] {
  async function listByKinds(
    context: RouteContext,
    kinds: ItemKind[],
    overrides: {
      libraryId?: string;
      seriesId?: string;
      parentId?: string;
    } = {},
  ): Promise<void> {
    const principal = context.requirePrincipal();
    const query = readListQuery(context);

    const page = await service.listItems({
      userId: principal.userId,
      kinds,
      limit: query.limit,
      cursor: query.cursor,
      sort: query.sort,
      order: query.order,
      ...(query.genre ? { genre: query.genre } : {}),
      ...((overrides.libraryId ?? query.libraryId)
        ? { libraryId: overrides.libraryId ?? (query.libraryId as string) }
        : {}),
      ...(overrides.seriesId ? { seriesId: overrides.seriesId } : {}),
      ...(overrides.parentId ? { parentId: overrides.parentId } : {}),
    });

    sendCollection(
      context.response,
      context.requestId,
      page.items,
      paginationFor(
        page.items,
        query.limit,
        page.nextCursorKey,
        page.nextCursorId,
      ),
    );
  }

  async function requireVisibleItem(
    context: RouteContext,
    itemId: string,
  ): Promise<ItemDto> {
    const principal = context.requirePrincipal();
    const item = await service.getItem(principal.userId, itemId);
    if (!item) throw notFound();
    return item;
  }

  return [
    {
      method: "GET",
      path: "/libraries",
      access: "authenticated",
      handle: async (context) => {
        const principal = context.requirePrincipal();
        const libraries = await service.listLibraries(principal.userId);
        sendData(context.response, context.requestId, libraries);
      },
    },
    {
      method: "GET",
      path: "/libraries/:libraryId",
      access: "authenticated",
      handle: async (context) => {
        const principal = context.requirePrincipal();
        const libraryId = requireUuid(context.params.libraryId, "libraryId");
        const library = await catalogue.getLibrary(principal.userId, libraryId);
        if (!library) throw notFound();
        sendData(context.response, context.requestId, library);
      },
    },
    {
      method: "GET",
      path: "/libraries/:libraryId/items",
      access: "authenticated",
      handle: async (context) => {
        const principal = context.requirePrincipal();
        const libraryId = requireUuid(context.params.libraryId, "libraryId");
        const library = await catalogue.getLibrary(principal.userId, libraryId);
        if (!library) throw notFound();

        await listByKinds(context, ["movie", "series", "book", "collection"], {
          libraryId,
        });
      },
    },

    {
      method: "GET",
      path: "/movies",
      access: "authenticated",
      handle: (context) => listByKinds(context, ["movie"]),
    },
    {
      method: "GET",
      path: "/series",
      access: "authenticated",
      handle: (context) => listByKinds(context, ["series"]),
    },
    {
      method: "GET",
      path: "/books",
      access: "authenticated",
      handle: (context) => listByKinds(context, ["book"]),
    },
    {
      method: "GET",
      path: "/collections",
      access: "authenticated",
      handle: (context) => listByKinds(context, ["collection"]),
    },

    {
      method: "GET",
      path: "/items/:itemId",
      access: "authenticated",
      handle: async (context) => {
        const item = await requireVisibleItem(
          context,
          requireUuid(context.params.itemId, "itemId"),
        );
        sendData(context.response, context.requestId, item);
      },
    },
    {
      /**
       * Children of any item, whatever its kind.
       *
       * A detail page asks for the children of whatever it is showing without
       * knowing in advance whether that is a collection, a season or a single
       * film. A leaf simply has none, which is an empty list rather than an
       * error — the alternative is every caller having to special-case kind.
       */
      method: "GET",
      path: "/items/:itemId/children",
      access: "authenticated",
      handle: async (context) => {
        const principal = context.requirePrincipal();
        const itemId = requireUuid(context.params.itemId, "itemId");
        if (!(await catalogue.canUserAccessItem(principal.userId, itemId))) {
          throw notFound();
        }

        await listByKinds(context, [], { parentId: itemId });
      },
    },

    {
      method: "GET",
      path: "/items/:itemId/streams",
      access: "authenticated",
      handle: async (context) => {
        const principal = context.requirePrincipal();
        const itemId = requireUuid(context.params.itemId, "itemId");
        if (!(await catalogue.canUserAccessItem(principal.userId, itemId))) {
          throw notFound();
        }

        const files = await catalogue.listFilesForItem(itemId);
        const sources = await Promise.all(
          files
            .filter((file) => file.missingSince === null)
            .map(async (file) => ({
              id: file.id,
              container: file.container,
              sizeBytes: Number(file.sizeBytes),
              durationMs:
                file.durationMs === null ? null : Number(file.durationMs),
              bitrateBps:
                file.bitrateBps === null ? null : Number(file.bitrateBps),
              isPrimary: file.isPrimary,
              probeState: file.probeState,
              // The relative path is deliberately absent: a client never needs
              // it, and exposing it would leak the library layout.
              streams: (await catalogue.listStreams(file.id)).map((stream) => ({
                index: stream.streamIndex,
                kind: stream.kind,
                codec: stream.codec,
                profile: stream.profile,
                level: stream.level,
                language: stream.language,
                title: stream.title,
                isDefault: stream.isDefault,
                isForced: stream.isForced,
                isExternal: stream.isExternal,
                isTextSubtitle: stream.isTextSubtitle,
                channels: stream.channels,
                sampleRate: stream.sampleRate,
                bitrateBps:
                  stream.bitrateBps === null ? null : Number(stream.bitrateBps),
                width: stream.width,
                height: stream.height,
                frameRate: stream.frameRate,
                videoRange: stream.videoRange,
                bitDepth: stream.bitDepth,
              })),
            })),
        );

        sendData(context.response, context.requestId, { sources });
      },
    },
    {
      method: "GET",
      path: "/items/:itemId/chapters",
      access: "authenticated",
      handle: async (context) => {
        const principal = context.requirePrincipal();
        const itemId = requireUuid(context.params.itemId, "itemId");
        if (!(await catalogue.canUserAccessItem(principal.userId, itemId))) {
          throw notFound();
        }

        const chapters = await catalogue.listChapters(itemId);
        sendData(
          context.response,
          context.requestId,
          chapters.map((chapter) => ({
            index: chapter.index,
            startMs: Number(chapter.startMs),
            name: chapter.name,
          })),
        );
      },
    },
    {
      method: "GET",
      path: "/items/:itemId/segments",
      access: "authenticated",
      handle: async (context) => {
        const principal = context.requirePrincipal();
        const itemId = requireUuid(context.params.itemId, "itemId");
        if (!(await catalogue.canUserAccessItem(principal.userId, itemId))) {
          throw notFound();
        }

        const segments = await catalogue.listSegments(itemId);
        sendData(
          context.response,
          context.requestId,
          segments.map((segment) => ({
            id: segment.id,
            type: segment.type,
            startMs: Number(segment.startMs),
            endMs: Number(segment.endMs),
          })),
        );
      },
    },
    {
      method: "GET",
      path: "/items/:itemId/trailers",
      access: "authenticated",
      handle: async (context) => {
        const principal = context.requirePrincipal();
        const itemId = requireUuid(context.params.itemId, "itemId");
        if (!(await catalogue.canUserAccessItem(principal.userId, itemId))) {
          throw notFound();
        }
        const trailers = await service.listChildren(
          principal.userId,
          itemId,
          "trailer",
        );
        sendData(context.response, context.requestId, trailers);
      },
    },

    {
      method: "GET",
      path: "/series/:seriesId/seasons",
      access: "authenticated",
      handle: async (context) => {
        const principal = context.requirePrincipal();
        const seriesId = requireUuid(context.params.seriesId, "seriesId");
        if (!(await catalogue.canUserAccessItem(principal.userId, seriesId))) {
          throw notFound();
        }
        const seasons = await service.listChildren(
          principal.userId,
          seriesId,
          "season",
        );
        sendData(context.response, context.requestId, seasons);
      },
    },
    {
      method: "GET",
      path: "/series/:seriesId/episodes",
      access: "authenticated",
      handle: async (context) => {
        const principal = context.requirePrincipal();
        const seriesId = requireUuid(context.params.seriesId, "seriesId");
        if (!(await catalogue.canUserAccessItem(principal.userId, seriesId))) {
          throw notFound();
        }
        const episodes = await service.listSeriesEpisodes(
          principal.userId,
          seriesId,
        );
        sendData(context.response, context.requestId, episodes);
      },
    },
    {
      method: "GET",
      path: "/seasons/:seasonId/episodes",
      access: "authenticated",
      handle: async (context) => {
        const principal = context.requirePrincipal();
        const seasonId = requireUuid(context.params.seasonId, "seasonId");
        if (!(await catalogue.canUserAccessItem(principal.userId, seasonId))) {
          throw notFound();
        }
        const episodes = await service.listChildren(
          principal.userId,
          seasonId,
          "episode",
        );
        sendData(context.response, context.requestId, episodes);
      },
    },
    {
      method: "GET",
      path: "/episodes/:episodeId/next",
      access: "authenticated",
      handle: async (context) => {
        const principal = context.requirePrincipal();
        const episodeId = requireUuid(context.params.episodeId, "episodeId");
        if (!(await catalogue.canUserAccessItem(principal.userId, episodeId))) {
          throw notFound();
        }
        const next = await service.nextEpisode(principal.userId, episodeId);
        sendData(context.response, context.requestId, next);
      },
    },
    {
      method: "GET",
      path: "/series/:seriesId/first-unwatched",
      access: "authenticated",
      handle: async (context) => {
        const principal = context.requirePrincipal();
        const seriesId = requireUuid(context.params.seriesId, "seriesId");
        if (!(await catalogue.canUserAccessItem(principal.userId, seriesId))) {
          throw notFound();
        }
        const episode = await service.firstUnwatchedEpisode(
          principal.userId,
          seriesId,
        );
        sendData(context.response, context.requestId, episode);
      },
    },

    {
      method: "GET",
      path: "/home",
      access: "authenticated",
      handle: async (context) => {
        const principal = context.requirePrincipal();
        const rowSize = parseLimit(
          context.url.searchParams.get("rowSize"),
          50,
          20,
        );
        const home = await service.home(principal.userId, { rowSize });
        sendData(context.response, context.requestId, home);
      },
    },
    {
      method: "GET",
      path: "/home/continue-watching",
      access: "authenticated",
      handle: async (context) => {
        const principal = context.requirePrincipal();
        const limit = parseLimit(context.url.searchParams.get("limit"), 50, 20);
        const items = await service.continueWatching(principal.userId, limit);
        sendCollection(context.response, context.requestId, items, {
          limit,
          nextCursor: null,
          total: items.length,
        });
      },
    },
    {
      method: "GET",
      path: "/home/next-up",
      access: "authenticated",
      handle: async (context) => {
        const principal = context.requirePrincipal();
        const limit = parseLimit(context.url.searchParams.get("limit"), 50, 20);
        const items = await service.nextUp(principal.userId, limit);
        sendCollection(context.response, context.requestId, items, {
          limit,
          nextCursor: null,
          total: items.length,
        });
      },
    },
    {
      method: "GET",
      path: "/home/latest",
      access: "authenticated",
      handle: async (context) => {
        const principal = context.requirePrincipal();
        const limit = parseLimit(context.url.searchParams.get("limit"), 50, 20);
        const libraryId = parseOptionalUuid(
          context.url.searchParams.get("libraryId"),
          "libraryId",
        );
        const items = await service.latest(principal.userId, limit, libraryId);
        sendCollection(context.response, context.requestId, items, {
          limit,
          nextCursor: null,
          total: items.length,
        });
      },
    },

    {
      method: "GET",
      path: "/search",
      access: "authenticated",
      handle: async (context) => {
        const principal = context.requirePrincipal();
        const searchQuery = parseSearchQuery(context.url.searchParams.get("q"));
        const limit = parseLimit(
          context.url.searchParams.get("limit"),
          100,
          40,
        );
        const items = await service.search(
          principal.userId,
          searchQuery,
          limit,
        );
        sendCollection(context.response, context.requestId, items, {
          limit,
          nextCursor: null,
          total: items.length,
        });
      },
    },
    {
      method: "GET",
      path: "/favourites",
      access: "authenticated",
      handle: async (context) => {
        const principal = context.requirePrincipal();
        const limit = parseLimit(
          context.url.searchParams.get("limit"),
          200,
          100,
        );
        const items = await service.favourites(principal.userId, limit);
        sendCollection(context.response, context.requestId, items, {
          limit,
          nextCursor: null,
          total: items.length,
        });
      },
    },
    {
      method: "GET",
      path: "/genres",
      access: "authenticated",
      handle: async (context) => {
        const principal = context.requirePrincipal();
        const libraryId = parseOptionalUuid(
          context.url.searchParams.get("libraryId"),
          "libraryId",
        );
        const genres = await catalogue.listGenres(principal.userId, libraryId);
        sendData(context.response, context.requestId, genres);
      },
    },
  ];
}
