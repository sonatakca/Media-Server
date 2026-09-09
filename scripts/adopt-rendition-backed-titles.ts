/**
 * Gives a catalogue back the titles whose source bytes are already gone.
 *
 * A title that has been fully processed keeps a complete adaptive package and,
 * eventually, loses the source file it was built from. The scanner recognises
 * that state and marks the item `renditionBacked`, but reconciliation
 * deliberately refuses to create an item from the marker alone: a version 1
 * manifest records the renditions, not the original file, so there is nothing
 * to build a `media_files` row from — and playback and adaptive-asset
 * authorization both resolve through that row. An item without one would be a
 * title that lists but cannot play.
 *
 * That rule is right, and this does not weaken it. It supplies the missing
 * fact instead, from the rendition registry the processing runs actually wrote:
 * `relativePath`, `size` and `mtimeMs` for the source, keyed by the same
 * `sourceFingerprint` the package manifest carries. A title whose fingerprint
 * is not in a registry is reported and skipped, never guessed at.
 *
 * The row it writes describes a file that is not on disk, which is the state
 * the reconciler already documents and keeps: the package is the playable
 * artefact, and the row is the identity everything else resolves through.
 *
 * Idempotent, so a second run is a no-op: items go in by `sourceKey` and files
 * by `relativePath`, and once both exist an ordinary scan preserves them
 * without this script.
 *
 * Default is a dry run. Pass `--apply` to write.
 */
import { readFile } from "node:fs/promises";
import { createDatabasePool } from "../src/server/ownApi/database/databasePool";
import { parseDatabaseConfig } from "../src/server/ownApi/database/databaseConfig";
import { createCatalogueScanStore } from "../src/server/ownApi/catalogue/catalogueScanStore";
import { createLibraryRepository } from "../src/server/ownApi/libraries/libraryRepository";
import {
  buildFingerprint,
  scanLibraryTree,
  type ScannedItem,
} from "../src/server/ownApi/scanner/libraryScan";
import { createNodeScannerFileSystem } from "../src/server/ownApi/scanner/nodeFileSystem";

interface RegistryEntry {
  relativePath: string;
  size: number;
  mtimeMs: number;
  sourceFingerprint: string;
}

/** Only the fields this needs; the manifest carries a great deal more. */
interface PackageManifest {
  sourceFingerprint?: unknown;
}

function isRegistryEntry(value: unknown): value is RegistryEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.relativePath === "string" &&
    entry.relativePath !== "" &&
    typeof entry.size === "number" &&
    Number.isFinite(entry.size) &&
    entry.size > 0 &&
    typeof entry.mtimeMs === "number" &&
    Number.isFinite(entry.mtimeMs) &&
    typeof entry.sourceFingerprint === "string" &&
    entry.sourceFingerprint !== ""
  );
}

/**
 * Loads registries in order, first reading winning.
 *
 * Two of these exist — one beside the media, one in the generated store — and
 * they overlap. Whichever is named first is the one the operator considers
 * current, so a later file may add entries but never redefine one.
 */
async function loadRegistries(
  paths: readonly string[],
): Promise<Map<string, RegistryEntry>> {
  const entries = new Map<string, RegistryEntry>();
  for (const path of paths) {
    let document: unknown;
    try {
      document = JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      console.warn(
        `  registry unreadable, skipped: ${path} (${error instanceof Error ? error.message : "unknown"})`,
      );
      continue;
    }
    const items = (document as { items?: unknown }).items;
    if (!Array.isArray(items)) {
      console.warn(`  registry has no items array, skipped: ${path}`);
      continue;
    }
    let added = 0;
    for (const item of items) {
      if (!isRegistryEntry(item)) continue;
      if (entries.has(item.sourceFingerprint)) continue;
      entries.set(item.sourceFingerprint, item);
      added += 1;
    }
    console.info(`  registry ${path}: ${added} new fingerprint(s)`);
  }
  return entries;
}

