import path from "node:path";
import {
  archiveLegacyTrickplay,
  ArchiveRootError,
  summariseArchiveReport,
  type ArchiveOutcome,
  type ArchivePhase,
} from "../src/server/ownApi/trickplay/legacyTrickplayArchive";

/**
 * Takes the Jellyfin-era `*.trickplay` folders out of the media library and
 * keeps a verified copy of every one of them.
 *
 * This is the destructive half of the trickplay redesign and is deliberately a
 * command a person runs, never something a scan or a startup does. Run it with
 * `--dry-run` first and read the plan; the real run copies each folder, reads
 * the copy back and compares it to the original by SHA-256, and removes the
 * original only for the folders that verified.
 *
 *   npm run maintenance:archive-legacy-trickplay -- \
 *     --archive-root /Volumes/Expansion/old-trickplays --dry-run
 *
 *   npm run maintenance:archive-legacy-trickplay -- \
 *     --archive-root /Volumes/Expansion/old-trickplays
 *
 * The archive root is required and is never defaulted: this command deletes
 * from a real library, and where the copies go is the operator's decision, not
 * a constant compiled into the server.
 */

interface Options {
  archiveRoot: string;
  mediaRoot: string;
  dryRun: boolean;
  limit: number;
  verbose: boolean;
}

function parseArguments(argv: string[]): Options {
  let archiveRoot: string | undefined;
  let mediaRoot = process.env.SEYIRLIK_MEDIA_ROOT ?? "";
  let dryRun = false;
  let limit = Infinity;
  let verbose = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--dry-run") dryRun = true;
    else if (argument === "--verbose") verbose = true;
    else if (argument === "--archive-root") archiveRoot = argv[++index];
    else if (argument === "--media-root") mediaRoot = argv[++index] ?? "";
    else if (argument === "--limit") limit = Number(argv[++index]);
    else if (argument !== undefined) {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (!archiveRoot) {
    throw new Error(
      "--archive-root is required, for example --archive-root /Volumes/Expansion/old-trickplays",
    );
  }
  if (!mediaRoot) {
    throw new Error(
      "No media root. Set SEYIRLIK_MEDIA_ROOT or pass --media-root.",
    );
  }
  return {
    archiveRoot: path.resolve(archiveRoot),
    mediaRoot: path.resolve(mediaRoot),
    dryRun,
    limit,
    verbose,
  };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

function describe(outcome: ArchiveOutcome, verbose: boolean): void {
  const label = outcome.status.toUpperCase().padEnd(17);
  if (outcome.status === "archived" || outcome.status === "already-archived") {
    if (!verbose) return;
    console.info(`  ${label} ${outcome.relativePath}`);
    return;
  }
  console.info(`  ${label} ${outcome.relativePath}`);
  if (outcome.detail) console.info(`  ${" ".repeat(17)} ${outcome.detail}`);
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));

  console.info(`Media root:      ${options.mediaRoot}`);
  console.info(`Archive root:    ${options.archiveRoot}`);
  console.info(
    options.dryRun
      ? "Mode:            dry run — nothing is copied, nothing is removed"
      : "Mode:            LIVE — verified originals will be removed",
  );
  console.info("");

  let lastPhase: ArchivePhase | "" = "";
  const report = await archiveLegacyTrickplay({
    mediaRoot: options.mediaRoot,
    archiveRoot: options.archiveRoot,
    dryRun: options.dryRun,
    limit: options.limit,
    onPhase: (phase) => {
      if (options.dryRun || phase === lastPhase) return;
      lastPhase = phase;
      console.info(`[${phase}]`);
    },
    onOutcome: (outcome) =>
      describe(outcome, options.verbose || options.dryRun),
  });

  const counts = summariseArchiveReport(report);
  console.info("");
  console.info(`Legacy directories discovered: ${counts.discovered}`);
  console.info(`Files:                         ${counts.files}`);
  console.info(`Bytes:                         ${formatBytes(counts.bytes)}`);
  console.info(`Already archived:              ${counts.alreadyArchived}`);
  console.info(`Conflicts:                     ${counts.conflicts}`);
  console.info(`Unsafe paths:                  ${counts.unsafe}`);
  console.info(`Failures:                      ${counts.failed}`);
  if (!options.dryRun) {
    console.info(`Archived and verified:         ${counts.archived}`);
    console.info(
      `Originals removed:             ${counts.archived + counts.alreadyArchived}`,
    );
  } else {
    console.info(`Would archive:                 ${counts.archived}`);
  }

  /*
   * A partially successful run must never read as a success. The exit code is
   * what a shell script or a person scrolling past the output actually reads.
   */
  if (counts.conflicts + counts.unsafe + counts.failed > 0) {
    console.info("");
    console.info(
      "Some directories were not archived. Every original involved was left exactly where it was.",
    );
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  if (error instanceof ArchiveRootError) {
    console.error(`Refusing to run: ${error.message}`);
  } else {
    console.error(
      "Legacy trickplay archival failed:",
      error instanceof Error ? error.message : "Unknown error",
    );
  }
  process.exitCode = 1;
});
