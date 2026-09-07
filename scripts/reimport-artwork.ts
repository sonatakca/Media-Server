import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import {
  createDatabasePool,
  type DatabasePool,
} from "../src/server/ownApi/database/databasePool";
import { parseDatabaseConfig } from "../src/server/ownApi/database/databaseConfig";
import {
  createImageStorage,
  type TitleArtworkType,
} from "../src/server/ownApi/images/imageStorage";
import { createMetadataRepository } from "../src/server/ownApi/metadata/metadataRepository";
import { PROVIDER_ARTWORK_SIZES } from "../src/server/ownApi/metadata/providerArtworkSizes";
import {
  createTmdbClient,
  type TmdbArtworkCandidate,
  type TmdbClient,
} from "../src/server/ownApi/metadata/tmdbClient";

/**
 * Re-imports every stored cover, backdrop and logo at the provider's original
 * size.
 *
 * Artwork imported before the size fix was fetched at TMDB's pre-scaled widths
 * — a 1280px backdrop behind a 1920px hero, a 500px logo behind an 1100px one —
 * and no re-encoding recovers detail the download never carried. The fix only
 * helps titles imported from now on, so everything already on disk has to be
 * fetched again.
 *
 * The picture each title shows must not change, only its resolution, and the
 * provider's ordering is not stable enough to trust for that: a third of the
 * library's backdrops have moved position since they were imported. So every
 * upgrade is matched by content instead. The stored file is reduced to a small
 * grayscale signature and compared against the provider's candidates; a
 * candidate is only accepted when it is unmistakably the same image, and a row
 * with no confident match is reported rather than quietly replaced.
 *
 * That sweep costs a few hundred thumbnail downloads per image and well over
 * an hour for a whole library, which is the right trade for a migration that
 * runs once: the alternative is trusting an ordering that has demonstrably
 * moved. Run it without `--apply` first — it prints exactly what it would
 * fetch and changes nothing.
 */

interface Options {
  apply: boolean;
  limit: number;
  itemId?: string;
}

/** The furthest a candidate may sit and still be called the same image. */
const MATCH_DISTANCE = 8;
/**
 * How far past the closest candidate still counts as the same image.
 *
 * TMDB routinely holds one picture as several uploads at different
 * resolutions, and those siblings score a hair apart rather than identically —
 * so a near tie means "the same image again", not an ambiguous match.
 */
const SAME_IMAGE_MARGIN = 4;
/**
 * Candidates are compared at a thumbnail size; only the winner is fetched at
 * full resolution. The stored file is stepped down to the same width first, so
 * both sides of a comparison have travelled the same road.
 */
const COMPARE_WIDTH = 185;
const COMPARE_SIZE = `w${COMPARE_WIDTH}`;
/** Enough parallel thumbnails to sweep a title quickly, few enough to be polite. */
const COMPARE_CONCURRENCY = 8;

