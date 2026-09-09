/**
 * Records what a backup run produced, from a manifest the backup script wrote.
 *
 * The backup itself is taken by an operational PowerShell script, and that is
 * where it belongs: it needs `pg_dump`, the secrets file and a scratch
 * database, none of which the application has any business holding open. What
 * the script cannot do is write a row that the rest of the system understands,
 * so it drops a manifest and calls this.
 *
 * Without this bridge `backup_runs` would be a table only its own tests ever
 * wrote to, and the backup panel would go on reporting a script's exit code —
 * the precise failure the table was added to end.
 *
 * The manifest carries evidence, never content: counts, sizes, booleans and a
 * verdict. A path in it is used to decide `dumpPresent`, and is not stored.
 */
import { readFile } from "node:fs/promises";
import { createDatabasePool } from "../src/server/ownApi/database/databasePool";
import { parseDatabaseConfig } from "../src/server/ownApi/database/databaseConfig";
import {
  createBackupRepository,
  type BackupDestinationClass,
  type BackupVerification,
} from "../src/server/ownApi/system/backupRepository";

interface Manifest {
  startedAt?: string;
  finishedAt?: string;
  dumpPresent?: boolean;
  configPresent?: boolean;
  secretsPresent?: boolean;
  dumpBytes?: number;
  schemaVersion?: string;
  schemaCount?: number;
  liveTables?: number;
  verifiedTables?: number;
  verification?: string;
  destinationClass?: string;
  failureClass?: string;
  failureDetail?: string;
}

const DESTINATIONS: BackupDestinationClass[] = [
  "local-protected",
  "removable",
  "remote",
];
const VERIFICATIONS: BackupVerification[] = [
  "unverified",
  "verified",
  "failed",
];

/** An unrecognised value becomes the cautious one rather than being trusted. */
function destinationClass(value: string | undefined): BackupDestinationClass {
  return DESTINATIONS.find((known) => known === value) ?? "local-protected";
}

function verification(value: string | undefined): BackupVerification {
  return VERIFICATIONS.find((known) => known === value) ?? "unverified";
}

function timestamp(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

async function main(): Promise<void> {
  const manifestPath = process.argv[2];
  if (!manifestPath) {
    throw new Error("Usage: record-backup-run.ts <manifest.json>");
  }

  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Manifest;

  const pool = createDatabasePool(parseDatabaseConfig({ ...process.env }));
  try {
    const run = await createBackupRepository(pool).record({
      // A manifest exists only because a run finished; a run that died leaves
      // none, and is absent from the history rather than misreported as good.
      state: manifest.failureClass ? "failed" : "succeeded",
      destinationClass: destinationClass(manifest.destinationClass),
      dumpPresent: manifest.dumpPresent ?? (manifest.dumpBytes ?? 0) > 0,
      configPresent: manifest.configPresent ?? false,
      secretsPresent: manifest.secretsPresent ?? false,
      verification: verification(manifest.verification),
      ...(manifest.dumpBytes !== undefined
        ? { dumpBytes: manifest.dumpBytes }
        : {}),
      ...(manifest.schemaVersion
        ? { schemaVersion: manifest.schemaVersion }
        : {}),
      ...(manifest.schemaCount !== undefined
        ? { schemaCount: manifest.schemaCount }
        : {}),
      ...(manifest.verifiedTables !== undefined
        ? { verifiedTables: manifest.verifiedTables }
        : {}),
      ...(manifest.liveTables !== undefined
        ? { liveTables: manifest.liveTables }
        : {}),
      ...(manifest.failureClass ? { failureClass: manifest.failureClass } : {}),
      ...(manifest.failureDetail
        ? { failureDetail: manifest.failureDetail }
        : {}),
      ...(timestamp(manifest.startedAt) !== undefined
        ? { startedAtMs: timestamp(manifest.startedAt)! }
        : {}),
      ...(timestamp(manifest.finishedAt) !== undefined
        ? { finishedAtMs: timestamp(manifest.finishedAt)! }
        : {}),
    });
    console.info(
      `Recorded backup run ${run.id}: ${run.state}, ${run.verification}.`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(
    "Recording the backup run failed:",
    error instanceof Error ? error.message : "Unknown error",
  );
  process.exitCode = 1;
});
