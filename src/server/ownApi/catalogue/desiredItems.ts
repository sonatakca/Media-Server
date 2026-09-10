/**
 * Titles Seyirlik wants, before any of them is on disk.
 *
 * Monitoring hangs off a catalogue item, and an item used to come into being
 * only because a file was found. That is the right rule for a scanner — it
 * must never invent a title — but it left nowhere to record the thing the
 * legacy applications express constantly: *I want this, and I do not have it.*
 *
 * The identity is the whole point. A desired item is created with the very
 * `source_key` the scanner will derive once the media lands in the library, so
 * the import does not produce a second row to be reconciled against the first:
 * the same item simply acquires files, and its monitoring, profile and history
 * come with it. Getting that key wrong would be worse than having no desired
 * items at all, so it is built from the same two functions the rest of the
 * system uses — `safeSegment` for the folder name the importer will create,
 * and the scanner's own lowercasing for the key.
 */
import { randomUUID } from "node:crypto";
import type { DatabasePool } from "../database/databasePool";
import { safeSegment } from "../imports/importDestination";

export interface DesiredTitleInput {
  readonly libraryId: string;
  /** The library root the media will land in, e.g. `Movies`. */
  readonly libraryRoot: string;
  readonly kind: "movie" | "series";
  readonly title: string;
  readonly year?: number;
  readonly profileId?: string | null;
}

export interface DesiredItem {
  readonly id: string;
  readonly sourceKey: string;
  readonly title: string;
  readonly kind: string;
  readonly desired: boolean;
  readonly hasMedia: boolean;
}

export interface DesireOutcome extends DesiredItem {
  /**
   * Whether this call created the row.
   *
   * A migration that reports "created 15" on every run is not a count anybody
   * can act on. `xmax = 0` is true only for a tuple this statement inserted,
   * which distinguishes a new title from one already wanted.
   */
  readonly created: boolean;
}

/**
 * The folder a title will occupy, as the importer would name it.
 *
 * `Title (Year)` when a year is known, matching every folder already in the
 * library; the year is what tells two films of the same name apart.
 */
export function desiredFolderName(title: string, year?: number): string {
  return year === undefined
    ? safeSegment(title)
    : safeSegment(`${title} (${year})`);
}

/**
 * The key the scanner will produce for that folder.
 *
 * Lower-cased, because `sourceKey` in the scanner lower-cases every part; a
 * key that differs only in case would create the duplicate this exists to
 * prevent.
 */
export function desiredSourceKey(input: {
  kind: "movie" | "series";
  libraryRoot: string;
  title: string;
  year?: number;
}): string {
  const folder = desiredFolderName(input.title, input.year);
  return `${input.kind}:${input.libraryRoot}/${folder}`.toLowerCase();
}

export interface DesiredItemRepository {
  /** Creates the desired title, or returns the item already holding its key. */
  desire(input: DesiredTitleInput): Promise<DesireOutcome>;
  /** Everything wanted, with whether media has since arrived. */
  list(libraryId?: string): Promise<DesiredItem[]>;
  /** Wanted and still without media — the acquisition side's queue. */
  listMissing(): Promise<DesiredItem[]>;
}

interface Row {
  id: string;
  source_key: string;
  title: string;
  kind: string;
  desired: boolean;
  media_count: string | number;
}

function toItem(row: Row): DesiredItem {
  return {
    id: row.id,
    sourceKey: row.source_key,
    title: row.title,
    kind: row.kind,
    desired: row.desired,
    hasMedia: Number(row.media_count) > 0,
  };
}

const SELECT = `SELECT i.id, i.source_key, i.title, i.kind, i.desired,
    (SELECT count(*) FROM media_files f WHERE f.item_id = i.id) AS media_count
  FROM items i`;

export function createDesiredItemRepository(
  pool: Pick<DatabasePool, "query">,
): DesiredItemRepository {
  return {
    async desire(input) {
      const sourceKey = desiredSourceKey({
        kind: input.kind,
        libraryRoot: input.libraryRoot,
        title: input.title,
        year: input.year,
      });

      /*
       * One statement, and the conflict target is the identity the scanner
       * uses. A title that is already in the library is marked desired rather
       * than duplicated — wanting something already held is a legitimate state,
       * and it is what keeps an upgrade decision attached to the same row.
       *
       * `title` is deliberately not overwritten: the catalogue's name for an
       * item it already holds came from the media, and a legacy application's
       * spelling should not rewrite it.
       */
      /*
       * Two statements rather than one, deliberately. A data-modifying CTE's
       * insert is not visible to the SELECT beside it — they share the
       * statement's snapshot — so reading the row back through a CTE returned
       * nothing for every title that was genuinely new, which is precisely the
       * case this function exists for.
       */
      const upserted = await pool.query<{ id: string; inserted: boolean }>(
        `INSERT INTO items
           (id, library_id, kind, source_key, title, sort_title,
            production_year, desired, desired_since)
         VALUES ($1, $2, $3, $4, $5, $6, $7, true, now())
         ON CONFLICT (library_id, source_key) DO UPDATE
            SET desired = true,
                desired_since = COALESCE(items.desired_since, now()),
                missing_since = NULL,
                updated_at = now()
         RETURNING id, (xmax = 0) AS inserted`,
        [
          randomUUID(),
          input.libraryId,
          input.kind,
          sourceKey,
          input.title,
          input.title.toLowerCase(),
          input.year ?? null,
        ],
      );
      const result = await pool.query<Row>(`${SELECT} WHERE i.id = $1`, [
        upserted.rows[0]!.id,
      ]);
      return {
        ...toItem(result.rows[0]!),
        created: upserted.rows[0]!.inserted,
      };
    },

    async list(libraryId) {
      const result = libraryId
        ? await pool.query<Row>(
            `${SELECT} WHERE i.desired AND i.library_id = $1 ORDER BY i.sort_title`,
            [libraryId],
          )
        : await pool.query<Row>(
            `${SELECT} WHERE i.desired ORDER BY i.sort_title`,
          );
      return result.rows.map(toItem);
    },

    async listMissing() {
      const result = await pool.query<Row>(
        `${SELECT}
          WHERE i.desired
            AND NOT EXISTS (SELECT 1 FROM media_files f WHERE f.item_id = i.id)
          ORDER BY i.sort_title`,
      );
      return result.rows.map(toItem);
    },
  };
}
