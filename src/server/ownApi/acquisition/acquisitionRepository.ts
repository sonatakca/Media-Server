/**
 * Acquisitions in PostgreSQL.
 *
 * `update` is the piece that matters. It is a conditional write — the row must
 * still be in the state the caller last saw — which is what makes two workers
 * holding the same acquisition safe without a separate lock table: the second
 * one's update matches no row, it is told so, and it stops.
 */
import { randomUUID } from "node:crypto";
import type { DatabasePool } from "../database/databasePool";
import type {
  AcquisitionPatch,
  AcquisitionRecord,
  AcquisitionStore,
} from "./acquisitionService";
import type {
  AcquisitionOrigin,
  AcquisitionState,
  FailureClass,
} from "./acquisitionState";
import { isTerminal } from "./acquisitionState";

export interface AcquisitionTarget {
  readonly kind: "movie" | "season" | "episode";
  readonly itemId?: string;
  readonly title: string;
  readonly year?: number;
  readonly season?: number;
  readonly episode?: number;
}

export interface AcquisitionDecisionEvidence {
  readonly profileId?: string;
  readonly profileName: string;
  readonly policySnapshot: unknown;
  readonly releaseFacts: unknown;
  readonly score: number;
  readonly reasons: unknown;
  readonly rejected: unknown;
}

export interface CreateAcquisitionInput {
  readonly target: AcquisitionTarget;
  readonly indexerId: string;
  readonly releaseGuid: string;
  readonly releaseTitle: string;
  readonly origin: AcquisitionOrigin;
  readonly evidence: AcquisitionDecisionEvidence;
}

export interface AcquisitionSummary extends AcquisitionRecord {
  readonly targetTitle: string;
  readonly targetKind: string;
  readonly origin: string;
  readonly failureClass?: string;
  readonly failureDetail?: string;
  readonly createdAtMs: number;
}

export interface AcquisitionEvent {
  readonly fromState: string | null;
  readonly toState: string;
  readonly failureClass?: string;
  readonly detail?: string;
  readonly atMs: number;
}

export interface AcquisitionRepository extends AcquisitionStore {
  create(input: CreateAcquisitionInput): Promise<AcquisitionSummary>;
  /**
   * Narrower than the store's, and truthfully so.
   *
   * `AcquisitionStore` is what the service needs — the state machine's fields
   * and nothing else. The repository has always returned the whole summary,
   * and the import phase needs the target it names.
   */
  get(id: string): Promise<AcquisitionSummary | null>;
  list(limit?: number): Promise<AcquisitionSummary[]>;
  detail(id: string): Promise<{
    acquisition: AcquisitionSummary;
    events: AcquisitionEvent[];
  } | null>;
  /** Acquisitions finished downloading and not yet handed on. */
  listReadyForImport(limit?: number): Promise<AcquisitionSummary[]>;
}