function parseArguments(argv: string[]): Options {
  const options: Options = { apply: false, limit: Infinity };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--apply") options.apply = true;
    else if (argument === "--limit") options.limit = Number(argv[++index]);
    else if (argument === "--item") options.itemId = argv[++index];
    else if (argument !== undefined) {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

interface ArtworkRow {
  id: string;
  item_id: string;
  title: string;
  kind: string;
  image_type: TitleArtworkType;
  image_index: number;
  storage_key: string;
  content_hash: string;
  size_bytes: string | number;
  source_url: string | null;
}

/**
 * A 12x12 grayscale reduction of an image.
 *
 * Coarse on purpose: it has to survive a resize between 500px and 3840px and a
 * JPEG re-encode without moving, while still separating two different frames
 * from the same film. Alpha is flattened rather than dropped, because a logo's
 * transparent pixels otherwise carry whatever colour happened to be under them.
 *
 * Every image is stepped down through the comparison width first, even one
 * already that small. Going straight from 2000px to 12px lands somewhere
 * measurably different from going via 185px, and on a detailed poster that gap
 * alone was enough to make a file fail to recognise itself.
 */
async function signature(input: Buffer | string): Promise<number[]> {
  const staged = await sharp(input, { limitInputPixels: 40_000_000 })
    .resize({ width: COMPARE_WIDTH, fit: "inside", withoutEnlargement: true })
    .toBuffer();
  const raw = await sharp(staged)
    .resize(12, 12, { fit: "fill" })
    .flatten({ background: "#000000" })
    .grayscale()
    .raw()
    .toBuffer();
  return [...raw];
}

function distance(left: number[], right: number[]): number {
  let total = 0;
  for (let index = 0; index < left.length; index += 1) {
    total += Math.abs((left[index] ?? 0) - (right[index] ?? 0));
  }
  return total / left.length;
}

/**
 * Compares one candidate against the stored image, retrying once.
 *
 * A comparison that fails to download is indistinguishable from one that does
 * not match, and a whole title's sweep failing that way reads as "no candidate
 * matches" — which would leave the artwork un-upgraded for a reason that has
 * nothing to do with the artwork.
 */
async function distanceToCandidate(
  tmdb: TmdbClient,
  local: number[],
  filePath: string,
): Promise<number> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(tmdb.buildImageUrl(filePath, COMPARE_SIZE));
      if (response.ok) {
        return distance(
          local,
          await signature(Buffer.from(await response.arrayBuffer())),
        );
      }
    } catch {
      // Retried below; a second failure is reported as no match.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return Infinity;
}

/** Scores every candidate, a few at a time rather than one after another. */
async function scoreCandidates(
  tmdb: TmdbClient,
  local: number[],
  candidates: TmdbArtworkCandidate[],
): Promise<Scored[]> {
  const scored: Scored[] = [];
  for (let start = 0; start < candidates.length; start += COMPARE_CONCURRENCY) {
    const batch = candidates.slice(start, start + COMPARE_CONCURRENCY);
    scored.push(
      ...(await Promise.all(
        batch.map(async (candidate) => ({
          filePath: candidate.filePath,
          width: candidate.width ?? 0,
          distance: await distanceToCandidate(tmdb, local, candidate.filePath),
        })),
      )),
    );
  }
  return scored;
}

interface Scored {
  filePath: string;
  width: number;
  distance: number;
}

interface Resolution {
  filePath: string;
  width: number;
  siblings: number;
}

function candidateKindFor(imageType: TitleArtworkType): string {
  return imageType === "cover" ? "poster" : imageType;
}

/**
 * The largest provider file holding the image this row already stores.
 *
 * Every candidate is compared rather than trusting the provider's ordering,
 * which a third of this library's backdrops have already moved within. The
 * matches then cluster: one picture, uploaded two or three times at different
 * resolutions. Taking the widest of that cluster is the whole point — it is
 * the same image the title shows today, at the largest size TMDB holds.
 */
async function resolveSameImage(
  row: ArtworkRow,
  local: number[],
  tmdb: TmdbClient,
  providerId: string,
  candidateCache: Map<string, TmdbArtworkCandidate[]>,
): Promise<Resolution | { failure: string }> {
  const cacheKey = `${row.kind}:${providerId}`;
  let candidates = candidateCache.get(cacheKey);
  if (!candidates) {
    candidates = await tmdb.listArtwork(
      row.kind === "series" ? "tv" : "movie",
      providerId,
    );
    candidateCache.set(cacheKey, candidates);
  }

  const wanted = candidateKindFor(row.image_type);
  const scored = await scoreCandidates(
    tmdb,
    local,
    candidates.filter((candidate) => candidate.kind === wanted),
  );
  scored.sort((left, right) => left.distance - right.distance);

  const closest = scored[0];
  if (!closest || closest.distance > MATCH_DISTANCE) {
    return { failure: "no candidate matches the stored image" };
  }

  const sameImage = scored.filter(
    (candidate) => candidate.distance - closest.distance <= SAME_IMAGE_MARGIN,
  );
  // Widest first, and the closest match wherever the provider states no width
  // at all — an unknown width must not beat a known one on a zero.
  const widest = sameImage.reduce((best, candidate) =>
    candidate.width > best.width ? candidate : best,
  );
  return {
    filePath: widest.filePath,
    width: widest.width,
    siblings: sameImage.length,
  };
}

function importSizeFor(imageType: TitleArtworkType): string {
  if (imageType === "cover") return PROVIDER_ARTWORK_SIZES.poster;
  if (imageType === "logo") return PROVIDER_ARTWORK_SIZES.logo;
  return PROVIDER_ARTWORK_SIZES.backdrop;
}

/**
 * Brings a row back in step with the file it points at.
 *
 * The content hash is the cache validator every artwork URL carries, so a row
 * describing bytes that are no longer on disk hands clients a tag that never
 * changes while the picture underneath it does. Rows drift this way whenever a
 * file is replaced outside the import path.
 */
async function reconcileRow(
  pool: { query: DatabasePool["query"] },
  row: ArtworkRow,
  bytes: Buffer,
  apply: boolean,
): Promise<boolean> {
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (hash === row.content_hash && Number(row.size_bytes) === bytes.length) {
    return false;
  }
  if (apply) {
    await pool.query(
      `UPDATE item_images SET content_hash = $2, size_bytes = $3 WHERE id = $1`,
      [row.id, hash, bytes.length],
    );
  }
  return true;
}

function requireEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not configured.`);
  return value;
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const apiKey = requireEnvironment("SEYIRLIK_TMDB_API_KEY");
  const mediaRoot = requireEnvironment("SEYIRLIK_MEDIA_ROOT");
  const generatedStorage = requireEnvironment("SEYIRLIK_GENERATED_STORAGE");

  const config = parseDatabaseConfig({ ...process.env });
  if (!config) throw new Error("Native database configuration is unavailable.");

  const pool = createDatabasePool(config);
  const tmdb = createTmdbClient({ apiKey });
  const imageStorage = createImageStorage({
    imageRoot: path.join(generatedStorage, "images"),
    mediaRoot,
  });
  const metadata = createMetadataRepository(pool);

  try {
    const rows = await pool.query<ArtworkRow>(
      `SELECT item_images.id, item_images.item_id, items.title, items.kind,
              item_images.image_type, item_images.image_index,
              item_images.storage_key, item_images.content_hash,
              item_images.size_bytes, item_images.source_url
       FROM item_images
       JOIN items ON items.id = item_images.item_id
       WHERE item_images.image_type IN ('cover', 'backdrop', 'logo')
         AND item_images.source = 'tmdb'
         ${options.itemId ? "AND item_images.item_id = $1" : ""}
       ORDER BY items.title, item_images.image_type`,
      options.itemId ? [options.itemId] : [],
    );

    const candidateCache = new Map<string, TmdbArtworkCandidate[]>();
    const summary = {
      upgraded: 0,
      unchanged: 0,
      reconciled: 0,
      skipped: 0,
      failed: 0,
    };

    for (const row of rows.rows.slice(0, options.limit)) {
      const label = `${row.title} ${row.image_type}`.padEnd(52);

      const target = await metadata.getTarget(row.item_id);
      const providerId = target?.providerIds.tmdb;
      if (!target || !providerId) {
        console.info(`  SKIP      ${label} no TMDB id`);
        summary.skipped += 1;
        continue;
      }

      let resolved: Resolution | { failure: string };
      let localWidth: number | undefined;
      try {
        const localBytes = await readFile(
          imageStorage.resolve(row.storage_key),
        );
        localWidth = (await sharp(localBytes).metadata()).width;
        if (await reconcileRow(pool, row, localBytes, options.apply)) {
          summary.reconciled += 1;
          console.info(
            `  RECORD    ${label} row described ${row.size_bytes}B, file holds ${localBytes.length}B`,
          );
        }
        resolved = await resolveSameImage(
          row,
          await signature(localBytes),
          tmdb,
          providerId,
          candidateCache,
        );
      } catch (error) {
        console.info(
          `  FAILED    ${label} ${error instanceof Error ? error.message : "lookup failed"}`,
        );
        summary.failed += 1;
        continue;
      }

      if ("failure" in resolved) {
        // Never guess: a wrong guess silently replaces the picture a title
        // shows, which is far worse than leaving it at the size it has.
        console.info(`  SKIP      ${label} ${resolved.failure}`);
        summary.skipped += 1;
        continue;
      }

      // The provider sometimes holds the same picture only as a smaller
      // upload than the one already stored. Re-importing that is a downgrade,
      // which is the exact fault this script exists to undo.
      if (
        resolved.width > 0 &&
        localWidth !== undefined &&
        resolved.width <= localWidth
      ) {
        console.info(
          `  SAME      ${label} ${localWidth}px is already the largest`,
        );
        summary.unchanged += 1;
        continue;
      }

      const sourceUrl = tmdb.buildImageUrl(
        resolved.filePath,
        importSizeFor(row.image_type),
      );

      if (!options.apply) {
        console.info(
          `  WOULD GET ${label} ${localWidth ?? "?"}px → ${resolved.width}px (${resolved.siblings} matching upload(s))`,
        );
        console.info(`            ${sourceUrl}`);
        summary.upgraded += 1;
        continue;
      }

      try {
        const stored = target.titleRoot
          ? await imageStorage.fetchAndStoreTitleArtwork(
              sourceUrl,
              target.titleRoot,
              row.image_type,
            )
          : await imageStorage.fetchAndStore(sourceUrl);

        if (stored.contentHash === row.content_hash) {
          console.info(`  SAME      ${label} already the original`);
          summary.unchanged += 1;
          continue;
        }

        await pool.query(
          `UPDATE item_images SET
             content_hash = $2, content_type = $3,
             size_bytes = $4, storage_key = $5, source_url = $6
           WHERE id = $1`,
          [
            row.id,
            stored.contentHash,
            stored.contentType,
            stored.sizeBytes,
            stored.storageKey,
            sourceUrl,
          ],
        );

        const newWidth = (
          await sharp(imageStorage.resolve(stored.storageKey)).metadata()
        ).width;
        console.info(
          `  UPGRADED  ${label} ${localWidth ?? "?"}px → ${newWidth ?? "?"}px`,
        );
        summary.upgraded += 1;
      } catch (error) {
        console.info(
          `  FAILED    ${label} ${error instanceof Error ? error.message : "download failed"}`,
        );
        summary.failed += 1;
      }
    }

    console.info(
      options.apply
        ? `\nUpgraded ${summary.upgraded}, already original ${summary.unchanged}, records corrected ${summary.reconciled}, skipped ${summary.skipped}, failed ${summary.failed}.`
        : `\n${summary.upgraded} image(s) would be re-imported, ${summary.reconciled} record(s) corrected, ${summary.skipped} skipped, ${summary.failed} unreadable. Re-run with --apply to write them.`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(
    "Artwork re-import failed:",
    error instanceof Error ? error.message : "Unknown error",
  );
  process.exitCode = 1;
});