function containerOf(relativePath: string): string {
  const dot = relativePath.lastIndexOf(".");
  const slash = relativePath.lastIndexOf("/");
  return dot > slash + 1 ? relativePath.slice(dot + 1).toLowerCase() : "";
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const registryPaths = process.argv
    .filter((argument) => argument.startsWith("--registry="))
    .map((argument) => argument.slice("--registry=".length));

  if (registryPaths.length === 0) {
    throw new Error(
      "At least one --registry=<path to registry.json> is required.",
    );
  }

  const mediaRoot = process.env.SEYIRLIK_MEDIA_ROOT?.trim();
  if (!mediaRoot) throw new Error("SEYIRLIK_MEDIA_ROOT is required.");

  console.info(apply ? "Applying." : "Dry run; pass --apply to write.");
  const registry = await loadRegistries(registryPaths);
  console.info(`Registry holds ${registry.size} source fingerprint(s).`);

  const pool = createDatabasePool(parseDatabaseConfig({ ...process.env }));
  try {
    const store = createCatalogueScanStore(pool);
    const fileSystem = createNodeScannerFileSystem(mediaRoot);
    let adopted = 0;
    let uncovered = 0;

    for (const library of await createLibraryRepository(pool).listAll()) {
      for (const rootPath of library.roots) {
        const scan = await scanLibraryTree({
          fileSystem,
          rootPath,
          kind: library.kind,
        });
        const backed = scan.items.filter(
          (item: ScannedItem) => item.renditionBacked,
        );
        console.info(
          `\n${library.slug}/${rootPath}: ${scan.items.length} item(s), ${backed.length} rendition-backed`,
        );

        for (const item of backed) {
          if (!item.packageDirectory) {
            console.warn(`  ? ${item.title}: no package directory reported`);
            uncovered += 1;
            continue;
          }

          let fingerprint: string | null = null;
          try {
            const manifest = JSON.parse(
              await fileSystem.readTextFile(
                `${item.packageDirectory}/.seyirlik/package.json`,
              ),
            ) as PackageManifest;
            fingerprint =
              typeof manifest.sourceFingerprint === "string"
                ? manifest.sourceFingerprint
                : null;
          } catch {
            fingerprint = null;
          }

          const source = fingerprint ? registry.get(fingerprint) : undefined;
          if (!source) {
            // Reported rather than invented. A title nobody can name a source
            // for stays out of the catalogue, which is the existing behaviour.
            console.warn(
              `  ? ${item.title}: no registry entry for ${fingerprint ? fingerprint.slice(0, 16) : "an unreadable manifest"}`,
            );
            uncovered += 1;
            continue;
          }

          console.info(
            `  + ${item.title} -> ${source.relativePath} (${source.size} bytes)`,
          );
          adopted += 1;
          if (!apply) continue;

          const itemId = await store.upsertItem({
            libraryId: library.id,
            sourceKey: item.sourceKey,
            kind: item.kind,
            title: item.title,
            sortTitle: item.sortTitle,
            year: item.year,
            indexNumber: item.indexNumber,
            parentIndexNumber: item.parentIndexNumber,
            lockedFields: [],
          });
          await store.upsertFile({
            itemId,
            relativePath: source.relativePath,
            container: containerOf(source.relativePath),
            size: source.size,
            /*
             * The scanner's own fingerprint, recomputed from the same three
             * inputs. Taking the registry's `sourceFingerprint` instead would
             * store a value from a different scheme, and the next scan would
             * read the row as changed.
             */
            mtimeMs: source.mtimeMs,
            fingerprint: buildFingerprint(
              source.relativePath,
              source.size,
              source.mtimeMs,
            ),
            isPrimary: true,
          });
        }
      }
      if (apply) await store.refreshItemCounts(library.id);
    }

    console.info(
      `\n${apply ? "Adopted" : "Would adopt"} ${adopted} title(s); ${uncovered} without recoverable provenance.`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(
    "Adopting rendition-backed titles failed:",
    error instanceof Error ? error.message : "Unknown error",
  );
  process.exitCode = 1;
});
