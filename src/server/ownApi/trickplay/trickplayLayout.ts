/**
 * Trickplay sprite geometry.
 *
 * Kept pure because the seek bar has to compute, from a hover position alone,
 * which sprite sheet to request and where the tile sits inside it. Client and
 * server must agree exactly; a one-tile drift shows the wrong frame.
 */

export interface TrickplayLayout {
  tileWidth: number;
  tileHeight: number;
  columns: number;
  rows: number;
  intervalMs: number;
  thumbnailCount: number;
  spriteCount: number;
}

export interface TrickplayTilePosition {
  spriteIndex: number;
  /** Zero-based tile position inside the sprite sheet. */
  column: number;
  row: number;
  /** Pixel offset of the tile inside the sheet. */
  x: number;
  y: number;
}

export const DEFAULT_TILE_WIDTH = 320;
export const DEFAULT_COLUMNS = 10;
export const DEFAULT_ROWS = 10;
export const DEFAULT_INTERVAL_MS = 10_000;

export interface BuildLayoutOptions {
  durationMs: number;
  sourceWidth: number;
  sourceHeight: number;
  tileWidth?: number;
  columns?: number;
  rows?: number;
  intervalMs?: number;
}

export function buildTrickplayLayout({
  durationMs,
  sourceWidth,
  sourceHeight,
  tileWidth = DEFAULT_TILE_WIDTH,
  columns = DEFAULT_COLUMNS,
  rows = DEFAULT_ROWS,
  intervalMs = DEFAULT_INTERVAL_MS,
}: BuildLayoutOptions): TrickplayLayout {
  if (durationMs <= 0 || sourceWidth <= 0 || sourceHeight <= 0) {
    throw new Error("Trickplay requires a probed duration and frame size.");
  }

  // Tile height follows the source aspect ratio, rounded to an even number
  // because most encoders reject odd dimensions.
  const rawHeight = Math.round((tileWidth * sourceHeight) / sourceWidth);
  const tileHeight = Math.max(2, rawHeight - (rawHeight % 2));

  const thumbnailCount = Math.max(1, Math.ceil(durationMs / intervalMs));
  const perSheet = columns * rows;
  const spriteCount = Math.ceil(thumbnailCount / perSheet);

  return {
    tileWidth,
    tileHeight,
    columns,
    rows,
    intervalMs,
    thumbnailCount,
    spriteCount,
  };
}

/**
 * Maps a playback position to the tile that represents it. Positions past the
 * end clamp to the last tile rather than returning a sheet that does not exist.
 */
export function locateTrickplayTile(
  layout: TrickplayLayout,
  positionMs: number,
): TrickplayTilePosition {
  const index = Math.min(
    layout.thumbnailCount - 1,
    Math.max(0, Math.floor(positionMs / layout.intervalMs)),
  );
  const perSheet = layout.columns * layout.rows;
  const spriteIndex = Math.floor(index / perSheet);
  const withinSheet = index % perSheet;
  const row = Math.floor(withinSheet / layout.columns);
  const column = withinSheet % layout.columns;

  return {
    spriteIndex,
    column,
    row,
    x: column * layout.tileWidth,
    y: row * layout.tileHeight,
  };
}

/** Tiles present in a given sheet; the final sheet is usually partial. */
export function tilesInSprite(
  layout: TrickplayLayout,
  spriteIndex: number,
): number {
  const perSheet = layout.columns * layout.rows;
  const remaining = layout.thumbnailCount - spriteIndex * perSheet;
  return Math.max(0, Math.min(perSheet, remaining));
}
