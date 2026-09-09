/**
 * Recovers what was watched in Jellyfin into Seyirlik's own user state.
 *
 * Jellyfin is a migration source here and nowhere else: its database is opened
 * read-only, and the intended input is a snapshot copy rather than a live
 * instance's file.
 *
 * ## Why this cannot join on paths
 *
 * The obvious key is the file path, and it does not work. Jellyfin's library
 * was rebuilt at some point, and the rows carrying the interesting state —
 * played flags and resume positions — now point at `PLACEHOLDER` items with no
 * path at all. Every one of them was orphaned from the file it described.
 *
 * What survived is `UserData.CustomDataKey`, which holds the provider identity
 * the state was recorded against: an IMDb id, a TMDB id, or for an episode the
 * series' provider id with the season and episode numbers appended as three
 * digits each. Seyirlik stores the same provider ids on its items once metadata
 * has run, so identity is the join that still holds when paths do not.
 *
 * Rows whose key is one of Jellyfin's opaque hashes cannot be resolved by
 * anything and are counted rather than guessed at.
 *
 * ## What is written, and what is refused
 *
 * One row per resolved item in `user_item_state`, for a single named Seyirlik
 * user. Jellyfin's per-user state is not merged: several people watched through
 * one Jellyfin, and folding their positions together would invent a history
 * nobody had.
 *
 * A resume position is only written when the item has no newer state in
 * Seyirlik already. Migrating must never move somebody's position backwards, so
 * a Seyirlik row touched more recently than the Jellyfin row wins and is
 * reported as skipped.
 *
 * Idempotent: every write is an upsert keyed by (user, item), and the
 * last-played comparison makes a second run a no-op. Default is a dry run; pass
 * `--apply` to write. Writes happen in one transaction, so a failure part-way
 * leaves nothing behind.
 */
import { DatabaseSync } from "node:sqlite";
import { createDatabasePool } from "../src/server/ownApi/database/databasePool";
import { parseDatabaseConfig } from "../src/server/ownApi/database/databaseConfig";

function argumentValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv
    .find((argument) => argument.startsWith(prefix))
    ?.slice(prefix.length);
}

/** Jellyfin counts in 100-nanosecond ticks; everything here is milliseconds. */
const TICKS_PER_MS = 10_000n;

interface JellyfinState {
  key: string;
  played: boolean;
  positionMs: number;
  playCount: number;
  favourite: boolean;
  lastPlayedAt: string | null;
  audioStreamIndex: number | null;
  subtitleStreamIndex: number | null;
}

interface ResolvedTarget {
  itemId: string;
  title: string;
  via: "movie-imdb" | "movie-tmdb" | "episode";
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const jellyfinDb =
    argumentValue("jellyfin-db") ??
    "C:/ProgramData/Jellyfin/Server/data/jellyfin.db";
  const jellyfinUser = argumentValue("jellyfin-user");
  const seyirlikUser = argumentValue("seyirlik-user");

  if (!jellyfinUser || !seyirlikUser) {
    throw new Error(
      "usage: --jellyfin-user=<name> --seyirlik-user=<normalized username> [--jellyfin-db=<path>] [--apply]",
    );
  }

  const source = new DatabaseSync(jellyfinDb, { readOnly: true });
  const rows = source
    .prepare(
      `SELECT d.CustomDataKey AS key, d.Played AS played,
              d.PlaybackPositionTicks AS ticks, d.PlayCount AS playCount,
              d.IsFavorite AS favourite, d.LastPlayedDate AS lastPlayedAt,
              d.AudioStreamIndex AS audioStreamIndex,
              d.SubtitleStreamIndex AS subtitleStreamIndex
         FROM UserData d
         JOIN Users u ON u.Id = d.UserId
        WHERE u.Username = ?
          AND d.CustomDataKey IS NOT NULL
          AND (d.Played = 1 OR d.PlaybackPositionTicks > 0 OR d.IsFavorite = 1)`,
    )
    .all(jellyfinUser) as unknown as Array<Record<string, unknown>>;
  source.close();

  const states: JellyfinState[] = rows.map((row) => ({
    key: String(row.key),
    played: Number(row.played) === 1,
    positionMs: Number(BigInt(String(row.ticks ?? 0)) / TICKS_PER_MS),
    playCount: Number(row.playCount ?? 0),
    favourite: Number(row.favourite) === 1,
    lastPlayedAt: row.lastPlayedAt ? String(row.lastPlayedAt) : null,
    audioStreamIndex:
      row.audioStreamIndex === null ? null : Number(row.audioStreamIndex),
    subtitleStreamIndex:
      row.subtitleStreamIndex === null ? null : Number(row.subtitleStreamIndex),
  }));

  const pool = createDatabasePool(parseDatabaseConfig(process.env));
  const user = await pool.query<{ id: string }>(
    "SELECT id FROM native_users WHERE normalized_username = $1",
    [seyirlikUser],
  );
  const userId = user.rows[0]?.id;
  if (!userId) throw new Error(`no Seyirlik user named ${seyirlikUser}`);

  /*
   * The whole catalogue's provider identity, read once. It is small, and a
   * per-row lookup against a few hundred items would be slower and no clearer.
   */
  const items = await pool.query<{
    id: string;
    kind: string;
    title: string;
    series_id: string | null;
    index_number: number | null;
    parent_index_number: number | null;
    imdb: string | null;
    tmdb: string | null;
  }>(
    `SELECT id, kind, title, series_id, index_number, parent_index_number,
            provider_ids->>'imdb' AS imdb, provider_ids->>'tmdb' AS tmdb
       FROM items`,
  );

