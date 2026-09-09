/**
 * Moves what Radarr and Sonarr were watching into Seyirlik's own monitoring.
 *
 * The legacy applications are read here and nowhere else in the running
 * system: they are a migration source, not a runtime dependency. Their SQLite
 * files are opened read-only, and the intended input is the copy taken by the
 * pre-cutover snapshot rather than a live instance's database.
 *
 * ## Preserving intent rather than copying booleans
 *
 * Sonarr stores an explicit monitored flag on every season and every episode.
 * Seyirlik's model is deliberately tri-state — `monitored`, `unmonitored`,
 * `inherit` — so that "somebody decided this" and "this follows its parent"
 * stay distinguishable. Copying every boolean across would record 300 explicit
 * decisions where a handful were actually made, and the first time an operator
 * unmonitored a series they would find every season still going.
 *
 * So a level is written explicitly only where it differs from what it would
 * inherit, and `inherit` where it agrees. The effective state is identical
 * today, and the structure now says where a real decision lives.
 *
 * ## What cannot be migrated
 *
 * Monitoring hangs off a catalogue item, so a title the legacy side watches
 * but Seyirlik has no item for — a wanted film with nothing on disk — has
 * nowhere to go. Those are counted and named rather than dropped silently;
 * they are wants to re-create once acquisition is authoritative, not data to
 * invent an item for.
 *
 * Idempotent: every write is an upsert keyed by item, so a second run changes
 * nothing. Default is a dry run; pass `--apply` to write.
 */
import { DatabaseSync } from "node:sqlite";
import { createDatabasePool } from "../src/server/ownApi/database/databasePool";
import { parseDatabaseConfig } from "../src/server/ownApi/database/databaseConfig";
import { createMonitoringRepository } from "../src/server/ownApi/releases/monitoringRepository";
import type { MonitoringChoice } from "../src/server/ownApi/releases/monitoring";

function argumentValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv
    .find((argument) => argument.startsWith(prefix))
    ?.slice(prefix.length);
}

/** `D:\media\Movies\Dune (2021)\` -> `dune (2021)`. */
function folderKey(pathValue: string): string {
  const parts = pathValue
    .replace(/\\/g, "/")
    .split("/")
    .filter((part) => part.length > 0);
  return (parts[parts.length - 1] ?? "").toLowerCase();
}

interface SeasonFlag {
  seasonNumber: number;
  monitored: boolean;
}

function parseSeasons(raw: unknown): SeasonFlag[] {
  if (typeof raw !== "string") return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      if (typeof entry !== "object" || entry === null) return [];
      const record = entry as Record<string, unknown>;
      return typeof record.seasonNumber === "number"
        ? [
            {
              seasonNumber: record.seasonNumber,
              monitored: record.monitored === true,
            },
          ]
        : [];
    });
  } catch {
    return [];
  }
}

