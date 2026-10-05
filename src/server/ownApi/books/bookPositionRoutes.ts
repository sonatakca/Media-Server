import { OwnApiError } from "../ownApiHandler";
import { sendData } from "../api/envelope";
import type { RouteDefinition } from "../api/router";
import {
  asObjectBody,
  optionalBodyString,
  requireBodyInteger,
  requireUuid,
  validationError,
} from "../api/validation";
import type { CatalogueRepository } from "../catalogue/catalogueRepository";
import type {
  BookPlace,
  BookPosition,
  BookPositionRepository,
} from "./bookPositionRepository";

export interface BookPositionRoutesOptions {
  positions: BookPositionRepository;
  catalogue: CatalogueRepository;
}

export interface BookPositionDto {
  cfi: string | null;
  place: BookPlace | null;
  fraction: number;
  /** ISO 8601. */
  readAt: string;
}

function toDto(position: BookPosition | null): BookPositionDto | null {
  return position
    ? {
        cfi: position.cfi,
        place: position.place,
        fraction: position.fraction,
        readAt: position.readAt.toISOString(),
      }
    : null;
}

function readFraction(body: Record<string, unknown>): number {
  const value = body.fraction;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  ) {
    throw validationError("fraction is invalid.");
  }
  return value;
}

function readPlace(body: Record<string, unknown>): BookPlace | null {
  if (body.place === undefined || body.place === null) return null;
  const place = asObjectBody(
    body.place,
    ["section", "block", "offset"],
    "place is invalid.",
  );
  return {
    section: requireBodyInteger(place, "section", { min: 0, max: 100_000 }),
    block: requireBodyInteger(place, "block", { min: 0, max: 10_000_000 }),
    offset: requireBodyInteger(place, "offset", {
      min: -1_000_000,
      max: 1_000_000,
    }),
  };
}

/** The earliest moment a reading position can claim: nothing was read before Seyirlik had books. */
const EARLIEST_READ_AT = Date.UTC(2020, 0, 1);

export function createBookPositionRoutes({
  positions,
  catalogue,
}: BookPositionRoutesOptions): RouteDefinition[] {
  /**
   * Only a book the caller can see has a reading position. An item in a
   * library they cannot see answers exactly like one that does not exist, so
   * the route cannot be used to probe for content.
   */
  async function requireBook(userId: string, itemId: string): Promise<void> {
    const item = await catalogue.getItem(userId, itemId);
    if (!item || item.kind !== "book") {
      throw new OwnApiError(
        "ITEM_NOT_FOUND",
        "The requested item could not be found.",
        404,
      );
    }
  }

  return [
    {
      method: "GET",
      path: "/books/:itemId/position",
      access: "authenticated",
      handle: async (context) => {
        const principal = context.requirePrincipal();
        const itemId = requireUuid(context.params.itemId, "itemId");
        await requireBook(principal.userId, itemId);
        sendData(
          context.response,
          context.requestId,
          toDto(await positions.get(principal.userId, itemId)),
        );
      },
    },
    {
      method: "PUT",
      path: "/books/:itemId/position",
      access: "authenticated",
      handle: async (context) => {
        const principal = context.requirePrincipal();
        const itemId = requireUuid(context.params.itemId, "itemId");
        await requireBook(principal.userId, itemId);

        const body = asObjectBody(await context.readJson(8 * 1_024), [
          "cfi",
          "place",
          "fraction",
          "readAt",
        ]);
        const cfi = optionalBodyString(body, "cfi", { maxLength: 2_048 });
        if (cfi !== undefined && !/^epubcfi\(.+\)$/.test(cfi)) {
          throw validationError("cfi is invalid.");
        }
        const place = readPlace(body);
        const fraction = readFraction(body);
        const readAt = requireBodyInteger(body, "readAt", {
          min: EARLIEST_READ_AT,
          max: Number.MAX_SAFE_INTEGER,
        });

        const { accepted, position } = await positions.save(
          principal.userId,
          itemId,
          { cfi: cfi ?? null, place, fraction, readAt: new Date(readAt) },
        );

        // Losing to a later position is not an error: the reply carries that
        // position, so the device that lost can move to it.
        sendData(context.response, context.requestId, {
          accepted,
          position: toDto(position),
        });
      },
    },
  ];
}
