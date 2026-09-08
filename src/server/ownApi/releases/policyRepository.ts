/**
 * Reads acquisition policy out of the database.
 *
 * A profile is loaded once per evaluation and then treated as immutable. The
 * alternative — asking the database again per candidate — would turn a search
 * returning a hundred releases into a hundred round trips, and would let the
 * policy change halfway through a decision that is supposed to be explainable
 * as one thing.
 */
import type { DatabasePool } from "../database/databasePool";
import type { PreferenceCondition, PreferenceRule } from "./preferences";
import type { QualityProfile, QualityProfileItem } from "./qualityProfile";

export interface AcquisitionPolicy {
  readonly profile: QualityProfile;
  readonly preferences: readonly PreferenceRule[];
}

export interface PolicyRepository {
  listProfiles(): Promise<Array<{ id: string; name: string }>>;
  /** Null when no such profile exists. */
  load(profileId: string): Promise<AcquisitionPolicy | null>;
}

interface ProfileRow {
  id: string;
  name: string;
  items: unknown;
  cutoff_quality_id: string;
  upgrade_allowed: boolean;
  min_format_score: number;
  cutoff_format_score: number;
}

interface RuleRow {
  id: string;
  name: string;
  conditions: unknown;
  negate: boolean;
  score: number;
}

/**
 * Reads the stored ordering defensively.
 *
 * The column is JSON, so a hand-edited row can hold anything. A malformed
 * entry becomes an empty position rather than an exception: a profile that
 * refuses everything is recoverable and visible, and a profile that throws on
 * load takes the whole search with it.
 */
function toItems(raw: unknown): QualityProfileItem[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) => ({
    qualityIds: Array.isArray(entry)
      ? entry.filter((value): value is string => typeof value === "string")
      : typeof entry === "string"
        ? [entry]
        : [],
    allowed: true,
  }));
}

function toConditions(raw: unknown): PreferenceCondition[] {
  if (!Array.isArray(raw)) return [];
  const conditions: PreferenceCondition[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const candidate = entry as { type?: unknown; values?: unknown };
    if (
      typeof candidate.type !== "string" ||
      !Array.isArray(candidate.values)
    ) {
      continue;
    }
    conditions.push({
      type: candidate.type,
      values: candidate.values.filter(
        (value): value is string => typeof value === "string",
      ),
    } as PreferenceCondition);
  }
  return conditions;
}

export function createPolicyRepository(pool: DatabasePool): PolicyRepository {
  return {
    async listProfiles() {
      const result = await pool.query<{ id: string; name: string }>(
        "SELECT id, name FROM quality_profiles ORDER BY name",
      );
      return result.rows;
    },

    async load(profileId: string): Promise<AcquisitionPolicy | null> {
      const profiles = await pool.query<ProfileRow>(
        `SELECT id, name, items, cutoff_quality_id, upgrade_allowed,
                min_format_score, cutoff_format_score
           FROM quality_profiles
          WHERE id = $1`,
        [profileId],
      );
      const row = profiles.rows[0];
      if (!row) return null;

      // One query for the rules, joined to their per-profile score: the same
      // rule is worth different amounts to different profiles.
      const rules = await pool.query<RuleRow>(
        `SELECT r.id, r.name, r.conditions, r.negate, p.score
           FROM quality_profile_preferences p
           JOIN preference_rules r ON r.id = p.rule_id
          WHERE p.profile_id = $1
          ORDER BY r.name`,
        [profileId],
      );

      return {
        profile: {
          id: row.id,
          name: row.name,
          items: toItems(row.items),
          cutoffQualityId: row.cutoff_quality_id,
          upgradeAllowed: row.upgrade_allowed,
          minFormatScore: row.min_format_score,
          cutoffFormatScore: row.cutoff_format_score,
        },
        preferences: rules.rows.map((rule) => ({
          id: rule.id,
          name: rule.name,
          score: rule.score,
          conditions: toConditions(rule.conditions),
          negate: rule.negate,
        })),
      };
    },
  };
}
