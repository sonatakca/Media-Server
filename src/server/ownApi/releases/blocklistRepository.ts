/**
 * Releases that are never to be chosen again.
 *
 * Matched two ways, both exact. By indexer and guid, which is what names a
 * release precisely; and by title, because the same upload is listed by more
 * than one indexer under different guids and is just as broken on each. No
 * pattern matching: an entry names one release, and nothing broader.
 */
import { randomUUID } from "node:crypto";
import type { DatabasePool } from "../database/databasePool";
import type { IndexerRelease } from "../indexers/indexerTypes";

export interface BlocklistEntry {
  readonly id: string;
  readonly indexerId: string;
  readonly releaseGuid: string;
  readonly releaseTitle: string;
  readonly targetKind?: string;
  readonly targetTitle?: string;
  readonly reason?: string;
  readonly acquisitionId?: string;
  readonly createdAtMs: number;
}

export interface AddBlocklistEntry {
  readonly indexerId: string;
  readonly releaseGuid: string;
  readonly releaseTitle: string;
  readonly targetKind?: string;
  readonly targetTitle?: string;
  readonly reason?: string;
  readonly acquisitionId?: string;
}

type ReleaseIdentity = Pick<IndexerRelease, "indexerId" | "guid" | "title">;

export interface BlocklistRepository {
  /** Idempotent: blocklisting a release twice keeps the first entry. */
  add(entry: AddBlocklistEntry): Promise<void>;
  list(limit?: number): Promise<BlocklistEntry[]>;
  /** False when there was no such entry. */
  remove(id: string): Promise<boolean>;
  /**
   * A predicate over exactly these releases.
   *
   * One query for the whole set, so judging a hundred candidates is one round
   * trip rather than a hundred.
   */
  matcherFor(
    releases: readonly ReleaseIdentity[],
  ): Promise<(release: ReleaseIdentity) => boolean>;
}

interface Row {
  id: string;
  indexer_id: string;
  release_guid: string;
  release_title: string;
  target_kind: string | null;
  target_title: string | null;
  reason: string | null;
  acquisition_id: string | null;
  created_at: Date;
}

function guidKey(indexerId: string, guid: string): string {
  return `${indexerId}\u0000${guid}`;
}

export function createBlocklistRepository(
  pool: DatabasePool,
): BlocklistRepository {
  return {
    async add(entry) {
      await pool.query(
        `INSERT INTO release_blocklist
           (id, indexer_id, release_guid, release_title, target_kind,
            target_title, reason, acquisition_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (indexer_id, release_guid) DO NOTHING`,
        [
          randomUUID(),
          entry.indexerId,
          entry.releaseGuid,
          entry.releaseTitle,
          entry.targetKind ?? null,
          entry.targetTitle ?? null,
          entry.reason ?? null,
          entry.acquisitionId ?? null,
        ],
      );
    },

    async list(limit = 200) {
      const result = await pool.query<Row>(
        `SELECT id, indexer_id, release_guid, release_title, target_kind,
                target_title, reason, acquisition_id, created_at
           FROM release_blocklist
          ORDER BY created_at DESC
          LIMIT $1`,
        [Math.min(Math.max(limit, 1), 500)],
      );
      return result.rows.map((row) => ({
        id: row.id,
        indexerId: row.indexer_id,
        releaseGuid: row.release_guid,
        releaseTitle: row.release_title,
        ...(row.target_kind ? { targetKind: row.target_kind } : {}),
        ...(row.target_title ? { targetTitle: row.target_title } : {}),
        ...(row.reason ? { reason: row.reason } : {}),
        ...(row.acquisition_id ? { acquisitionId: row.acquisition_id } : {}),
        createdAtMs: row.created_at.getTime(),
      }));
    },

    async remove(id) {
      const result = await pool.query(
        "DELETE FROM release_blocklist WHERE id = $1",
        [id],
      );
      return (result.rowCount ?? 0) > 0;
    },

    async matcherFor(releases) {
      if (releases.length === 0) return () => false;
      const result = await pool.query<{
        indexer_id: string;
        release_guid: string;
        release_title: string;
      }>(
        `SELECT indexer_id, release_guid, release_title
           FROM release_blocklist
          WHERE release_guid = ANY($1::text[])
             OR lower(release_title) = ANY($2::text[])`,
        [
          releases.map((release) => release.guid),
          releases.map((release) => release.title.toLowerCase()),
        ],
      );
      const guids = new Set(
        result.rows.map((row) => guidKey(row.indexer_id, row.release_guid)),
      );
      const titles = new Set(
        result.rows.map((row) => row.release_title.toLowerCase()),
      );
      return (release) =>
        guids.has(guidKey(release.indexerId, release.guid)) ||
        titles.has(release.title.toLowerCase());
    },
  };
}
