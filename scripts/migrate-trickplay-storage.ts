import path from "node:path";
import { createCatalogueRepository } from "../src/server/ownApi/catalogue/catalogueRepository";
import { createDatabasePool } from "../src/server/ownApi/database/databasePool";
import { parseDatabaseConfig } from "../src/server/ownApi/database/databaseConfig";
import {
  migrateLegacyTrickplaySets,
  type MigrationOutcome,
} from "../src/server/ownApi/trickplay/trickplayMigration";

/**
 * Moves this server's own older trickplay sets out of the central UUID tree and
 * into the title folders they belong to.
 *
 *   npm run media:trickplay:migrate -- --dry-run
 *   npm run media:trickplay:migrate
 *
 * Only sets whose row still carries a `storage_prefix` are considered, so a
 * second run is cheap and does nothing. The old directory for a set is removed
 * only after its bytes have been copied into the title folder, read back,
 * compared file by file, published, and recorded — in that order.
 *
 * This has nothing to do with the Jellyfin-era `*.trickplay` folders. Those are
 * external, they belong to the operator's archive, and they are handled by
 * `npm run maintenance:archive-legacy-trickplay`.
 */

interface Options {
  dryRun: boolean;
  mediaRoot: string;
  generatedStoragePath: string;
}

function parseArguments(argv: string[]): Options {
  let dryRun = false;
  let mediaRoot = process.env.SEYIRLIK_MEDIA_ROOT ?? "";
  let generatedStoragePath = process.env.SEYIRLIK_GENERATED_STORAGE ?? "";

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--dry-run") dryRun = true;
    else if (argument === "--media-root") mediaRoot = argv[++index] ?? "";
    else if (argument === "--generated-storage")
      generatedStoragePath = argv[++index] ?? "";
    else if (argument !== undefined) {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (!mediaRoot) {
    throw new Error(
      "No media root. Set SEYIRLIK_MEDIA_ROOT or pass --media-root.",
    );
  }
  if (!generatedStoragePath) {
    throw new Error(
      "No generated storage. Set SEYIRLIK_GENERATED_STORAGE or pass --generated-storage.",
    );
  }
  return {
    dryRun,
    mediaRoot: path.resolve(mediaRoot),
    generatedStoragePath: path.resolve(generatedStoragePath),
  };
}

function describe(outcome: MigrationOutcome): void {
  console.info(
    `  ${outcome.status.toUpperCase().padEnd(18)} ${outcome.relativePath ?? outcome.setId}`,
  );
  if (outcome.to) console.info(`  ${" ".repeat(18)} → ${outcome.to}`);
  if (outcome.detail) console.info(`  ${" ".repeat(18)}   ${outcome.detail}`);
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const config = parseDatabaseConfig({ ...process.env });
  if (!config) throw new Error("Native database configuration is unavailable.");

  const pool = createDatabasePool(config);
  try {
    const catalogue = createCatalogueRepository(pool);

    console.info(`Media root:        ${options.mediaRoot}`);
    console.info(`Generated storage: ${options.generatedStoragePath}`);
    console.info(
      options.dryRun
        ? "Mode:              dry run — nothing is copied or removed"
        : "Mode:              LIVE — verified old directories will be removed",
    );
    console.info("");

    const report = await migrateLegacyTrickplaySets({
      pool,
      catalogue,
      mediaRoot: options.mediaRoot,
      generatedStoragePath: options.generatedStoragePath,
      dryRun: options.dryRun,
      onProgress: describe,
    });

    const count = (status: MigrationOutcome["status"]) =>
      report.outcomes.filter((outcome) => outcome.status === status).length;

    console.info("");
    console.info(`Sets considered:   ${report.outcomes.length}`);
    console.info(
      `${options.dryRun ? "Would migrate:     " : "Migrated:          "}${count("migrated")}`,
    );
    console.info(`Already migrated:  ${count("already-migrated")}`);
    console.info(`Source missing:    ${count("source-missing")}`);
    console.info(`Conflicts:         ${count("conflict")}`);
    console.info(`Unresolvable:      ${count("unresolvable")}`);
    console.info(`Invalid source:    ${count("invalid-source")}`);
    console.info(`Failed:            ${count("failed")}`);
    if (report.legacyRootRemoved) {
      console.info(`The old central trickplay root was empty and was removed.`);
    }
    /*
     * Reported, never removed. A UUID directory with no row behind it has no
     * media file to resolve a destination from, so this command cannot place
     * it — and it is why the old root can survive a run in which every set
     * succeeded. Saying so beats leaving an operator to wonder.
     */
    if (report.orphanDirectories.length > 0) {
      console.info("");
      console.info(
        `Directories no row claims: ${report.orphanDirectories.length}`,
      );
      for (const name of report.orphanDirectories) {
        console.info(`  ${name}`);
      }
      console.info(
        "These were left untouched. They belong to sets that are no longer in the",
      );
      console.info(
        `database, so ${report.legacyRoot} was kept. Remove them by hand once you are satisfied.`,
      );
    }

    const unfinished =
      count("conflict") +
      count("unresolvable") +
      count("invalid-source") +
      count("failed") +
      count("source-missing");
    if (unfinished > 0) {
      console.info("");
      console.info(
        "Some sets were not migrated. Every old directory involved was left exactly where it was.",
      );
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(
    "Trickplay storage migration failed:",
    error instanceof Error ? error.message : "Unknown error",
  );
  process.exitCode = 1;
});
