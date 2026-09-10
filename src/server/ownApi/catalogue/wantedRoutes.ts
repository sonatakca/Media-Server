import { MEDIA_STATUS_SQL, mediaAvailableSql } from "./mediaAvailability";
import type { DatabasePool } from "../database/databasePool";
import { withTransaction } from "../database/transaction";
import type { TmdbClient } from "../metadata/tmdbClient";
import { TmdbError } from "../metadata/tmdbClient";
import type { RouteDefinition } from "../api/router";
import { sendData } from "../api/envelope";
import {
  asObjectBody,
  requireBodyString,
  requireUuid,
  validationError,
} from "../api/validation";
import { OwnApiError } from "../ownApiHandler";
import { createDesiredItemRepository } from "./desiredItems";

export function createWantedRoutes(
  pool: DatabasePool,
  tmdb: TmdbClient | undefined,
): RouteDefinition[] {
  const requireTmdb = () => {
    if (!tmdb)
      throw new OwnApiError(
        "PROVIDER_UNAVAILABLE",
        "TMDB is not configured.",
        503,
      );
    return tmdb;
  };
  async function provider<T>(read: () => Promise<T>): Promise<T> {
    try {
      return await read();
    } catch (error) {
      if (error instanceof TmdbError)
        throw new OwnApiError(
          "PROVIDER_UNAVAILABLE",
          "TMDB could not answer. Try again shortly.",
          503,
        );
      throw error;
    }
  }
  return [
    {
      method: "GET",
      path: "/wanted/catalogue",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        const kind = context.url.searchParams.get("kind") ?? "movie";
        const query = (context.url.searchParams.get("query") ?? "").trim();
        const page = Number(context.url.searchParams.get("page") ?? "1");
        if (
          !["movie", "tv"].includes(kind) ||
          query.length > 300 ||
          !Number.isInteger(page) ||
          page < 1 ||
          page > 500
        )
          throw validationError("Invalid catalogue search.");
        const client = requireTmdb();
        if (!client.catalogue)
          throw new OwnApiError(
            "PROVIDER_UNAVAILABLE",
            "TMDB catalogue is unavailable.",
            503,
          );
        sendData(
          context.response,
          context.requestId,
          await provider(() =>
            client.catalogue!(kind as "movie" | "tv", query, page),
          ),
        );
      },
    },
    {
      method: "GET",
      path: "/wanted",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        const [items, libraries] = await Promise.all([
          pool.query(`SELECT item.id, item.title, item.kind, item.desired, item.production_year AS year, item.provider_ids->>'tmdb' AS "providerId",
            ${mediaAvailableSql()} AS "hasMedia",
            ${MEDIA_STATUS_SQL} AS status
            FROM items item WHERE item.kind IN ('movie', 'series') ORDER BY item.sort_title`),
          pool.query(`SELECT l.id, l.name, l.kind FROM libraries l
            WHERE l.kind IN ('movies', 'series') AND (SELECT count(*) FROM library_roots r WHERE r.library_id = l.id) = 1
            ORDER BY l.sort_order, l.name`),
        ]);
        sendData(context.response, context.requestId, {
          items: items.rows,
          libraries: libraries.rows,
        });
      },
    },
    {
      method: "PUT",
      path: "/wanted/:itemId",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        const id = requireUuid(context.params.itemId, "itemId");
        const body = asObjectBody(await context.readJson(), ["desired"]);
        if (typeof body.desired !== "boolean")
          throw validationError("Choose whether the title is wanted.");
        await withTransaction(pool, async (transaction) => {
          const result = await transaction.query(
            `UPDATE items SET desired = $2, desired_since = CASE WHEN $2 THEN COALESCE(desired_since, now()) ELSE NULL END, updated_at = now()
            WHERE id = $1 AND kind IN ('movie', 'series') RETURNING id`,
            [id, body.desired],
          );
          if (!result.rows.length)
            throw new OwnApiError("NOT_FOUND", "No such movie or show.", 404);
          await transaction.query(
            `INSERT INTO monitored_items (item_id, monitored) VALUES ($1, $2)
            ON CONFLICT (item_id) DO UPDATE SET monitored = $2, updated_at = now()`,
            [id, body.desired],
          );
        });
        sendData(context.response, context.requestId, {
          id,
          desired: body.desired,
        });
      },
    },
    {
      method: "POST",
      path: "/wanted",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        const body = asObjectBody(await context.readJson(), [
          "kind",
          "providerId",
          "libraryId",
        ]);
        const kind = requireBodyString(body, "kind");
        const providerId = requireBodyString(body, "providerId", {
          maxLength: 16,
        });
        const libraryId = requireUuid(
          requireBodyString(body, "libraryId"),
          "libraryId",
        );
        if (
          !["movie", "series"].includes(kind) ||
          !/^[1-9][0-9]{0,10}$/.test(providerId)
        )
          throw validationError("Choose a TMDB movie or show.");
        const client = requireTmdb();
        // Identity and metadata come from TMDB, never client-supplied title text.
        const details = await provider(() =>
          kind === "movie"
            ? client.getMovie(providerId)
            : client.getSeries(providerId),
        );
        const year = details.releaseDate
          ? Number(details.releaseDate.slice(0, 4))
          : undefined;
        const item = await withTransaction(pool, async (transaction) => {
          const roots = await transaction.query<{ relative_path: string }>(
            `SELECT r.relative_path FROM library_roots r JOIN libraries l ON l.id = r.library_id
             WHERE l.id = $1 AND l.kind = $2 ORDER BY r.relative_path`,
            [libraryId, kind === "movie" ? "movies" : "series"],
          );
          if (roots.rows.length !== 1)
            throw validationError(
              "Choose a library with one destination root.",
            );
          // Serialize requests for the same provider identity, including translated names.
          await transaction.query(
            "SELECT pg_advisory_xact_lock(hashtext($1))",
            [`wanted:${libraryId}:${kind}:${providerId}`],
          );
          const existing = await transaction.query<{ id: string }>(
            "SELECT id FROM items WHERE library_id = $1 AND kind = $2 AND provider_ids->>'tmdb' = $3 ORDER BY date_created LIMIT 1",
            [libraryId, kind, providerId],
          );
          const id =
            existing.rows[0]?.id ??
            (
              await createDesiredItemRepository(transaction).desire({
                libraryId,
                libraryRoot: roots.rows[0]!.relative_path,
                kind: kind as "movie" | "series",
                title: details.title,
                ...(year ? { year } : {}),
              })
            ).id;
          const identity = await transaction.query<{ tmdb: string | null }>(
            "SELECT provider_ids->>'tmdb' AS tmdb FROM items WHERE id = $1 FOR UPDATE",
            [id],
          );
          if (identity.rows[0]?.tmdb && identity.rows[0].tmdb !== providerId)
            throw validationError(
              "A different TMDB title already occupies this library location.",
            );
          await transaction.query(
            `UPDATE items SET desired = true, desired_since = COALESCE(desired_since, now()),
            provider_ids = provider_ids || jsonb_build_object('tmdb', $2::text),
            overview = COALESCE(overview, $3), updated_at = now() WHERE id = $1`,
            [id, providerId, details.overview ?? null],
          );
          await transaction.query(
            `INSERT INTO monitored_items (item_id, monitored) VALUES ($1, true)
            ON CONFLICT (item_id) DO UPDATE SET monitored = true, updated_at = now()`,
            [id],
          );
          return { id, title: details.title, kind, year, providerId };
        });
        sendData(context.response, context.requestId, { item });
      },
    },
  ];
}
