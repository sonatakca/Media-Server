import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type { DatabasePool } from "../database/databasePool";
import type { CatalogueRepository } from "../catalogue/catalogueRepository";
import { buildTrickplayLayout, type TrickplayLayout } from "./trickplayLayout";

export interface TrickplaySet extends TrickplayLayout {
  id: string;
  mediaFileId: string;
  storagePrefix: string;
  contentType: string;
}

export interface TrickplayService {
  findForItem(itemId: string): Promise<TrickplaySet | null>;
  findById(setId: string): Promise<TrickplaySet | null>;
  spritePath(set: TrickplaySet, spriteIndex: number): string;
  /** Generates sheets for an item's primary file. Returns null if not possible. */
  generateForItem(itemId: string): Promise<TrickplaySet | null>;
  deleteForItem(itemId: string): Promise<void>;
}

interface RawSetRow {
  id: string;
  media_file_id: string;
  tile_width: number;
  tile_height: number;
  columns: number;
  rows: number;
  interval_ms: number;
  thumbnail_count: number;
  sprite_count: number;
  storage_prefix: string;
  content_type: string;
}

function toSet(row: RawSetRow): TrickplaySet {
  return {
    id: row.id,
    mediaFileId: row.media_file_id,
    tileWidth: row.tile_width,
    tileHeight: row.tile_height,
    columns: row.columns,
    rows: row.rows,
    intervalMs: row.interval_ms,
    thumbnailCount: row.thumbnail_count,
    spriteCount: row.sprite_count,
    storagePrefix: row.storage_prefix,
    contentType: row.content_type,
  };
}

const SET_COLUMNS = `
  id, media_file_id, tile_width, tile_height, columns, rows,
  interval_ms, thumbnail_count, sprite_count, storage_prefix, content_type
`;

export interface CreateTrickplayServiceOptions {
  pool: DatabasePool;
  catalogue: CatalogueRepository;
  mediaRoot: string;
  /** Sheets are written under `<generatedStoragePath>/trickplay`. */
  generatedStoragePath: string;
  ffmpegPath?: string;
  /** Injected in tests so no FFmpeg process is spawned. */
  runFfmpeg?: (args: string[]) => Promise<void>;
}

export function createTrickplayService({
  pool,
  catalogue,
  mediaRoot,
  generatedStoragePath,
  ffmpegPath = "ffmpeg",
  runFfmpeg,
}: CreateTrickplayServiceOptions): TrickplayService {
  const trickplayRoot = path.join(generatedStoragePath, "trickplay");

  const execute =
    runFfmpeg ??
    ((args: string[]) =>
      new Promise<void>((resolve, reject) => {
        // Argument array only — never a shell string, so a filename containing
        // shell metacharacters cannot become a command.
        const child = spawn(ffmpegPath, args, {
          stdio: ["ignore", "ignore", "pipe"],
        });
        let stderr = "";
        child.stderr?.on("data", (chunk: Buffer) => {
          stderr = (stderr + chunk.toString()).slice(-2_000);
        });
        child.on("error", () =>
          reject(new Error("FFmpeg could not be started.")),
        );
        child.on("close", (code) => {
          if (code === 0) resolve();
          // The stderr tail carries the source path, so it is deliberately not
          // included in the error that reaches a job record.
          else reject(new Error("Trickplay generation failed."));
        });
      }));

  async function findByMediaFile(
    mediaFileId: string,
  ): Promise<TrickplaySet | null> {
    const result = await pool.query<RawSetRow>(
      `SELECT ${SET_COLUMNS} FROM trickplay_sets WHERE media_file_id = $1 LIMIT 1`,
      [mediaFileId],
    );
    const row = result.rows[0];
    return row ? toSet(row) : null;
  }

  return {
    findForItem: async (itemId) => {
      const file = await catalogue.getPrimaryFile(itemId);
      return file ? findByMediaFile(file.id) : null;
    },

    findById: async (setId) => {
      const result = await pool.query<RawSetRow>(
        `SELECT ${SET_COLUMNS} FROM trickplay_sets WHERE id = $1`,
        [setId],
      );
      const row = result.rows[0];
      return row ? toSet(row) : null;
    },

    spritePath: (set, spriteIndex) =>
      path.join(trickplayRoot, set.storagePrefix, `sprite_${spriteIndex}.jpg`),

    generateForItem: async (itemId) => {
      const file = await catalogue.getPrimaryFile(itemId);
      if (!file || file.probeState !== "probed" || file.durationMs === null) {
        return null;
      }

      const existing = await findByMediaFile(file.id);
      if (existing) return existing;

      const streams = await catalogue.listStreams(file.id);
      const video = streams.find((stream) => stream.kind === "video");
      if (!video?.width || !video.height) return null;

      const layout = buildTrickplayLayout({
        durationMs: Number(file.durationMs),
        sourceWidth: video.width,
        sourceHeight: video.height,
      });

      const storagePrefix = randomUUID();
      const outputDirectory = path.join(trickplayRoot, storagePrefix);
      await mkdir(outputDirectory, { recursive: true });

      try {
        // One pass produces every sheet: fps selects a frame per interval, and
        // tile packs them, so the source is decoded once rather than seeked to
        // thousands of times.
        await execute([
          "-hide_banner",
          "-loglevel",
          "error",
          "-i",
          path.resolve(mediaRoot, ...file.relativePath.split("/")),
          "-vf",
          `fps=1/${layout.intervalMs / 1_000},scale=${layout.tileWidth}:${layout.tileHeight},tile=${layout.columns}x${layout.rows}`,
          "-an",
          "-sn",
          "-qscale:v",
          "5",
          path.join(outputDirectory, "sprite_%d.jpg"),
        ]);
      } catch (error) {
        await rm(outputDirectory, { recursive: true, force: true }).catch(
          () => undefined,
        );
        throw error;
      }

      const inserted = await pool.query<RawSetRow>(
        `INSERT INTO trickplay_sets (
           id, media_file_id, tile_width, tile_height, columns, rows,
           interval_ms, thumbnail_count, sprite_count, storage_prefix
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (media_file_id, tile_width) DO UPDATE SET
           storage_prefix = EXCLUDED.storage_prefix
         RETURNING ${SET_COLUMNS}`,
        [
          randomUUID(),
          file.id,
          layout.tileWidth,
          layout.tileHeight,
          layout.columns,
          layout.rows,
          layout.intervalMs,
          layout.thumbnailCount,
          layout.spriteCount,
          storagePrefix,
        ],
      );

      const row = inserted.rows[0];
      return row ? toSet(row) : null;
    },

    deleteForItem: async (itemId) => {
      const file = await catalogue.getPrimaryFile(itemId);
      if (!file) return;

      const existing = await findByMediaFile(file.id);
      if (!existing) return;

      await pool.query(`DELETE FROM trickplay_sets WHERE id = $1`, [
        existing.id,
      ]);
      await rm(path.join(trickplayRoot, existing.storagePrefix), {
        recursive: true,
        force: true,
      }).catch(() => undefined);
    },
  };
}