/** Explicit only where it differs from what it would inherit. */
function choiceFor(own: boolean, inherited: boolean): MonitoringChoice {
  if (own === inherited) return "inherit";
  return own ? "monitored" : "unmonitored";
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const radarrPath = argumentValue("radarr");
  const sonarrPath = argumentValue("sonarr");
  if (!radarrPath && !sonarrPath) {
    throw new Error("At least one of --radarr=<file> or --sonarr=<file>.");
  }
  console.info(apply ? "Applying." : "Dry run; pass --apply to write.");

  const pool = createDatabasePool(parseDatabaseConfig({ ...process.env }));
  try {
    const monitoring = createMonitoringRepository(pool);

    const items = await pool.query<{ id: string; source_key: string }>(
      "SELECT id, source_key FROM items WHERE kind IN ('movie','series')",
    );
    const itemBySourceKey = new Map(
      items.rows.map((row) => [row.source_key, row.id]),
    );

    const profiles = await pool.query<{ id: string; name: string }>(
      "SELECT id, name FROM quality_profiles",
    );
    const profileByName = new Map(
      profiles.rows.map((row) => [row.name.toLowerCase(), row.id]),
    );

    const unresolved: string[] = [];
    let titles = 0;
    let seasons = 0;
    let episodes = 0;

    if (radarrPath) {
      const radarr = new DatabaseSync(radarrPath, { readOnly: true });
      const legacyProfiles = new Map(
        (
          radarr
            .prepare("SELECT Id, Name FROM QualityProfiles")
            .all() as Array<{
            Id: number;
            Name: string;
          }>
        ).map((row) => [row.Id, row.Name]),
      );
      const movies = radarr
        .prepare(
          `SELECT m.Path AS path, m.Monitored AS monitored,
                  m.QualityProfileId AS profileId, md.Title AS title
             FROM Movies m LEFT JOIN MovieMetadata md ON md.Id = m.MovieMetadataId`,
        )
        .all() as Array<Record<string, unknown>>;
      console.info(`\nRadarr: ${movies.length} movie(s)`);

      for (const movie of movies) {
        const sourceKey = `movie:movies/${folderKey(String(movie.path ?? ""))}`;
        const itemId = itemBySourceKey.get(sourceKey);
        if (!itemId) {
          unresolved.push(`movie ${String(movie.title ?? movie.path)}`);
          continue;
        }
        const profileName = legacyProfiles.get(Number(movie.profileId));
        const profileId = profileName
          ? (profileByName.get(profileName.toLowerCase()) ?? null)
          : null;
        titles += 1;
        if (apply) {
          await monitoring.setTitle(itemId, {
            monitored: Number(movie.monitored) === 1,
            profileId,
          });
        }
      }
      radarr.close();
    }

    if (sonarrPath) {
      const sonarr = new DatabaseSync(sonarrPath, { readOnly: true });
      const legacyProfiles = new Map(
        (
          sonarr
            .prepare("SELECT Id, Name FROM QualityProfiles")
            .all() as Array<{
            Id: number;
            Name: string;
          }>
        ).map((row) => [row.Id, row.Name]),
      );
      const allSeries = sonarr
        .prepare(
          `SELECT Id AS id, Title AS title, Path AS path, Monitored AS monitored,
                  QualityProfileId AS profileId, Seasons AS seasons FROM Series`,
        )
        .all() as Array<Record<string, unknown>>;
      console.info(`\nSonarr: ${allSeries.length} series`);

      const episodeStatement = sonarr.prepare(
        `SELECT SeasonNumber AS season, EpisodeNumber AS episode, Monitored AS monitored
           FROM Episodes WHERE SeriesId = ?`,
      );

      for (const series of allSeries) {
        const sourceKey = `series:series/${folderKey(String(series.path ?? ""))}`;
        const itemId = itemBySourceKey.get(sourceKey);
        if (!itemId) {
          unresolved.push(`series ${String(series.title ?? series.path)}`);
          continue;
        }
        const seriesMonitored = Number(series.monitored) === 1;
        const profileName = legacyProfiles.get(Number(series.profileId));
        const profileId = profileName
          ? (profileByName.get(profileName.toLowerCase()) ?? null)
          : null;
        titles += 1;
        if (apply) {
          await monitoring.setTitle(itemId, {
            monitored: seriesMonitored,
            profileId,
          });
        }

        const seasonFlags = new Map(
          parseSeasons(series.seasons).map((flag) => [
            flag.seasonNumber,
            flag.monitored,
          ]),
        );
        for (const [seasonNumber, monitored] of seasonFlags) {
          const choice = choiceFor(monitored, seriesMonitored);
          seasons += 1;
          if (apply) {
            await monitoring.setSeason(itemId, seasonNumber, choice);
          }
        }

        for (const row of episodeStatement.all(Number(series.id)) as Array<
          Record<string, unknown>
        >) {
          const seasonNumber = Number(row.season);
          const episodeNumber = Number(row.episode);
          const monitored = Number(row.monitored) === 1;
          // What this episode would inherit: its season's opinion when the
          // season has one, otherwise the series'.
          const inherited = seasonFlags.get(seasonNumber) ?? seriesMonitored;
          const choice = choiceFor(monitored, inherited);
          if (choice === "inherit") continue;
          episodes += 1;
          if (apply) {
            await monitoring.setEpisode(
              itemId,
              seasonNumber,
              episodeNumber,
              choice,
            );
          }
        }
      }
      sonarr.close();
    }

    console.info(
      `\n${apply ? "Migrated" : "Would migrate"}: ${titles} title(s), ` +
        `${seasons} season row(s), ${episodes} explicit episode override(s).`,
    );
    console.info(`Unresolved (no catalogue item): ${unresolved.length}`);
    for (const name of unresolved) console.info(`  - ${name}`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(
    "Migrating legacy monitoring failed:",
    error instanceof Error ? error.message : "Unknown error",
  );
  process.exitCode = 1;
});
