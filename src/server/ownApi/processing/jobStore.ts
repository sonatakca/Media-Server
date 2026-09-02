import { randomUUID } from "node:crypto";
import type { DatabasePool } from "../database/databasePool";
import type { ProcessingStage } from "./stages";

/**
 * The durable record of one media-processing job.
 *
 * Scheduling lives in the generic `jobs` table; everything a media job needs to
 * survive a restart, and everything the administration page shows, lives here.
 * Both are written in the same transaction where it matters, so a job cannot be
 * queued without a record or recorded without being queued.
 */

export type ProcessingState =
  | "pending"
  | "queued"
  | "running"
  | "paused"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface ProcessingJobRecord {
  id: string;
  jobId: string | null;
  itemId: string;
  mediaFileId: string;
  sourceFingerprint: string;
  profile: string;
  state: ProcessingState;
  stage: ProcessingStage;
  stageProgress: number;
  overallProgress: number;
  bytesProcessed: number;
  outputBytes: number | null;
  estimatedOutputBytes: number | null;
  estimatedStagingBytes: number | null;
  speed: number | null;
  fps: number | null;
  etaSeconds: number | null;
  hardwareAdapter: string | null;
  videoEncoder: string | null;
  decision: Record<string, unknown> | null;
  streamDecisions: Record<string, unknown> | null;
  validation: Record<string, unknown> | null;
  warnings: string[];
  errorCode: string | null;
  errorMessage: string | null;
  stagingDirectory: string | null;
  publishedVersion: string | null;
  attempts: number;
  cancellationRequested: boolean;
  pauseRequested: boolean;
  /** Why it is paused: an operator asked, or the storage went away. */
  pausedReason: "operator" | "storage-unavailable" | null;
  /**
   * The epoch build's position, cached from the checkpoints on disk.
   *
   * None of this is authoritative: the filesystem owns durable progress, and a
   * restart reconciles against it. It is here so a page opened before the
   * encoder next reports in can already say how much work is protected.
   */
  epochCount: number | null;
  epochIndex: number | null;
  completedEpochs: number;
  protectedSeconds: number;
  /** Media time encoded. The video percentage is this over the source duration. */
  encodedSeconds: number;
  sourceDurationSeconds: number | null;
  epochStartSeconds: number | null;
  epochEndSeconds: number | null;
  checkpointBytes: number;
  freeBytes: number | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  updatedAt: Date;
}

export interface ProcessingJobEvent {
  id: number;
  processingJobId: string;
  sequence: number;
  stage: ProcessingStage;
  level: "info" | "warning" | "error";
  message: string;
  detail: Record<string, unknown> | null;
  createdAt: Date;
}

export interface CreateProcessingJobInput {
  itemId: string;
  mediaFileId: string;
  sourceFingerprint: string;
  profile: string;
  decision?: Record<string, unknown>;
  streamDecisions?: Record<string, unknown>;
  estimatedOutputBytes?: number;
  estimatedStagingBytes?: number;
  hardwareAdapter?: string;
  videoEncoder?: string;
  warnings?: string[];
}

export interface ProcessingJobUpdate {
  state?: ProcessingState;
  stage?: ProcessingStage;
  stageProgress?: number;
  overallProgress?: number;
  bytesProcessed?: number;
  outputBytes?: number;
  /** The job's live prediction of its own final size, refined as it runs. */
  estimatedOutputBytes?: number;
  speed?: number | null;
  fps?: number | null;
  etaSeconds?: number | null;
  hardwareAdapter?: string;
  videoEncoder?: string;
  validation?: Record<string, unknown> | null;
  warnings?: string[];
  errorCode?: string | null;
  errorMessage?: string | null;
  stagingDirectory?: string | null;
  publishedVersion?: string | null;
  startedAt?: Date;
  finishedAt?: Date | null;
  /**
   * Cleared when a job is retried. A retry that inherited the flag was
   * cancelled again the moment it started, which looked like the retry button
   * doing nothing at all.
   */
  cancellationRequested?: boolean;
  pauseRequested?: boolean;
  pausedReason?: "operator" | "storage-unavailable" | null;
  epochCount?: number | null;
  epochIndex?: number | null;
  completedEpochs?: number;
  protectedSeconds?: number;
  encodedSeconds?: number;
  sourceDurationSeconds?: number | null;
  epochStartSeconds?: number | null;
  epochEndSeconds?: number | null;
  checkpointBytes?: number;
  freeBytes?: number | null;
}