interface Row {
  id: string;
  state: string;
  indexer_id: string;
  release_guid: string;
  release_title: string;
  idempotency_key: string;
  external_id: string | null;
  attempt: number;
  download_path: string | null;
  size_bytes: string | number | null;
  failure_class: string | null;
  failure_detail: string | null;
  target_title: string;
  target_kind: string;
  origin: string;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS = `id, state, indexer_id, release_guid, release_title,
  idempotency_key, external_id, attempt, download_path, size_bytes,
  failure_class, failure_detail, target_title, target_kind, origin,
  created_at, updated_at`;

function toSummary(row: Row): AcquisitionSummary {
  const size = row.size_bytes === null ? undefined : Number(row.size_bytes);
  return {
    id: row.id,
    state: row.state as AcquisitionState,
    indexerId: row.indexer_id,
    releaseGuid: row.release_guid,
    releaseTitle: row.release_title,
    idempotencyKey: row.idempotency_key,
    ...(row.external_id ? { externalId: row.external_id } : {}),
    attempt: row.attempt,
    ...(row.download_path ? { downloadPath: row.download_path } : {}),
    ...(size === undefined || Number.isNaN(size) ? {} : { sizeBytes: size }),
    ...(row.failure_class ? { failureClass: row.failure_class } : {}),
    ...(row.failure_detail ? { failureDetail: row.failure_detail } : {}),
    targetTitle: row.target_title,
    targetKind: row.target_kind,
    origin: row.origin,
    createdAtMs: row.created_at.getTime(),
    updatedAtMs: row.updated_at.getTime(),
  };
}

export function createAcquisitionRepository(
  pool: DatabasePool,
): AcquisitionRepository {
  return {
    async create(input) {
      const id = randomUUID();
      /*
       * The key is derived from the row's own identifier, so it is unique by
       * construction and needs no coordination — and it is written in the same
       * statement that creates the row, before anything could be submitted
       * under it.
       */
      const idempotencyKey = `seyirlik-${id}`;
      const inserted = await pool.query<Row>(
        `INSERT INTO acquisitions
           (id, target_kind, target_item_id, target_title, target_year,
            target_season, target_episode, indexer_id, release_guid,
            release_title, state, origin, idempotency_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'planned',$11,$12)
         RETURNING ${COLUMNS}`,
        [
          id,
          input.target.kind,
          input.target.itemId ?? null,
          input.target.title,
          input.target.year ?? null,
          input.target.season ?? null,
          input.target.episode ?? null,
          input.indexerId,
          input.releaseGuid,
          input.releaseTitle,
          input.origin,
          idempotencyKey,
        ],
      );
      await pool.query(
        `INSERT INTO acquisition_decisions
           (acquisition_id, profile_id, profile_name, policy_snapshot,
            release_facts, score, reasons, rejected)
         VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7::jsonb,$8::jsonb)`,
        [
          id,
          input.evidence.profileId ?? null,
          input.evidence.profileName,
          JSON.stringify(input.evidence.policySnapshot),
          JSON.stringify(input.evidence.releaseFacts),
          input.evidence.score,
          JSON.stringify(input.evidence.reasons),
          JSON.stringify(input.evidence.rejected),
        ],
      );
      await pool.query(
        `INSERT INTO acquisition_events (acquisition_id, from_state, to_state, detail)
         VALUES ($1, NULL, 'planned', $2)`,
        [id, `Chosen by ${input.origin} decision.`],
      );
      return toSummary(inserted.rows[0]!);
    },

    async get(id) {
      const result = await pool.query<Row>(
        `SELECT ${COLUMNS} FROM acquisitions WHERE id = $1`,
        [id],
      );
      return result.rows[0] ? toSummary(result.rows[0]) : null;
    },

    async listActive() {
      const result = await pool.query<Row>(
        `SELECT ${COLUMNS} FROM acquisitions
          WHERE state NOT IN ('downloaded','cancelled','superseded','failed')
          ORDER BY created_at`,
      );
      return result.rows.map(toSummary);
    },

    async update(id, expectedState, patch: AcquisitionPatch, detail) {
      /*
       * One statement, guarded on the state the caller saw. Two workers cannot
       * both win it, and no separate lock has to be kept in step with the row.
       */
      const result = await pool.query<{ state: string }>(
        `UPDATE acquisitions SET
           state = COALESCE($3, state),
           external_id = COALESCE($4, external_id),
           attempt = COALESCE($5, attempt),
           failure_class = CASE WHEN $6::boolean THEN $7 ELSE failure_class END,
           failure_detail = CASE WHEN $6::boolean THEN $8 ELSE failure_detail END,
           download_path = COALESCE($9, download_path),
           size_bytes = COALESCE($10, size_bytes),
           retry_after = CASE WHEN $11::boolean THEN $12 ELSE retry_after END,
           completed_at = CASE WHEN $3 = 'downloaded' THEN now() ELSE completed_at END,
           updated_at = now()
         WHERE id = $1 AND state = $2
         RETURNING state`,
        [
          id,
          expectedState,
          patch.state ?? null,
          patch.externalId ?? null,
          patch.attempt ?? null,
          patch.failureClass !== undefined || patch.failureDetail !== undefined,
          patch.failureClass ?? null,
          patch.failureDetail ?? null,
          patch.downloadPath ?? null,
          patch.sizeBytes ?? null,
          patch.retryAfterMs !== undefined,
          patch.retryAfterMs ? new Date(patch.retryAfterMs) : null,
        ],
      );
      if (result.rows.length === 0) return false;

      if (patch.state && patch.state !== expectedState) {
        await pool.query(
          `INSERT INTO acquisition_events
             (acquisition_id, from_state, to_state, failure_class, detail)
           VALUES ($1,$2,$3,$4,$5)`,
          [
            id,
            expectedState,
            patch.state,
            (patch.failureClass as FailureClass | null | undefined) ?? null,
            detail ?? null,
          ],
        );
      }
      return true;
    },

    async list(limit = 100) {
      const result = await pool.query<Row>(
        `SELECT ${COLUMNS} FROM acquisitions ORDER BY created_at DESC LIMIT $1`,
        [Math.min(Math.max(limit, 1), 500)],
      );
      return result.rows.map(toSummary);
    },

    async detail(id) {
      const acquisition = await this.get(id);
      if (!acquisition) return null;
      const events = await pool.query<{
        from_state: string | null;
        to_state: string;
        failure_class: string | null;
        detail: string | null;
        at: Date;
      }>(
        `SELECT from_state, to_state, failure_class, detail, at
           FROM acquisition_events WHERE acquisition_id = $1 ORDER BY id`,
        [id],
      );
      return {
        acquisition: acquisition as AcquisitionSummary,
        events: events.rows.map((row) => ({
          fromState: row.from_state,
          toState: row.to_state,
          ...(row.failure_class ? { failureClass: row.failure_class } : {}),
          ...(row.detail ? { detail: row.detail } : {}),
          atMs: row.at.getTime(),
        })),
      };
    },

    async listReadyForImport(limit = 100) {
      // The handoff. Everything the import phase needs to find the bytes, and
      // nothing this phase is allowed to do with them.
      const result = await pool.query<Row>(
        `SELECT ${COLUMNS} FROM acquisitions
          WHERE state = 'downloaded' AND download_path IS NOT NULL
          ORDER BY completed_at
          LIMIT $1`,
        [Math.min(Math.max(limit, 1), 500)],
      );
      return result.rows.map(toSummary);
    },
  };
}

/** Whether an acquisition may still be retried by an operator. */
export function isRetryable(summary: AcquisitionSummary): boolean {
  return summary.state === "failed" && !isTerminal(summary.state);
}
