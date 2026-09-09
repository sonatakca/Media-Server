/**
 * What each backup produced, recorded so that "successful" means something.
 *
 * The Phase-1 scripts already take the backup. What they never had was a
 * durable record of what a run found and proved, so a panel could only report
 * that a script had exited zero — a check that reads as passing while checking
 * nothing, which is the same defect the restore-verification query carried for
 * years against a table that did not exist.
 *
 * Nothing here holds a password, a secret's contents, a credential-bearing
 * command or an absolute path. A destination is a class; what was found is a
 * set of booleans.
 */
import { randomUUID } from "node:crypto";
import type { DatabasePool } from "../database/databasePool";

export type BackupState = "planned" | "running" | "succeeded" | "failed";
export type BackupDestinationClass = "local-protected" | "removable" | "remote";
export type BackupVerification = "unverified" | "verified" | "failed";

export interface BackupRun {
  readonly id: string;
  readonly state: BackupState;
  readonly destinationClass: BackupDestinationClass;
  readonly dumpPresent: boolean;
  readonly configPresent: boolean;
  readonly secretsPresent: boolean;
  readonly dumpBytes?: number;
  readonly schemaVersion?: string;
  readonly schemaCount?: number;
  readonly verification: BackupVerification;
  readonly verifiedTables?: number;
  readonly liveTables?: number;
  readonly failureClass?: string;
  readonly failureDetail?: string;
  readonly startedAtMs: number;
  readonly finishedAtMs?: number;
}

export interface RecordBackupInput {
  readonly state: BackupState;
  readonly destinationClass: BackupDestinationClass;
  readonly dumpPresent: boolean;
  readonly configPresent: boolean;
  readonly secretsPresent: boolean;
  readonly dumpBytes?: number;
  readonly schemaVersion?: string;
  readonly schemaCount?: number;
  readonly verification: BackupVerification;
  readonly verifiedTables?: number;
  readonly liveTables?: number;
  readonly failureClass?: string;
  readonly failureDetail?: string;
  readonly startedAtMs?: number;
  readonly finishedAtMs?: number;
}

export interface BackupRepository {
  record(input: RecordBackupInput): Promise<BackupRun>;
  list(limit?: number): Promise<BackupRun[]>;
  latest(): Promise<BackupRun | null>;
  /** The newest run a restore was actually rehearsed for. */
  latestVerified(): Promise<BackupRun | null>;
}

interface Row {
  id: string;
  state: string;
  destination_class: string;
  dump_present: boolean;
  config_present: boolean;
  secrets_present: boolean;
  dump_bytes: string | number | null;
  schema_version: string | null;
  schema_count: number | null;
  verification: string;
  verified_tables: number | null;
  live_tables: number | null;
  failure_class: string | null;
  failure_detail: string | null;
  started_at: Date;
  finished_at: Date | null;
}

const COLUMNS = `id, state, destination_class, dump_present, config_present,
  secrets_present, dump_bytes, schema_version, schema_count, verification,
  verified_tables, live_tables, failure_class, failure_detail, started_at,
  finished_at`;

function toRun(row: Row): BackupRun {
  const bytes = row.dump_bytes === null ? undefined : Number(row.dump_bytes);
  return {
    id: row.id,
    state: row.state as BackupState,
    destinationClass: row.destination_class as BackupDestinationClass,
    dumpPresent: row.dump_present,
    configPresent: row.config_present,
    secretsPresent: row.secrets_present,
    ...(bytes === undefined || Number.isNaN(bytes) ? {} : { dumpBytes: bytes }),
    ...(row.schema_version ? { schemaVersion: row.schema_version } : {}),
    ...(row.schema_count === null ? {} : { schemaCount: row.schema_count }),
    verification: row.verification as BackupVerification,
    ...(row.verified_tables === null
      ? {}
      : { verifiedTables: row.verified_tables }),
    ...(row.live_tables === null ? {} : { liveTables: row.live_tables }),
    ...(row.failure_class ? { failureClass: row.failure_class } : {}),
    ...(row.failure_detail ? { failureDetail: row.failure_detail } : {}),
    startedAtMs: row.started_at.getTime(),
    ...(row.finished_at ? { finishedAtMs: row.finished_at.getTime() } : {}),
  };
}

export function createBackupRepository(pool: DatabasePool): BackupRepository {
  return {
    async record(input) {
      const result = await pool.query<Row>(
        `INSERT INTO backup_runs
           (id, state, destination_class, dump_present, config_present,
            secrets_present, dump_bytes, schema_version, schema_count,
            verification, verified_tables, live_tables, failure_class,
            failure_detail, started_at, finished_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
                 COALESCE($15, now()), $16)
         RETURNING ${COLUMNS}`,
        [
          randomUUID(),
          input.state,
          input.destinationClass,
          input.dumpPresent,
          input.configPresent,
          input.secretsPresent,
          input.dumpBytes ?? null,
          input.schemaVersion ?? null,
          input.schemaCount ?? null,
          input.verification,
          input.verifiedTables ?? null,
          input.liveTables ?? null,
          input.failureClass ?? null,
          input.failureDetail ?? null,
          input.startedAtMs ? new Date(input.startedAtMs) : null,
          input.finishedAtMs ? new Date(input.finishedAtMs) : null,
        ],
      );
      return toRun(result.rows[0]!);
    },

    async list(limit = 50) {
      const result = await pool.query<Row>(
        `SELECT ${COLUMNS} FROM backup_runs
          ORDER BY started_at DESC LIMIT $1`,
        [Math.min(Math.max(limit, 1), 200)],
      );
      return result.rows.map(toRun);
    },

    async latest() {
      const result = await pool.query<Row>(
        `SELECT ${COLUMNS} FROM backup_runs ORDER BY started_at DESC LIMIT 1`,
      );
      return result.rows[0] ? toRun(result.rows[0]) : null;
    },

    async latestVerified() {
      const result = await pool.query<Row>(
        `SELECT ${COLUMNS} FROM backup_runs
          WHERE verification = 'verified'
          ORDER BY started_at DESC LIMIT 1`,
      );
      return result.rows[0] ? toRun(result.rows[0]) : null;
    },
  };
}

/**
 * Whether the backup state is one an operator can rely on.
 *
 * A dump that exists is not the same as a dump that restores, so a run only
 * counts as healthy when a restore was rehearsed and its table count matched
 * the live database. Everything else is reported as what it is.
 */
export function backupHealth(latest: BackupRun | null): {
  healthy: boolean;
  reason:
    | "never-run"
    | "last-run-failed"
    | "unverified"
    | "incomplete"
    | "verified";
} {
  if (!latest) return { healthy: false, reason: "never-run" };
  if (latest.state === "failed") {
    return { healthy: false, reason: "last-run-failed" };
  }
  if (!latest.dumpPresent || !latest.configPresent) {
    return { healthy: false, reason: "incomplete" };
  }
  if (latest.verification !== "verified") {
    return { healthy: false, reason: "unverified" };
  }
  return { healthy: true, reason: "verified" };
}