  const movieByImdb = new Map<string, (typeof items.rows)[number]>();
  const movieByTmdb = new Map<string, (typeof items.rows)[number]>();
  const seriesByProvider = new Map<string, string>();
  const episodeByPosition = new Map<string, (typeof items.rows)[number]>();

  for (const item of items.rows) {
    if (item.kind === "movie") {
      if (item.imdb) movieByImdb.set(item.imdb, item);
      if (item.tmdb) movieByTmdb.set(item.tmdb, item);
    } else if (item.kind === "series") {
      if (item.imdb) seriesByProvider.set(item.imdb, item.id);
      if (item.tmdb) seriesByProvider.set(item.tmdb, item.id);
    } else if (item.kind === "episode") {
      if (
        item.series_id &&
        item.parent_index_number !== null &&
        item.index_number !== null
      ) {
        episodeByPosition.set(
          `${item.series_id}:${item.parent_index_number}:${item.index_number}`,
          item,
        );
      }
    }
  }

  /*
   * Episode keys are the series' provider id with season and episode appended
   * as three digits each, so `tt0773262008004` is that series, season 8,
   * episode 4. A movie's key is the bare provider id, and the two are told
   * apart by whether the trailing six digits leave a series anybody has.
   */
  function resolve(key: string): ResolvedTarget | null {
    const movieImdb = movieByImdb.get(key);
    if (movieImdb) {
      return {
        itemId: movieImdb.id,
        title: movieImdb.title,
        via: "movie-imdb",
      };
    }
    const movieTmdb = movieByTmdb.get(key);
    if (movieTmdb) {
      return {
        itemId: movieTmdb.id,
        title: movieTmdb.title,
        via: "movie-tmdb",
      };
    }

    const episode = /^(tt\d+|\d+)(\d{3})(\d{3})$/.exec(key);
    if (episode) {
      const seriesId = seriesByProvider.get(episode[1]!);
      if (seriesId) {
        const found = episodeByPosition.get(
          `${seriesId}:${Number(episode[2])}:${Number(episode[3])}`,
        );
        if (found) {
          return { itemId: found.id, title: found.title, via: "episode" };
        }
      }
    }
    return null;
  }

  // Several keys describe the same play, so the newest row per item wins.
  const best = new Map<
    string,
    { state: JellyfinState; target: ResolvedTarget }
  >();
  let unresolved = 0;
  for (const state of states) {
    const target = resolve(state.key);
    if (!target) {
      unresolved += 1;
      continue;
    }
    const existing = best.get(target.itemId);
    if (
      !existing ||
      (state.lastPlayedAt ?? "") > (existing.state.lastPlayedAt ?? "")
    ) {
      best.set(target.itemId, { state, target });
    }
  }

  console.log(
    `Jellyfin rows for ${jellyfinUser}: ${states.length}; resolved to ${best.size} items; ${unresolved} keys matched nothing.`,
  );
  for (const { state, target } of best.values()) {
    console.log(
      `  ${target.via.padEnd(11)} ${target.title} — played=${state.played} position=${Math.round(state.positionMs / 1000)}s favourite=${state.favourite}`,
    );
  }

  if (!apply) {
    console.log("\nDry run. Pass --apply to write.");
    await pool.end?.();
    return;
  }

  let written = 0;
  let skippedNewer = 0;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const [itemId, { state }] of best) {
      /*
       * Never move a position backwards. A row Seyirlik has touched more
       * recently than Jellyfin did is the newer truth, and a migration that
       * overwrote it would lose real viewing to restore older viewing.
       */
      const result = await client.query(
        `INSERT INTO user_item_state (
           user_id, item_id, position_ms, played, play_count, is_favourite,
           last_played_at, audio_stream_index, subtitle_stream_index, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
         ON CONFLICT (user_id, item_id) DO UPDATE SET
           position_ms = EXCLUDED.position_ms,
           played = EXCLUDED.played,
           play_count = GREATEST(user_item_state.play_count, EXCLUDED.play_count),
           is_favourite = user_item_state.is_favourite OR EXCLUDED.is_favourite,
           last_played_at = EXCLUDED.last_played_at,
           audio_stream_index = EXCLUDED.audio_stream_index,
           subtitle_stream_index = EXCLUDED.subtitle_stream_index,
           updated_at = now()
         WHERE user_item_state.last_played_at IS NULL
            OR EXCLUDED.last_played_at IS NULL
            OR user_item_state.last_played_at <= EXCLUDED.last_played_at
         RETURNING item_id`,
        [
          userId,
          itemId,
          Math.max(0, Math.round(state.positionMs)),
          state.played,
          Math.max(0, state.playCount),
          state.favourite,
          state.lastPlayedAt,
          state.audioStreamIndex,
          state.subtitleStreamIndex,
        ],
      );
      if (result.rows.length > 0) written += 1;
      else skippedNewer += 1;
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  console.log(
    `\nWrote ${written} row(s); left ${skippedNewer} alone because Seyirlik already had newer state.`,
  );
  await pool.end?.();
}

main().catch((error) => {
  console.error(
    "Jellyfin watch-state migration failed:",
    error instanceof Error ? error.message : String(error),
  );
  process.exit(1);
});
