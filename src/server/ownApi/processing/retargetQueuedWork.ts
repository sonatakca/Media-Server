import type { DatabasePool } from "../database/databasePool";
import type { OrganizeMove } from "../scanner/organizeLibrary";

/**
 * Points a queued encode at a source the organiser moved.
 *
 * A processing attempt freezes its absolute `sourcePath` into the queue row at
 * the moment it is queued, and nothing re-reads it before FFmpeg is handed the
 * path — that is what makes a queued attempt different from a paused one,
 * which rebuilds its payload from the catalogue when it resumes.
 *
 * The organiser already stands down while anything is queued or running, so in
 * normal operation this finds nothing. It exists for the seconds between that
 * check and the last rename, in which somebody can press Process on a title in
 * the library being moved: without it that attempt would run against a path
 * that no longer exists and fail for a reason nobody could see from the page.
 *
 * A *running* row is deliberately left alone. Its FFmpeg already holds the old
 * path and rewriting the row underneath it would only disagree with what the
 * encode is actually doing — and the organiser does not move files while one
 * is running.
 */
export interface QueuedWorkRetargeter {
  /** Returns how many queued attempts were pointed at their new path. */
  retarget(moves: OrganizeMove[]): Promise<number>;
}

interface ProcessingPayload {
  relativePath?: unknown;
  sourcePath?: unknown;
}

/**
 * The absolute path of a moved file, without needing to know the media root.
 *
 * A queued row's `sourcePath` always ends with its `relativePath`, so swapping
 * that suffix is exact — and it cannot invent a path on a different volume the
 * way rebuilding from a configured root could.
 */
function retargetSourcePath(
  sourcePath: string,
  from: string,
  to: string,
): string | null {
  if (!sourcePath.endsWith(from)) return null;
  return sourcePath.slice(0, sourcePath.length - from.length) + to;
}

export function createQueuedWorkRetargeter(
  pool: DatabasePool,
): QueuedWorkRetargeter {
  return {
    retarget: async (moves) => {
      const destinations = new Map(moves.map((move) => [move.from, move.to]));
      if (destinations.size === 0) return 0;

      const rows = await pool.query<{ id: string; payload: ProcessingPayload }>(
        `SELECT id, payload FROM jobs
          WHERE job_type = 'media.process' AND status = 'queued'`,
      );

      let retargeted = 0;
      for (const row of rows.rows) {
        const { relativePath, sourcePath } = row.payload;
        if (
          typeof relativePath !== "string" ||
          typeof sourcePath !== "string"
        ) {
          continue;
        }
        const to = destinations.get(relativePath);
        if (to === undefined) continue;
        const nextSourcePath = retargetSourcePath(sourcePath, relativePath, to);
        if (nextSourcePath === null) continue;

        // Still queued, checked in the statement itself: a row the worker
        // claimed while this was deciding must not be rewritten under it.
        const updated = await pool.query(
          `UPDATE jobs
              SET payload = payload || $2::jsonb
            WHERE id = $1 AND job_type = 'media.process' AND status = 'queued'`,
          [
            row.id,
            JSON.stringify({ relativePath: to, sourcePath: nextSourcePath }),
          ],
        );
        retargeted += updated.rowCount ?? 0;
      }
      return retargeted;
    },
  };
}
