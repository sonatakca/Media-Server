import { createDatabasePool } from "../src/server/ownApi/database/databasePool";
import { parseDatabaseConfig } from "../src/server/ownApi/database/databaseConfig";
import { createLibraryRepository } from "../src/server/ownApi/libraries/libraryRepository";
import { createCatalogueScanStore } from "../src/server/ownApi/catalogue/catalogueScanStore";
import { createQueuedWorkRetargeter } from "../src/server/ownApi/processing/retargetQueuedWork";
import { createNodeOrganizerFileSystem } from "../src/server/ownApi/scanner/nodeFileSystem";
import {
  applyOrganizationPlan,
  planLibraryOrganization,
  type OrganizePlan,
} from "../src/server/ownApi/scanner/organizeLibrary";
import type { LibraryKind } from "../src/server/ownApi/scanner/libraryScan";
import type { DatabasePool } from "../src/server/ownApi/database/databasePool";

/**
 * Reads a real media volume and prints exactly what organising it would move.
 *
 * This is the step to take before `SEYIRLIK_MEDIA_ORGANIZE=apply` goes into the
 * environment: the same planner the scan uses, against the same folders, with
 * `--apply` as the only thing that writes anything.
 */

interface Options {
  apply: boolean;
  root?: string;
  kind: LibraryKind;
  limit: number;
}

function parseArguments(argv: string[]): Options {
  const options: Options = { apply: false, kind: "mixed", limit: Infinity };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--apply") options.apply = true;
    else if (argument === "--root") options.root = argv[++index];
    else if (argument === "--kind") options.kind = argv[++index] as LibraryKind;
    else if (argument === "--limit") options.limit = Number(argv[++index]);
    else if (argument !== undefined) {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

function describe(plan: OrganizePlan, limit: number): void {
  if (plan.moves.length === 0) {
    console.info("  Nothing to move — this library is already organised.");
  }
  for (const move of plan.moves.slice(0, limit)) {
    console.info(`  ${move.reason.padEnd(8)} ${move.from}`);
    console.info(`  ${" ".repeat(8)}   → ${move.to}`);
  }
  if (plan.moves.length > limit) {
    console.info(`  … and ${plan.moves.length - limit} more.`);
  }
  for (const skip of plan.skipped) {
    console.info(`  SKIPPED  ${skip.relativePath} (${skip.reason})`);
  }
}

function connectIfConfigured(): DatabasePool | null {
  try {
    return createDatabasePool(parseDatabaseConfig({ ...process.env }));
  } catch {
    return null;
  }
}

/**
 * Live processing work, which is what `--apply` must never move the ground
 * under.
 *
 * A running encode re-opens its source at every epoch boundary. A queued
 * attempt froze an absolute source path into its queue row when it was queued,
 * and nothing re-reads it. Both are answered by the same question.
 */
async function liveProcessingWork(pool: DatabasePool): Promise<number> {
  const result = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM jobs
      WHERE job_type = 'media.process' AND status IN ('queued', 'running')`,
  );
  return result.rows[0]?.count ?? 0;
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const mediaRoot = process.env.SEYIRLIK_MEDIA_ROOT;
  if (!mediaRoot) {
    throw new Error("SEYIRLIK_MEDIA_ROOT is not set.");
  }

  const fileSystem = createNodeOrganizerFileSystem(mediaRoot);
  /*
   * The catalogue is consulted for three things: which roots to walk, moving
   * the file rows with the files, and refusing to move anything while there is
   * live processing work. Only `--root` on a copy runs without it — which is
   * how this is rehearsed before it is pointed at the real volume.
   */
  const pool = connectIfConfigured();

  const explicitRoot = options.root;

  try {
    const libraries =
      explicitRoot === undefined && pool !== null
        ? await createLibraryRepository(pool).listAll()
        : [
            {
              id: "",
              slug: explicitRoot ?? "",
              name: explicitRoot ?? "",
              kind: options.kind,
              roots: [explicitRoot ?? ""],
            },
          ];

    const store = pool ? createCatalogueScanStore(pool) : null;

    if (options.apply && pool) {
      const live = await liveProcessingWork(pool);
      if (live > 0) {
        throw new Error(
          `${live} processing attempt(s) are queued or running. Each one holds ` +
            `the path of its source, and a running encode re-opens that path ` +
            `every few minutes — so nothing will be moved. Let the queue drain, ` +
            `or pause it, and run this again.`,
        );
      }
    }
    if (options.apply && !pool) {
      console.info(
        "No catalogue is attached: neither the processing queue nor the file rows will be checked or updated.",
      );
    }

    let totalMoves = 0;
    let totalApplied = 0;

    for (const library of libraries) {
      for (const root of library.roots) {
        console.info(`\n${library.name} — ${root} (${library.kind})`);
        const plan = await planLibraryOrganization({
          fileSystem,
          rootPath: root,
          kind: library.kind,
        });
        totalMoves += plan.moves.length;
        describe(plan, options.limit);

        if (!options.apply || plan.moves.length === 0) continue;

        // Asked again immediately before the first rename of this root: the
        // plan above walks a whole library, which is long enough for somebody
        // to press Process in the admin page while it runs.
        if (pool && (await liveProcessingWork(pool)) > 0) {
          throw new Error(
            "Processing work started while the plan was being built. Nothing " +
              "further has been moved.",
          );
        }

        const applied = await applyOrganizationPlan(fileSystem, plan);
        totalApplied += applied.moved.length;
        const recorded = store ? await store.recordMoves(applied.moved) : 0;
        if (pool) {
          await createQueuedWorkRetargeter(pool).retarget(applied.moved);
        }
        console.info(
          `  Moved ${applied.moved.length}, failed ${applied.failed.length}, catalogue rows updated ${recorded}.`,
        );
        for (const failure of applied.failed) {
          console.info(`  FAILED   ${failure.move.from}: ${failure.error}`);
        }
      }
    }

    console.info(
      options.apply
        ? `\nMoved ${totalApplied} of ${totalMoves} planned file(s).`
        : `\n${totalMoves} file(s) would move. Re-run with --apply to carry it out.`,
    );
    if (!options.apply && totalMoves > 0 && !store) {
      console.info(
        "Note: no catalogue is attached, so --apply would move files without moving their rows.",
      );
    }
  } finally {
    await pool?.end();
  }
}

main().catch((error) => {
  console.error(
    "Organising the media folders failed:",
    error instanceof Error ? error.message : "Unknown error",
  );
  process.exitCode = 1;
});
