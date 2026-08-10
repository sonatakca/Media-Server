import path from "node:path";
import type { DatabasePool } from "../database/databasePool";
import { analyseMediaFile } from "../../../lib/playback-planner/mediaAnalysis";
import type { MediaAnalysis } from "../../../lib/playback-planner/types";
import { toPersistedProbe, type PersistedProbe } from "./probeInventory";

export interface ProbeServiceOptions {
  pool: DatabasePool;
  mediaRoot: string;
  ffprobePath?: string;
  /** Injected in tests so no ffprobe process is spawned. */
  analyse?: (filePath: string, mediaId: string) => Promise<MediaAnalysis>;
  batchSize?: number;
}

export interface ProbeBatchResult {
  probed: number;
  failed: number;
  remaining: number;
}

interface PendingFile {
  id: string;
  item_id: string;
  relative_path: string;
}

/**
 * Failure messages are stored for operators but must never carry a filesystem
 * path or an ffprobe argument list, both of which routinely appear in stderr.
 */
function sanitizeProbeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const firstLine = message.split("\n", 1)[0] ?? "";
  return firstLine
    .replace(/(^|\s)(?:[A-Za-z]:)?[\\/][^\s]*/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, 480) || "The media file could not be analysed.";
}

export function createProbeService({
  pool,
  mediaRoot,
  ffprobePath,
  analyse,
  batchSize = 8,
}: ProbeServiceOptions) {
  const analyseFile =
    analyse ??
    ((filePath: string, mediaId: string) =>
      analyseMediaFile(filePath, mediaId, ffprobePath ?? "ffprobe"));

  async function persist(
    mediaFileId: string,
    itemId: string,
    probe: PersistedProbe,
  ): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      await client.query(
        `UPDATE media_files
         SET duration_ms = $2,
             bitrate_bps = $3,
             container = COALESCE($4, container),
             probe_state = 'probed',
             probe_error = NULL,
             probed_at = now(),
             updated_at = now()
         WHERE id = $1`,
        [mediaFileId, probe.durationMs, probe.bitrateBps, probe.container],
      );

      // Externally discovered subtitle tracks are owned by the scanner, so a
      // re-probe replaces only the streams that came out of the container.
      await client.query(
        `DELETE FROM media_streams WHERE media_file_id = $1 AND is_external = false`,
        [mediaFileId],
      );

      for (const stream of probe.streams) {
        await client.query(
          `INSERT INTO media_streams (
             media_file_id, stream_index, kind, codec, profile, level, language, title,
             is_default, is_forced, is_external, is_text_subtitle,
             channels, sample_rate, bitrate_bps, width, height, pixel_format,
             frame_rate, video_range, color_transfer, color_primaries, color_space, bit_depth
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8,
             $9, $10, false, $11,
             $12, $13, $14, $15, $16, $17,
             $18, $19, $20, $21, $22, $23
           )
           ON CONFLICT (media_file_id, stream_index) DO NOTHING`,
          [
            mediaFileId,
            stream.streamIndex,
            stream.kind,
            stream.codec,
            stream.profile,
            stream.level,
            stream.language,
            stream.title,
            stream.isDefault,
            stream.isForced,
            stream.isTextSubtitle,
            stream.channels,
            stream.sampleRate,
            stream.bitrateBps,
            stream.width,
            stream.height,
            stream.pixelFormat,
            stream.frameRate,
            stream.videoRange,
            stream.colorTransfer,
            stream.colorPrimaries,
            stream.colorSpace,
            stream.bitDepth,
          ],
        );
      }

      // Chapters belong to the logical item, and only the primary file defines
      // them; an alternate cut must not overwrite the canonical chapter list.
      const isPrimary = await client.query<{ is_primary: boolean }>(
        `SELECT is_primary FROM media_files WHERE id = $1`,
        [mediaFileId],
      );
      if (isPrimary.rows[0]?.is_primary) {
        await client.query(`DELETE FROM item_chapters WHERE item_id = $1`, [
          itemId,
        ]);
        for (const chapter of probe.chapters) {
          await client.query(
            `INSERT INTO item_chapters (item_id, chapter_index, start_ms, name)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (item_id, chapter_index) DO NOTHING`,
            [itemId, chapter.chapterIndex, chapter.startMs, chapter.name],
          );
        }

        // The item's runtime comes from its primary file.
        if (probe.durationMs !== null) {
          await client.query(
            `UPDATE items SET runtime_ms = $2, updated_at = now()
             WHERE id = $1 AND runtime_ms IS DISTINCT FROM $2`,
            [itemId, probe.durationMs],
          );
        }
      }

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  return {
    /** Probes one batch of pending files. Returns counts for the job report. */
    runBatch: async (): Promise<ProbeBatchResult> => {
      const pending = await pool.query<PendingFile>(
        `SELECT id, item_id, relative_path
         FROM media_files
         WHERE probe_state = 'pending' AND missing_since IS NULL
         ORDER BY is_primary DESC, created_at
         LIMIT $1`,
        [batchSize],
      );

      let probed = 0;
      let failed = 0;

      for (const file of pending.rows) {
        const absolutePath = path.resolve(
          mediaRoot,
          ...file.relative_path.split("/"),
        );

        try {
          const analysis = await analyseFile(absolutePath, file.id);
          await persist(file.id, file.item_id, toPersistedProbe(analysis));
          probed += 1;
        } catch (error) {
          failed += 1;
          await pool.query(
            `UPDATE media_files
             SET probe_state = 'failed', probe_error = $2, probed_at = now(), updated_at = now()
             WHERE id = $1`,
            [file.id, sanitizeProbeError(error)],
          );
        }
      }

      const remaining = await pool.query<{ total: string }>(
        `SELECT count(*) AS total FROM media_files
         WHERE probe_state = 'pending' AND missing_since IS NULL`,
        [],
      );

      return {
        probed,
        failed,
        remaining: Number(remaining.rows[0]?.total ?? 0),
      };
    },
  };
}
