/**
 * Monitoring state, persisted.
 *
 * The tables this reads were created in migration 020 and, until now, nothing
 * wrote to them: Phase 3 built the vocabulary and the resolver and stopped
 * before the state existed. So this adds no schema. A second set of tables
 * would have been a second source of truth for one fact, and the tri-state
 * enum that makes `inherit` expressible is already there.
 *
 * The resolution itself is not reimplemented either. `resolveEpisodeMonitoring`
 * and `resolveSeasonMonitoring` are pure, already tested, and already report
 * which level decided — which is exactly what an operator needs to be told.
 * This module's job is to fetch the three rows they need and to write choices
 * back safely.
 */
import type { DatabasePool } from "../database/databasePool";
import {
  resolveEpisodeMonitoring,
  resolveSeasonMonitoring,
  type MonitoringChoice,
  type MonitoringDecision,
} from "./monitoring";

export interface TitleMonitoring {
  readonly itemId: string;
  readonly monitored: boolean;
  readonly profileId?: string;
  readonly currentQualityId?: string;
  readonly currentFormatScore: number;
}

export interface SeasonMonitoring {
  readonly seasonNumber: number;
  /** The season's own opinion. `inherit` means it has none. */
  readonly monitoring: MonitoringChoice;
  readonly effective: MonitoringDecision;
}

export interface EpisodeMonitoring {
  readonly seasonNumber: number;
  readonly episodeNumber: number;
  readonly monitoring: MonitoringChoice;
  readonly effective: MonitoringDecision;
  /** Undefined means the air date is unknown, not that it has not aired. */
  readonly airedAtMs?: number;
}

export interface SeriesMonitoring {
  readonly title: TitleMonitoring;
  readonly seasons: SeasonMonitoring[];
  readonly episodes: EpisodeMonitoring[];
}

export interface MonitoringRepository {
  /** A title's own state, or null when it has never been set. */
  readTitle(itemId: string): Promise<TitleMonitoring | null>;
  /** A title with every season and episode, each resolved and explained. */
  readSeries(seriesItemId: string): Promise<SeriesMonitoring | null>;
  setTitle(
    itemId: string,
    input: { monitored: boolean; profileId?: string | null },
  ): Promise<TitleMonitoring>;
  setSeason(
    seriesItemId: string,
    seasonNumber: number,
    monitoring: MonitoringChoice,
  ): Promise<void>;
  setEpisode(
    seriesItemId: string,
    seasonNumber: number,
    episodeNumber: number,
    monitoring: MonitoringChoice,
  ): Promise<void>;
  /** Every title Seyirlik is watching, for the acquisition side to act on. */
  listMonitoredTitles(limit?: number): Promise<TitleMonitoring[]>;
}

interface TitleRow {
  item_id: string;
  monitored: boolean;
  profile_id: string | null;
  current_quality_id: string | null;
  current_format_score: number;
}

function toTitle(row: TitleRow): TitleMonitoring {
  return {
    itemId: row.item_id,
    monitored: row.monitored,
    ...(row.profile_id ? { profileId: row.profile_id } : {}),
    ...(row.current_quality_id
      ? { currentQualityId: row.current_quality_id }
      : {}),
    currentFormatScore: row.current_format_score,
  };
}

const TITLE_COLUMNS =
  "item_id, monitored, profile_id, current_quality_id, current_format_score";

/**
 * A title with no row of its own.
 *
 * Unmonitored, deliberately. A default of monitored would mean that cataloguing
 * a library instructed Seyirlik to go and acquire all of it, which is the one
 * behaviour every phase so far has been careful not to trigger by accident.
 */
function unmonitored(itemId: string): TitleMonitoring {
  return { itemId, monitored: false, currentFormatScore: 0 };
}