const ACTIVE_STATES: readonly ProcessingState[] = [
  "pending",
  "queued",
  "running",
  "paused",
];

const COLUMNS = `
  id, job_id, item_id, media_file_id, source_fingerprint, profile,
  state, stage, stage_progress, overall_progress,
  bytes_processed, output_bytes, estimated_output_bytes, estimated_staging_bytes,
  speed, fps, eta_seconds, hardware_adapter, video_encoder,
  decision, stream_decisions, validation, warnings,
  error_code, error_message, staging_directory, published_version,
  attempts, cancellation_requested, pause_requested, paused_reason,
  epoch_count, epoch_index, completed_epochs, protected_seconds,
  encoded_seconds, source_duration_seconds, epoch_start_seconds,
  epoch_end_seconds, checkpoint_bytes, free_bytes,
  created_at, started_at, finished_at, updated_at
`;

interface RawRow {
  id: string;
  job_id: string | null;
  item_id: string;
  media_file_id: string;
  source_fingerprint: string;
  profile: string;
  state: ProcessingState;
  stage: ProcessingStage;
  stage_progress: number;
  overall_progress: number;
  bytes_processed: string | number;
  output_bytes: string | number | null;
  estimated_output_bytes: string | number | null;
  estimated_staging_bytes: string | number | null;
  speed: number | null;
  fps: number | null;
  eta_seconds: number | null;
  hardware_adapter: string | null;
  video_encoder: string | null;
  decision: Record<string, unknown> | null;
  stream_decisions: Record<string, unknown> | null;
  validation: Record<string, unknown> | null;
  warnings: string[] | null;
  error_code: string | null;
  error_message: string | null;
  staging_directory: string | null;
  published_version: string | null;
  attempts: number;
  cancellation_requested: boolean;
  pause_requested: boolean;
  paused_reason: "operator" | "storage-unavailable" | null;
  epoch_count: number | null;
  epoch_index: number | null;
  completed_epochs: number;
  protected_seconds: string | number;
  encoded_seconds: string | number;
  source_duration_seconds: string | number | null;
  epoch_start_seconds: string | number | null;
  epoch_end_seconds: string | number | null;
  checkpoint_bytes: string | number;
  free_bytes: string | number | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  updated_at: Date;
}

