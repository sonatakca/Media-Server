import {
  createDatabasePool,
  type DatabasePool,
} from "../src/server/ownApi/database/databasePool";
import { parseDatabaseConfig } from "../src/server/ownApi/database/databaseConfig";
import {
  createTmdbClient,
  TmdbError,
  type TmdbClient,
} from "../src/server/ownApi/metadata/tmdbClient";

/**
 * Gives already-credited people their TMDB headshot.
 *
 * A metadata refresh has kept each person's headshot path beside their TMDB id
 * only since the cast and crew row learned to show faces; everyone credited
 * before that has the id and no picture. A library-wide refresh would fill
 * them in, but it also rewrites every title's metadata and artwork to do it.
 * This asks TMDB for each person's headshot and touches nothing else.
 *
 * Run it without `--apply` first — it prints what it found and writes nothing.
 * People TMDB has no headshot for are left as they are, so a re-run asks about
 * them again and picks up any picture added since.
 */

interface Options {
  apply: boolean;
  limit: number;
}

interface PersonRow {
  id: string;
  name: string;
  tmdb_id: string;
}

/** Enough parallel lookups to finish quickly, few enough to be polite. */
const CONCURRENCY = 6;

function parseArguments(argv: string[]): Options {
  const options: Options = { apply: false, limit: Infinity };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--apply") options.apply = true;
    else if (argument === "--limit") options.limit = Number(argv[++index]);
    else if (argument !== undefined) {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

function requireEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not configured.`);
  return value;
}

/** One lookup, waiting out TMDB's rate limit rather than counting it a miss. */
async function lookUp(
  tmdb: TmdbClient,
  providerId: string,
): Promise<string | null> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await tmdb.getPersonProfilePath!(providerId);
    } catch (error) {
      const retryable =
        error instanceof TmdbError &&
        (error.kind === "rate-limited" || error.kind === "unavailable");
      if (!retryable || attempt >= 3) throw error;
      await new Promise((resolve) =>
        setTimeout(resolve, 1_000 * (attempt + 1)),
      );
    }
  }
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const apiKey = requireEnvironment("SEYIRLIK_TMDB_API_KEY");
  const config = parseDatabaseConfig({ ...process.env });
  if (!config) throw new Error("Native database configuration is unavailable.");

  const pool: DatabasePool = createDatabasePool(config);
  const tmdb = createTmdbClient({ apiKey });

  try {
    const people = (
      await pool.query<PersonRow>(
        `SELECT p.id, p.name, p.provider_ids->>'tmdb' AS tmdb_id
         FROM people p
         WHERE p.provider_ids ? 'tmdb'
           AND NOT p.provider_ids ? 'tmdbProfilePath'
           AND EXISTS (SELECT 1 FROM item_people ip WHERE ip.person_id = p.id)
         ORDER BY p.name`,
      )
    ).rows.slice(0, options.limit);

    console.info(`${people.length} credited people have no headshot yet.`);
    const summary = { found: 0, none: 0, failed: 0 };

    for (let start = 0; start < people.length; start += CONCURRENCY) {
      await Promise.all(
        people.slice(start, start + CONCURRENCY).map(async (person) => {
          try {
            const profilePath = await lookUp(tmdb, person.tmdb_id);
            if (!profilePath) {
              summary.none += 1;
              return;
            }
            if (options.apply) {
              await pool.query(
                `UPDATE people
                 SET provider_ids = provider_ids || jsonb_build_object('tmdbProfilePath', $2::text)
                 WHERE id = $1`,
                [person.id, profilePath],
              );
            }
            summary.found += 1;
          } catch (error) {
            console.info(
              `  FAILED ${person.name} (${person.tmdb_id}): ${error instanceof Error ? error.message : "lookup failed"}`,
            );
            summary.failed += 1;
          }
        }),
      );
    }

    console.info(
      options.apply
        ? `Headshots stored ${summary.found}, none on TMDB ${summary.none}, failed ${summary.failed}.`
        : `${summary.found} headshot(s) would be stored, ${summary.none} have none on TMDB, ${summary.failed} failed. Re-run with --apply to write them.`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(
    "Headshot backfill failed:",
    error instanceof Error ? error.message : "Unknown error",
  );
  process.exitCode = 1;
});