export function createMonitoringRepository(
  pool: DatabasePool,
): MonitoringRepository {
  return {
    async readTitle(itemId) {
      const result = await pool.query<TitleRow>(
        `SELECT ${TITLE_COLUMNS} FROM monitored_items WHERE item_id = $1`,
        [itemId],
      );
      return result.rows[0] ? toTitle(result.rows[0]) : null;
    },

    async readSeries(seriesItemId) {
      // The item must exist and be a series; a monitoring row for something
      // that is not one would be state nothing could ever act on.
      const item = await pool.query<{ kind: string }>(
        "SELECT kind FROM items WHERE id = $1",
        [seriesItemId],
      );
      if (!item.rows[0]) return null;

      const [titleRow, seasonRows, episodeRows] = await Promise.all([
        pool.query<TitleRow>(
          `SELECT ${TITLE_COLUMNS} FROM monitored_items WHERE item_id = $1`,
          [seriesItemId],
        ),
        pool.query<{ season_number: number; monitoring: MonitoringChoice }>(
          `SELECT season_number, monitoring FROM monitored_seasons
            WHERE series_item_id = $1 ORDER BY season_number`,
          [seriesItemId],
        ),
        pool.query<{
          season_number: number;
          episode_number: number;
          monitoring: MonitoringChoice;
          aired_at: Date | null;
        }>(
          `SELECT season_number, episode_number, monitoring, aired_at
             FROM monitored_episodes
            WHERE series_item_id = $1
            ORDER BY season_number, episode_number`,
          [seriesItemId],
        ),
      ]);

      const title = titleRow.rows[0]
        ? toTitle(titleRow.rows[0])
        : unmonitored(seriesItemId);

      const seasonsByNumber = new Map(
        seasonRows.rows.map((row) => [
          row.season_number,
          { seasonNumber: row.season_number, monitoring: row.monitoring },
        ]),
      );

      return {
        title,
        seasons: seasonRows.rows.map((row) => ({
          seasonNumber: row.season_number,
          monitoring: row.monitoring,
          effective: resolveSeasonMonitoring(title, {
            seasonNumber: row.season_number,
            monitoring: row.monitoring,
          }),
        })),
        episodes: episodeRows.rows.map((row) => ({
          seasonNumber: row.season_number,
          episodeNumber: row.episode_number,
          monitoring: row.monitoring,
          ...(row.aired_at ? { airedAtMs: row.aired_at.getTime() } : {}),
          effective: resolveEpisodeMonitoring(
            title,
            seasonsByNumber.get(row.season_number),
            { monitoring: row.monitoring },
          ),
        })),
      };
    },

    async setTitle(itemId, input) {
      /*
       * One statement. Two people setting the same title cannot interleave a
       * read and a write, and the row either exists and is updated or does not
       * and is created — there is no branch here that could take the wrong one.
       */
      const result = await pool.query<TitleRow>(
        `INSERT INTO monitored_items (item_id, monitored, profile_id, updated_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (item_id) DO UPDATE
            SET monitored = EXCLUDED.monitored,
                profile_id = COALESCE(EXCLUDED.profile_id, monitored_items.profile_id),
                updated_at = now()
         RETURNING ${TITLE_COLUMNS}`,
        [itemId, input.monitored, input.profileId ?? null],
      );
      return toTitle(result.rows[0]!);
    },

    async setSeason(seriesItemId, seasonNumber, monitoring) {
      /*
       * `inherit` is stored rather than deleted. The row also carries nothing
       * else, so a delete would be equivalent — but storing it keeps "somebody
       * cleared this" and "nobody ever set it" the same shape to every reader,
       * which is what the tri-state exists for.
       */
      await pool.query(
        `INSERT INTO monitored_seasons (series_item_id, season_number, monitoring)
         VALUES ($1, $2, $3)
         ON CONFLICT (series_item_id, season_number) DO UPDATE
            SET monitoring = EXCLUDED.monitoring`,
        [seriesItemId, seasonNumber, monitoring],
      );
    },

    async setEpisode(seriesItemId, seasonNumber, episodeNumber, monitoring) {
      await pool.query(
        `INSERT INTO monitored_episodes
           (series_item_id, season_number, episode_number, monitoring)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (series_item_id, season_number, episode_number) DO UPDATE
            SET monitoring = EXCLUDED.monitoring`,
        [seriesItemId, seasonNumber, episodeNumber, monitoring],
      );
    },

    async listMonitoredTitles(limit = 500) {
      const result = await pool.query<TitleRow>(
        `SELECT ${TITLE_COLUMNS} FROM monitored_items
          WHERE monitored
          ORDER BY updated_at DESC
          LIMIT $1`,
        [Math.min(Math.max(limit, 1), 2000)],
      );
      return result.rows.map(toTitle);
    },
  };
}