function toNumber(value: string | number | null): number | null {
  if (value === null) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toRecord(row: RawRow): ProcessingJobRecord {
  return {
    id: row.id,
    jobId: row.job_id,
    itemId: row.item_id,
    mediaFileId: row.media_file_id,
    sourceFingerprint: row.source_fingerprint,
    profile: row.profile,
    state: row.state,
    stage: row.stage,
    stageProgress: row.stage_progress,
    overallProgress: row.overall_progress,
    bytesProcessed: toNumber(row.bytes_processed) ?? 0,
    outputBytes: toNumber(row.output_bytes),
    estimatedOutputBytes: toNumber(row.estimated_output_bytes),
    estimatedStagingBytes: toNumber(row.estimated_staging_bytes),
    speed: row.speed,
    fps: row.fps,
    etaSeconds: row.eta_seconds,
    hardwareAdapter: row.hardware_adapter,
    videoEncoder: row.video_encoder,
    decision: row.decision,
    streamDecisions: row.stream_decisions,
    validation: row.validation,
    warnings: Array.isArray(row.warnings) ? row.warnings : [],
    errorCode: row.error_code,
    errorMessage: row.error_message,
    stagingDirectory: row.staging_directory,
    publishedVersion: row.published_version,
    attempts: row.attempts,
    cancellationRequested: row.cancellation_requested,
    pauseRequested: row.pause_requested,
    pausedReason: row.paused_reason,
    epochCount: row.epoch_count,
    epochIndex: row.epoch_index,
    completedEpochs: row.completed_epochs ?? 0,
    protectedSeconds: toNumber(row.protected_seconds) ?? 0,
    encodedSeconds: toNumber(row.encoded_seconds) ?? 0,
    sourceDurationSeconds: toNumber(row.source_duration_seconds),
    epochStartSeconds: toNumber(row.epoch_start_seconds),
    epochEndSeconds: toNumber(row.epoch_end_seconds),
    checkpointBytes: toNumber(row.checkpoint_bytes) ?? 0,
    freeBytes: toNumber(row.free_bytes),
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    updatedAt: row.updated_at,
  };
}

/** Raised when a media file already has a job that has not finished. */
export class DuplicateProcessingJobError extends Error {
  readonly existingJobId: string;
  constructor(existingJobId: string) {
    super("This file already has a processing job that has not finished.");
    this.name = "DuplicateProcessingJobError";
    this.existingJobId = existingJobId;
  }
}

export interface ProcessingJobStore {
  create(input: CreateProcessingJobInput): Promise<ProcessingJobRecord>;
  attachQueueJob(id: string, jobId: string): Promise<void>;
  get(id: string): Promise<ProcessingJobRecord | null>;
  getByQueueJobId(jobId: string): Promise<ProcessingJobRecord | null>;
  findActiveForFile(mediaFileId: string): Promise<ProcessingJobRecord | null>;
  /** Removes a finished history entry. Active work is deliberately retained. */
  deleteFinished(id: string): Promise<boolean>;
  list(options?: {
    state?: ProcessingState;
    limit?: number;
  }): Promise<ProcessingJobRecord[]>;
  update(
    id: string,
    update: ProcessingJobUpdate,
  ): Promise<ProcessingJobRecord | null>;
  requestCancellation(id: string): Promise<boolean>;
  /** Asks a running job to suspend itself, recording who asked and why. */
  requestPause(
    id: string,
    reason: "operator" | "storage-unavailable",
  ): Promise<boolean>;
  /**
   * Lifts a pause. Pass `onlyReason` to lift only pauses of that kind, so the
   * storage returning does not restart something a person paused on purpose.
   */
  resume(
    id: string,
    onlyReason?: "operator" | "storage-unavailable",
  ): Promise<boolean>;
  listPaused(
    reason: "operator" | "storage-unavailable",
  ): Promise<ProcessingJobRecord[]>;
  listActive(): Promise<ProcessingJobRecord[]>;
  /**
   * Starts a new attempt, resetting everything scoped to an attempt.
   *
   * A processing job outlives its attempts: it keeps its identity, its source
   * and the package it has already published. Everything describing *how the
   * work went* belongs to one attempt and must not survive into the next. It
   * did — a retry inherited the previous attempt's 89% overall progress, its
   * `finishedAt`, its estimate and its speed, so a freshly started run showed
   * as nearly complete and as having finished two minutes before it began.
   * Resetting in one statement is what makes that impossible to get wrong
   * again, rather than each caller remembering the whole list.
   */
  beginAttempt(
    id: string,
    input: {
      estimatedOutputBytes?: number;
      estimatedStagingBytes?: number;
      decision?: Record<string, unknown>;
      streamDecisions?: Record<string, unknown>;
      hardwareAdapter?: string;
      videoEncoder?: string;
      warnings?: string[];
    },
  ): Promise<ProcessingJobRecord | null>;
  incrementAttempts(id: string): Promise<number>;
  appendEvent(input: {
    processingJobId: string;
    stage: ProcessingStage;
    level?: "info" | "warning" | "error";
    message: string;
    detail?: Record<string, unknown>;
  }): Promise<ProcessingJobEvent>;
  listEvents(
    processingJobId: string,
    afterSequence?: number,
  ): Promise<ProcessingJobEvent[]>;
  counts(): Promise<Record<ProcessingState, number>>;
  /**
   * Mirrors terminal queue failures into the operator-facing processing row.
   * A worker can disappear between those two durable records; without this
   * repair the queue is honestly failed while the processing page says the
   * encoder is still running forever.
   */
  reconcileTerminalQueueJobs(): Promise<number>;
  /**
   * Returns jobs abandoned by a worker that stopped, so they can be resumed or
   * failed on the next start rather than sitting at `running` for ever.
   */
  findInterrupted(): Promise<ProcessingJobRecord[]>;
}

export function createProcessingJobStore(
  pool: DatabasePool,
): ProcessingJobStore {
  return {
    async create(input) {
      const existing = await pool.query<{ id: string }>(
        `SELECT id FROM processing_jobs
          WHERE media_file_id = $1 AND state = ANY($2::text[]) LIMIT 1`,
        [input.mediaFileId, ACTIVE_STATES],
      );
      if (existing.rows[0]) {
        throw new DuplicateProcessingJobError(existing.rows[0].id);
      }

      const id = randomUUID();
      const result = await pool.query<RawRow>(
        `INSERT INTO processing_jobs (
           id, item_id, media_file_id, source_fingerprint, profile,
           decision, stream_decisions, estimated_output_bytes, estimated_staging_bytes,
           hardware_adapter, video_encoder, warnings
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         RETURNING ${COLUMNS}`,
        [
          id,
          input.itemId,
          input.mediaFileId,
          input.sourceFingerprint,
          input.profile,
          input.decision ?? null,
          input.streamDecisions ?? null,
          input.estimatedOutputBytes ?? null,
          input.estimatedStagingBytes ?? null,
          input.hardwareAdapter ?? null,
          input.videoEncoder ?? null,
          JSON.stringify(input.warnings ?? []),
        ],
      );
      return toRecord(result.rows[0]!);
    },

    async attachQueueJob(id, jobId) {
      await pool.query(
        `UPDATE processing_jobs
            SET job_id = $2, state = 'queued', updated_at = now()
          WHERE id = $1`,
        [id, jobId],
      );
    },

    async get(id) {
      const result = await pool.query<RawRow>(
        `SELECT ${COLUMNS} FROM processing_jobs WHERE id = $1`,
        [id],
      );
      return result.rows[0] ? toRecord(result.rows[0]) : null;
    },

    async getByQueueJobId(jobId) {
      const result = await pool.query<RawRow>(
        `SELECT ${COLUMNS} FROM processing_jobs WHERE job_id = $1`,
        [jobId],
      );
      return result.rows[0] ? toRecord(result.rows[0]) : null;
    },

    async findActiveForFile(mediaFileId) {
      const result = await pool.query<RawRow>(
        `SELECT ${COLUMNS} FROM processing_jobs
          WHERE media_file_id = $1 AND state = ANY($2::text[])
          LIMIT 1`,
        [mediaFileId, ACTIVE_STATES],
      );
      return result.rows[0] ? toRecord(result.rows[0]) : null;
    },

    async deleteFinished(id) {
      const result = await pool.query(
        `DELETE FROM processing_jobs
          WHERE id = $1 AND state IN ('succeeded', 'failed', 'cancelled')`,
        [id],
      );
      return (result.rowCount ?? 0) > 0;
    },

    async list(options = {}) {
      const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
      const result = options.state
        ? await pool.query<RawRow>(
            `SELECT ${COLUMNS} FROM processing_jobs
              WHERE state = $1 ORDER BY created_at DESC LIMIT $2`,
            [options.state, limit],
          )
        : await pool.query<RawRow>(
            `SELECT ${COLUMNS} FROM processing_jobs
              ORDER BY created_at DESC LIMIT $1`,
            [limit],
          );
      return result.rows.map(toRecord);
    },

    async update(id, update) {
      const assignments: string[] = [];
      const values: unknown[] = [id];
      const set = (column: string, value: unknown) => {
        values.push(value);
        assignments.push(`${column} = $${values.length}`);
      };

      if (update.state !== undefined) set("state", update.state);
      if (update.stage !== undefined) set("stage", update.stage);
      if (update.stageProgress !== undefined)
        set("stage_progress", update.stageProgress);
      if (update.overallProgress !== undefined) {
        // Guarded in SQL as well as in the caller: two writers reporting out of
        // order must not be able to walk the bar backwards.
        values.push(update.overallProgress);
        assignments.push(
          `overall_progress = GREATEST(overall_progress, $${values.length})`,
        );
      }
      if (update.bytesProcessed !== undefined)
        set("bytes_processed", update.bytesProcessed);
      if (update.estimatedOutputBytes !== undefined)
        set("estimated_output_bytes", update.estimatedOutputBytes);
      if (update.outputBytes !== undefined)
        set("output_bytes", update.outputBytes);
      if (update.speed !== undefined) set("speed", update.speed);
      if (update.fps !== undefined) set("fps", update.fps);
      if (update.etaSeconds !== undefined)
        set("eta_seconds", update.etaSeconds);
      if (update.hardwareAdapter !== undefined)
        set("hardware_adapter", update.hardwareAdapter);
      if (update.videoEncoder !== undefined)
        set("video_encoder", update.videoEncoder);
      if (update.validation !== undefined) set("validation", update.validation);
      if (update.warnings !== undefined)
        set("warnings", JSON.stringify(update.warnings));
      if (update.errorCode !== undefined) set("error_code", update.errorCode);
      if (update.errorMessage !== undefined)
        set("error_message", update.errorMessage);
      if (update.stagingDirectory !== undefined)
        set("staging_directory", update.stagingDirectory);
      if (update.publishedVersion !== undefined)
        set("published_version", update.publishedVersion);
      if (update.pauseRequested !== undefined) {
        set("pause_requested", update.pauseRequested);
      }
      if (update.pausedReason !== undefined) {
        set("paused_reason", update.pausedReason);
      }
      if (update.cancellationRequested !== undefined) {
        set("cancellation_requested", update.cancellationRequested);
      }
      if (update.epochCount !== undefined)
        set("epoch_count", update.epochCount);
      if (update.epochIndex !== undefined)
        set("epoch_index", update.epochIndex);
      if (update.completedEpochs !== undefined)
        set("completed_epochs", update.completedEpochs);
      if (update.protectedSeconds !== undefined)
        set("protected_seconds", update.protectedSeconds);
      if (update.encodedSeconds !== undefined)
        set("encoded_seconds", update.encodedSeconds);
      if (update.sourceDurationSeconds !== undefined)
        set("source_duration_seconds", update.sourceDurationSeconds);
      if (update.epochStartSeconds !== undefined)
        set("epoch_start_seconds", update.epochStartSeconds);
      if (update.epochEndSeconds !== undefined)
        set("epoch_end_seconds", update.epochEndSeconds);
      if (update.checkpointBytes !== undefined)
        set("checkpoint_bytes", update.checkpointBytes);
      if (update.freeBytes !== undefined) set("free_bytes", update.freeBytes);
      if (update.startedAt !== undefined) set("started_at", update.startedAt);
      if (update.finishedAt !== undefined)
        set("finished_at", update.finishedAt);

      if (assignments.length === 0) return this.get(id);
      assignments.push("updated_at = now()");

      const result = await pool.query<RawRow>(
        `UPDATE processing_jobs SET ${assignments.join(", ")} WHERE id = $1 RETURNING ${COLUMNS}`,
        values,
      );
      return result.rows[0] ? toRecord(result.rows[0]) : null;
    },

    async requestPause(id, reason) {
      const result = await pool.query(
        `UPDATE processing_jobs
            SET pause_requested = true, paused_reason = $3, updated_at = now()
          WHERE id = $1 AND state = ANY($2::text[])
            AND cancellation_requested = false`,
        [id, ACTIVE_STATES, reason],
      );
      return (result.rowCount ?? 0) > 0;
    },

    /**
     * Clears the pause. A job the operator paused by hand is deliberately not
     * resumed by the storage coming back: the drive returning answers why the
     * machine paused it, not why a person did.
     */
    async resume(id, onlyReason) {
      const conditions = onlyReason ? "AND paused_reason = $3" : "";
      const values: unknown[] = [id, ACTIVE_STATES];
      if (onlyReason) values.push(onlyReason);
      const result = await pool.query(
        `UPDATE processing_jobs
            SET pause_requested = false, paused_reason = NULL,
                state = CASE WHEN state = 'paused' THEN 'running' ELSE state END,
                updated_at = now()
          WHERE id = $1 AND state = ANY($2::text[]) ${conditions}`,
        values,
      );
      return (result.rowCount ?? 0) > 0;
    },

    async listPaused(reason) {
      const result = await pool.query<RawRow>(
        `SELECT ${COLUMNS} FROM processing_jobs
          WHERE paused_reason = $1 ORDER BY created_at`,
        [reason],
      );
      return result.rows.map(toRecord);
    },

    async listActive() {
      const result = await pool.query<RawRow>(
        `SELECT ${COLUMNS} FROM processing_jobs
          WHERE state = ANY($1::text[]) ORDER BY created_at`,
        [ACTIVE_STATES],
      );
      return result.rows.map(toRecord);
    },

    async requestCancellation(id) {
      const result = await pool.query(
        `UPDATE processing_jobs
            SET cancellation_requested = true, updated_at = now()
          WHERE id = $1 AND state = ANY($2::text[])`,
        [id, ACTIVE_STATES],
      );
      return (result.rowCount ?? 0) > 0;
    },

    async beginAttempt(id, input) {
      /*
       * One statement, so a reader can see the whole boundary between what a
       * job keeps and what an attempt owns. Kept deliberately: the job's
       * identity, its source fingerprint, its attempt count, and
       * `published_version` — that names the package already on disk, which a
       * new attempt builds upon rather than replaces.
       */
      const result = await pool.query<RawRow>(
        `UPDATE processing_jobs SET
           state = 'queued',
           stage = 'waiting',
           stage_progress = 0,
           overall_progress = 0,
           bytes_processed = 0,
           output_bytes = NULL,
           estimated_output_bytes = $2,
           estimated_staging_bytes = COALESCE($3, estimated_staging_bytes),
           speed = NULL,
           fps = NULL,
           eta_seconds = NULL,
           validation = NULL,
           error_code = NULL,
           error_message = NULL,
           cancellation_requested = false,
           pause_requested = false,
           paused_reason = NULL,
           started_at = NULL,
           finished_at = NULL,
           /*
            * The epoch position describes an attempt, not the job, and is
            * rebuilt from the checkpoints the moment the next attempt
            * reconciles. What it must not do is carry the previous attempt's
            * "protected through 00:50:00" into a run that has not looked at
            * the disk yet.
            */
           epoch_index = NULL,
           completed_epochs = 0,
           protected_seconds = 0,
           encoded_seconds = 0,
           epoch_start_seconds = NULL,
           epoch_end_seconds = NULL,
           decision = COALESCE($4::jsonb, decision),
           stream_decisions = COALESCE($5::jsonb, stream_decisions),
           hardware_adapter = COALESCE($6, hardware_adapter),
           video_encoder = COALESCE($7, video_encoder),
           warnings = COALESCE($8::jsonb, warnings),
           updated_at = now()
         WHERE id = $1
         RETURNING ${COLUMNS}`,
        [
          id,
          input.estimatedOutputBytes ?? null,
          input.estimatedStagingBytes ?? null,
          input.decision ? JSON.stringify(input.decision) : null,
          input.streamDecisions ? JSON.stringify(input.streamDecisions) : null,
          input.hardwareAdapter ?? null,
          input.videoEncoder ?? null,
          input.warnings ? JSON.stringify(input.warnings) : null,
        ],
      );
      const row = result.rows[0];
      return row ? toRecord(row) : null;
    },

    async incrementAttempts(id) {
      const result = await pool.query<{ attempts: number }>(
        `UPDATE processing_jobs
            SET attempts = attempts + 1, updated_at = now()
          WHERE id = $1 RETURNING attempts`,
        [id],
      );
      return result.rows[0]?.attempts ?? 0;
    },

    async appendEvent(input) {
      const result = await pool.query<{
        id: string;
        sequence: number;
        created_at: Date;
      }>(
        `INSERT INTO processing_job_events
           (processing_job_id, sequence, stage, level, message, detail)
         VALUES (
           $1,
           COALESCE(
             (SELECT MAX(sequence) FROM processing_job_events WHERE processing_job_id = $1),
             0
           ) + 1,
           $2, $3, $4, $5
         )
         RETURNING id, sequence, created_at`,
        [
          input.processingJobId,
          input.stage,
          input.level ?? "info",
          input.message.slice(0, 500),
          input.detail ?? null,
        ],
      );
      const row = result.rows[0]!;
      return {
        id: Number(row.id),
        processingJobId: input.processingJobId,
        sequence: row.sequence,
        stage: input.stage,
        level: input.level ?? "info",
        message: input.message.slice(0, 500),
        detail: input.detail ?? null,
        createdAt: row.created_at,
      };
    },

    async listEvents(processingJobId, afterSequence = 0) {
      const result = await pool.query<{
        id: string;
        sequence: number;
        stage: ProcessingStage;
        level: "info" | "warning" | "error";
        message: string;
        detail: Record<string, unknown> | null;
        created_at: Date;
      }>(
        `SELECT id, sequence, stage, level, message, detail, created_at
           FROM processing_job_events
          WHERE processing_job_id = $1 AND sequence > $2
          ORDER BY sequence ASC
          LIMIT 500`,
        [processingJobId, afterSequence],
      );
      return result.rows.map((row) => ({
        id: Number(row.id),
        processingJobId,
        sequence: row.sequence,
        stage: row.stage,
        level: row.level,
        message: row.message,
        detail: row.detail,
        createdAt: row.created_at,
      }));
    },

    async counts() {
      const result = await pool.query<{
        state: ProcessingState;
        count: string;
      }>(
        `SELECT state, COUNT(*)::text AS count FROM processing_jobs GROUP BY state`,
      );
      const counts = {
        pending: 0,
        queued: 0,
        running: 0,
        paused: 0,
        succeeded: 0,
        failed: 0,
        cancelled: 0,
      } satisfies Record<ProcessingState, number>;
      for (const row of result.rows) counts[row.state] = Number(row.count);
      return counts;
    },

    async reconcileTerminalQueueJobs() {
      const result = await pool.query(
        `UPDATE processing_jobs AS processing SET
           state = CASE
             WHEN queue.status = 'cancelled' THEN 'cancelled'
             ELSE 'failed'
           END,
           error_code = CASE
             WHEN queue.status = 'cancelled' THEN 'CANCELLED'
             ELSE 'WORKER_STOPPED'
           END,
           error_message = CASE
             WHEN queue.status = 'cancelled' THEN 'Processing was cancelled.'
             ELSE COALESCE(
               NULLIF(queue.safe_error, ''),
               'The processing worker stopped before the job completed.'
             )
           END,
           speed = NULL,
           fps = NULL,
           eta_seconds = NULL,
           finished_at = COALESCE(queue.finished_at, now()),
           updated_at = now()
         FROM jobs AS queue
         WHERE processing.job_id = queue.id
           AND processing.state = ANY($1::text[])
           AND queue.status IN ('failed', 'cancelled')`,
        [ACTIVE_STATES],
      );
      return result.rowCount ?? 0;
    },

    async findInterrupted() {
      const result = await pool.query<RawRow>(
        `SELECT ${COLUMNS} FROM processing_jobs WHERE state = 'running'`,
      );
      return result.rows.map(toRecord);
    },
  };
}
