import { randomUUID } from "node:crypto";
import type { DatabasePool } from "../database/databasePool";
import {
  initialStorageHealth,
  type StorageHealthRecord,
  type StorageHealthState,
} from "../../../renditions/processing/storageHealth";
import type {
  StorageMedium,
  VolumeIdentity,
} from "../../../renditions/processing/storageIdentity";

/**
 * The durable half of storage health.
 *
 * The state machine beside this decides what a root's state should be; this
 * makes that decision survive the thing it exists to survive. A quarantine held
 * only in memory is cleared by exactly the event that most demands it — the
 * forced power-off that ends a kernel I/O storm — and clearing it is what let
 * the failing drive be attacked a second time within seconds of the next login.
 *
 * One open row per root, plus the cleared ones kept as history. Nothing here
 * touches the storage it describes.
 */

export interface StorageIncidentRecord extends StorageHealthRecord {
  id: string;
  /** What kind of evidence established it, for whoever has to fix the hardware. */
  failureClass: string | null;
  /** The job that was running when the fault landed, if there was one. */
  processingJobId: string | null;
  quarantinedAtMs: number | null;
  acknowledgedBy: string | null;
  /** How the recorded identity became authoritative. */
  identitySource: "probe" | "adopted" | null;
  adoptedAtMs: number | null;
  /** The UUID an adoption replaced, when there was one. */
  supersededVolumeUuid: string | null;
  /**
   * The volume this was recorded against, when one could be established.
   *
   * `null` is meaningful rather than missing: it says the incident cannot be
   * matched against anything, so recovery needs a person. Incidents written
   * before identity existed carry it, and fail closed accordingly.
   */
  identity: VolumeIdentity | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface StorageIncidentStore {
  /** The open incident for a root, or null when it has never had one. */
  findOpen(root: string): Promise<StorageIncidentRecord | null>;
  /** Every open incident, for the page that lists them. */
  listOpen(): Promise<StorageIncidentRecord[]>;
  /** Recent incidents including cleared ones, newest first. */
  listRecent(limit?: number): Promise<StorageIncidentRecord[]>;
  /**
   * Writes a root's health, opening an incident or updating the open one.
   *
   * `healthy` with no open incident writes nothing: a healthy volume that has
   * never misbehaved does not need a row, and creating one per poll would turn
   * an idle system into a write loop.
   */
  save(
    record: StorageHealthRecord,
    context?: {
      failureClass?: string | null;
      processingJobId?: string | null;
      acknowledgedBy?: string | null;
      /**
       * Written once, when the incident opens, and never overwritten.
       *
       * Re-recording it later would let whatever is mounted *now* become the
       * thing recovery is checked against — which is the whole failure this
       * column exists to prevent.
       */
      identity?: VolumeIdentity | null;
      /**
       * Present only for an operator adoption.
       *
       * Its presence is what allows the recorded identity to change at all: the
       * ordinary write path COALESCEs identity so a later mount can never
       * overwrite it, and this is the single deliberate exception.
       */
      adoption?: {
        adoptedAtMs: number;
        supersededVolumeUuid: string | null;
      };
    },
  ): Promise<StorageIncidentRecord | null>;
}

interface RawRow {
  id: string;
  storage_root: string;
  state: StorageHealthState;
  reason: string;
  failure_class: string | null;
  fault_count: number;
  first_fault_at: Date | null;
  last_fault_at: Date | null;
  processing_job_id: string | null;
  quarantined_at: Date | null;
  verified_at: Date | null;
  cleared_at: Date | null;
  acknowledged_by: string | null;
  volume_uuid: string | null;
  volume_medium: StorageMedium | null;
  volume_fs_type: string | null;
  device_node: string | null;
  identity_source: "probe" | "adopted" | null;
  adopted_at: Date | null;
  superseded_volume_uuid: string | null;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS = `
  id, storage_root, state, reason, failure_class, fault_count,
  first_fault_at, last_fault_at, processing_job_id, quarantined_at,
  verified_at, cleared_at, acknowledged_by,
  volume_uuid, volume_medium, volume_fs_type, device_node,
  identity_source, adopted_at, superseded_volume_uuid,
  created_at, updated_at
`;

function toRecord(row: RawRow): StorageIncidentRecord {
  return {
    id: row.id,
    root: row.storage_root,
    state: row.state,
    reason: row.reason,
    failureClass: row.failure_class,
    faultCount: row.fault_count,
    firstFaultAtMs: row.first_fault_at?.getTime() ?? null,
    lastFaultAtMs: row.last_fault_at?.getTime() ?? null,
    changedAtMs: row.updated_at.getTime(),
    verifiedAtMs: row.verified_at?.getTime() ?? null,
    clearedAtMs: row.cleared_at?.getTime() ?? null,
    /*
     * Not persisted. Which roots failed their last check is a fact about this
     * instant, and a stale list read back from a row written yesterday would
     * name a drive that is currently plugged in.
     */
    missingRoots: [],
    processingJobId: row.processing_job_id,
    quarantinedAtMs: row.quarantined_at?.getTime() ?? null,
    acknowledgedBy: row.acknowledged_by,
    /*
     * Only a row that recorded a UUID yields an identity. A row with a medium
     * but no UUID is not a weaker identity, it is none: `physical-external` and
     * `exfat` between them describe a great many disks.
     */
    identitySource: row.identity_source,
    adoptedAtMs: row.adopted_at?.getTime() ?? null,
    supersededVolumeUuid: row.superseded_volume_uuid,
    identity:
      row.volume_uuid === null
        ? null
        : {
            volumeUuid: row.volume_uuid,
            deviceNode: row.device_node,
            medium: row.volume_medium ?? "unknown",
            fsType: row.volume_fs_type,
            mountPath: row.storage_root,
          },
    createdAtMs: row.created_at.getTime(),
    updatedAtMs: row.updated_at.getTime(),
  };
}

function toDate(ms: number | null | undefined): Date | null {
  return ms === null || ms === undefined ? null : new Date(ms);
}

export function createStorageIncidentStore(
  pool: DatabasePool,
): StorageIncidentStore {
  return {
    async findOpen(root) {
      const result = await pool.query<RawRow>(
        `SELECT ${COLUMNS} FROM storage_incidents
          WHERE storage_root = $1 AND cleared_at IS NULL
          LIMIT 1`,
        [root],
      );
      return result.rows[0] ? toRecord(result.rows[0]) : null;
    },

    async listOpen() {
      const result = await pool.query<RawRow>(
        `SELECT ${COLUMNS} FROM storage_incidents
          WHERE cleared_at IS NULL ORDER BY created_at DESC`,
      );
      return result.rows.map(toRecord);
    },

    async listRecent(limit = 20) {
      const result = await pool.query<RawRow>(
        `SELECT ${COLUMNS} FROM storage_incidents
          ORDER BY created_at DESC LIMIT $1`,
        [Math.min(200, Math.max(1, Math.trunc(limit)))],
      );
      return result.rows.map(toRecord);
    },

    async save(record, context = {}) {
      const existing = await this.findOpen(record.root);

      if (!existing) {
        /*
         * Nothing to say. A root that is healthy and has no history is the
         * ordinary case, and it is the one this must stay silent about — every
         * poll on every healthy machine would otherwise be a write.
         */
        if (record.state === "healthy") return null;
        const result = await pool.query<RawRow>(
          `INSERT INTO storage_incidents (
             id, storage_root, state, reason, failure_class, fault_count,
             first_fault_at, last_fault_at, processing_job_id,
             quarantined_at, verified_at, acknowledged_by
             , volume_uuid, volume_medium, volume_fs_type, device_node
             , identity_source, adopted_at, superseded_volume_uuid
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
           RETURNING ${COLUMNS}`,
          [
            randomUUID(),
            record.root,
            record.state,
            record.reason.slice(0, 500),
            context.failureClass ?? null,
            record.faultCount,
            toDate(record.firstFaultAtMs),
            toDate(record.lastFaultAtMs),
            context.processingJobId ?? null,
            record.state === "quarantined"
              ? new Date(record.changedAtMs)
              : null,
            toDate(record.verifiedAtMs),
            context.acknowledgedBy ?? null,
            context.identity?.volumeUuid ?? null,
            context.identity?.medium ?? null,
            context.identity?.fsType ?? null,
            context.identity?.deviceNode ?? null,
            context.identity ? (context.adoption ? "adopted" : "probe") : null,
            context.adoption ? new Date(context.adoption.adoptedAtMs) : null,
            context.adoption?.supersededVolumeUuid ?? null,
          ],
        );
        return result.rows[0] ? toRecord(result.rows[0]) : null;
      }

      /*
       * `cleared_at` is what closes an incident, and only a transition to
       * `healthy` sets it. That is the single write in this file that makes a
       * root workable again, which is why it is expressed once, here, rather
       * than being reachable from any code path that happens to save a record.
       */
      const clearedAt =
        record.state === "healthy"
          ? new Date(record.clearedAtMs ?? record.changedAtMs)
          : null;

      const result = await pool.query<RawRow>(
        `UPDATE storage_incidents SET
           state = $2,
           reason = $3,
           failure_class = COALESCE($4, failure_class),
           fault_count = $5,
           first_fault_at = COALESCE($6, first_fault_at),
           last_fault_at = COALESCE($7, last_fault_at),
           processing_job_id = COALESCE($8, processing_job_id),
           /*
            * The first quarantine timestamp wins. An operator asking "how long
            * has this been bad" wants the moment it started, not the moment of
            * the most recent write to the row.
            */
           quarantined_at = COALESCE(quarantined_at, $9),
           verified_at = $10,
           cleared_at = $11,
           acknowledged_by = COALESCE($12, acknowledged_by),
           /*
            * COALESCE keeps the *first* identity. Overwriting it would mean the
            * incident silently starts describing whatever is mounted now, so a
            * disk image attached at the quarantined path would become the thing
            * recovery is checked against — the exact failure this prevents.
            *
            * device_node is the one exception: it is diagnostic, it changes on
            * every reconnect, and the current value is the useful one.
            */
           /*
            * $17 is non-null only for an operator adoption, and it is the one
            * thing allowed to move the recorded identity. Everything else
            * COALESCEs, so an ordinary write can add an identity that was
            * missing but can never replace one that is already there.
            */
           volume_uuid = CASE WHEN $17 IS NOT NULL THEN $13
                              ELSE COALESCE(volume_uuid, $13) END,
           volume_medium = CASE WHEN $17 IS NOT NULL THEN $14
                                ELSE COALESCE(volume_medium, $14) END,
           volume_fs_type = CASE WHEN $17 IS NOT NULL THEN $15
                                 ELSE COALESCE(volume_fs_type, $15) END,
           device_node = COALESCE($16, device_node),
           identity_source = CASE WHEN $17 IS NOT NULL THEN $17
                                  ELSE COALESCE(identity_source,
                                                CASE WHEN $13 IS NOT NULL THEN 'probe' END) END,
           adopted_at = COALESCE($18, adopted_at),
           /*
            * The superseded UUID is whatever the row held before this adoption,
            * captured here rather than by the caller so it cannot be wrong.
            */
           superseded_volume_uuid = CASE WHEN $17 IS NOT NULL
                                         THEN COALESCE($19, volume_uuid)
                                         ELSE superseded_volume_uuid END,
           updated_at = now()
         WHERE id = $1
         RETURNING ${COLUMNS}`,
        [
          existing.id,
          record.state,
          record.reason.slice(0, 500),
          context.failureClass ?? null,
          record.faultCount,
          toDate(record.firstFaultAtMs),
          toDate(record.lastFaultAtMs),
          context.processingJobId ?? null,
          record.state === "quarantined" ? new Date(record.changedAtMs) : null,
          toDate(record.verifiedAtMs),
          clearedAt,
          context.acknowledgedBy ?? null,
          context.identity?.volumeUuid ?? null,
          context.identity?.medium ?? null,
          context.identity?.fsType ?? null,
          context.identity?.deviceNode ?? null,
          context.adoption ? "adopted" : null,
          context.adoption ? new Date(context.adoption.adoptedAtMs) : null,
          context.adoption?.supersededVolumeUuid ?? null,
        ],
      );
      return result.rows[0] ? toRecord(result.rows[0]) : null;
    },
  };
}

/**
 * The health a root should be assumed to have when the process starts.
 *
 * Read from the row rather than from the volume, which is the entire point: the
 * drive is perfectly capable of answering a `stat` while being the reason the
 * last boot ended in a forced power-off.
 */
export function healthFromIncident(
  root: string,
  incident: StorageIncidentRecord | null,
  nowMs: number,
): StorageHealthRecord {
  if (!incident || incident.clearedAtMs !== null) {
    return initialStorageHealth(root, nowMs);
  }
  return {
    root,
    state: incident.state,
    reason: incident.reason,
    faultCount: incident.faultCount,
    firstFaultAtMs: incident.firstFaultAtMs,
    lastFaultAtMs: incident.lastFaultAtMs,
    /*
     * The state's age is taken from the row, not from now. A settling period
     * measured from process start would be restarted by every worker restart,
     * so a volume that had been steadily present for an hour would be made to
     * wait afresh — and, far worse, a flapping one would never be seen to flap.
     */
    changedAtMs: incident.updatedAtMs,
    verifiedAtMs: incident.verifiedAtMs,
    missingRoots: [],
    clearedAtMs: null,
  };
}
