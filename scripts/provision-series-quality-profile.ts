/**
 * Creates the quality profile the Sonarr series were actually using.
 *
 * The migration deliberately left six series without a profile rather than
 * attaching them to the film profile, because the two legacy profiles carry
 * different names — Radarr's `1080p-2160p x265` and Sonarr's `1080-2160p` —
 * and guessing that a differently named profile means the same thing is how a
 * codec constraint nobody chose gets applied to a whole library.
 *
 * Reading the legacy databases settled it. Both profiles allow the same two
 * tiers, both disallow upgrades, and — the part that was not visible from the
 * names — Sonarr's profile scores the custom format `x265 | HEVC` at 100,
 * exactly as Radarr's does. They are the same policy under two names.
 *
 * So this reproduces that policy under Sonarr's own name rather than
 * redirecting the series onto the film profile: the two are equal today, and
 * an operator who later retunes films should not silently retune television.
 * The one deliberate difference from the film profile is the cutoff. Both
 * legacy profiles cut off at the WEB 1080p group, which is what is written
 * here; the existing film profile cuts off at 2160p and is left exactly as it
 * is, as instructed.
 *
 * Because the profile is created under the legacy name,
 * `migrate-legacy-monitoring.ts` — which maps profiles by name — attaches the
 * six series on its next run. Nothing here touches monitoring.
 *
 * Idempotent, keyed by profile name. Default is a dry run; pass `--apply`.
 */
import { randomUUID } from "node:crypto";
import { createDatabasePool } from "../src/server/ownApi/database/databasePool";
import { parseDatabaseConfig } from "../src/server/ownApi/database/databaseConfig";

/** Read from Sonarr QualityProfiles id 7, `1080-2160p`. */
const PROFILE_NAME = "1080-2160p";
const TIERS = [
  ["webrip-1080p", "webdl-1080p", "bluray-1080p"],
  ["webrip-2160p", "webdl-2160p", "bluray-2160p"],
];
/** The WEB 1080p group, named by the lowest member of its tier. */
const CUTOFF_QUALITY_ID = "webrip-1080p";
const UPGRADE_ALLOWED = false;
/** `x265 | HEVC`, scored 100 in the legacy profile. */
const PREFERENCE_RULE_NAME = "x265 HEVC";
const PREFERENCE_SCORE = 100;

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  console.info(apply ? "Applying." : "Dry run; pass --apply to write.");

  const pool = createDatabasePool(parseDatabaseConfig({ ...process.env }));
  try {
    const rule = await pool.query<{ id: string }>(
      "SELECT id FROM preference_rules WHERE name = $1",
      [PREFERENCE_RULE_NAME],
    );
    const ruleId = rule.rows[0]?.id ?? null;
    if (!ruleId) {
      /*
       * Refuse rather than invent one. The rule describes which releases count
       * as HEVC, and a second rule of the same name built from a guess would
       * score releases differently from the one the film profile uses.
       */
      throw new Error(
        `No preference rule named "${PREFERENCE_RULE_NAME}" exists; refusing to create a second definition of it.`,
      );
    }
    console.info(`preference rule "${PREFERENCE_RULE_NAME}": ${ruleId}`);

    const existing = await pool.query<{ id: string }>(
      "SELECT id FROM quality_profiles WHERE name = $1",
      [PROFILE_NAME],
    );
    const profileId = existing.rows[0]?.id ?? randomUUID();
    console.info(
      `profile "${PROFILE_NAME}": ${existing.rows[0] ? `exists (${profileId})` : `would be created (${profileId})`}`,
    );
    console.info(`  tiers=${JSON.stringify(TIERS)}`);
    console.info(
      `  cutoff=${CUTOFF_QUALITY_ID} upgradeAllowed=${UPGRADE_ALLOWED} ${PREFERENCE_RULE_NAME}=${PREFERENCE_SCORE}`,
    );

    if (!apply) return;

    await pool.query(
      `INSERT INTO quality_profiles
         (id, name, items, cutoff_quality_id, upgrade_allowed,
          min_format_score, cutoff_format_score)
       VALUES ($1, $2, $3::jsonb, $4, $5, 0, 0)
       ON CONFLICT (id) DO UPDATE
          SET items = EXCLUDED.items,
              cutoff_quality_id = EXCLUDED.cutoff_quality_id,
              upgrade_allowed = EXCLUDED.upgrade_allowed,
              updated_at = now()`,
      [
        profileId,
        PROFILE_NAME,
        JSON.stringify(TIERS),
        CUTOFF_QUALITY_ID,
        UPGRADE_ALLOWED,
      ],
    );
    await pool.query(
      `INSERT INTO quality_profile_preferences (profile_id, rule_id, score)
       VALUES ($1, $2, $3)
       ON CONFLICT (profile_id, rule_id) DO UPDATE SET score = EXCLUDED.score`,
      [profileId, ruleId, PREFERENCE_SCORE],
    );
    console.info("Provisioned.");
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(
    "Provisioning the series quality profile failed:",
    error instanceof Error ? error.message : "Unknown error",
  );
  process.exitCode = 1;
});
