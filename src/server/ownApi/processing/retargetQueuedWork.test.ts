import { describe, expect, it } from "vitest";
import type { DatabasePool } from "../database/databasePool";
import { createQueuedWorkRetargeter } from "./retargetQueuedWork";

const SEASON = "Series/Andor/Season 1";
const EPISODE = `${SEASON}/Andor - S01E01 - Kassa.mp4`;
const MOVED = `${SEASON}/src/Andor - S01E01 - Kassa.mp4`;

function pool(rows: Array<{ id: string; payload: Record<string, unknown> }>) {
  const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];

  const query = async (text: string, values?: unknown[]) => {
    if (text.includes("SELECT")) return { rows, rowCount: rows.length };
    updates.push({
      id: values?.[0] as string,
      patch: JSON.parse(values?.[1] as string) as Record<string, unknown>,
    });
    return { rows: [], rowCount: 1 };
  };

  return { pool: { query } as unknown as DatabasePool, updates };
}

describe("pointing queued encodes at a moved source", () => {
  it("rewrites both paths a queued attempt runs on", async () => {
    const { pool: database, updates } = pool([
      {
        id: "job-1",
        payload: {
          relativePath: EPISODE,
          sourcePath: `/Volumes/Expansion/media/${EPISODE}`,
          titleRoot: `/Volumes/Expansion/media/${SEASON}/Andor - S01E01 - Kassa`,
        },
      },
    ]);

    const retargeted = await createQueuedWorkRetargeter(database).retarget([
      { from: EPISODE, to: MOVED, reason: "source" },
    ]);

    expect(retargeted).toBe(1);
    expect(updates).toEqual([
      {
        id: "job-1",
        patch: {
          relativePath: MOVED,
          sourcePath: `/Volumes/Expansion/media/${MOVED}`,
        },
      },
    ]);
  });

  /*
   * The destination is unchanged by design — a title root does not move when
   * its sources do — so rewriting it would be inventing a change, and the
   * merge patch deliberately leaves it out.
   */
  it("leaves the publish destination alone", async () => {
    const { pool: database, updates } = pool([
      {
        id: "job-1",
        payload: {
          relativePath: EPISODE,
          sourcePath: `/media/${EPISODE}`,
          titleRoot: `/media/${SEASON}/Andor - S01E01 - Kassa`,
        },
      },
    ]);

    await createQueuedWorkRetargeter(database).retarget([
      { from: EPISODE, to: MOVED, reason: "source" },
    ]);

    expect(updates[0]?.patch).not.toHaveProperty("titleRoot");
  });

  it("ignores an attempt whose source did not move", async () => {
    const { pool: database, updates } = pool([
      {
        id: "job-1",
        payload: {
          relativePath: `${SEASON}/Andor - S01E02 - That Would Be Me.mp4`,
          sourcePath: `/media/${SEASON}/Andor - S01E02 - That Would Be Me.mp4`,
        },
      },
    ]);

    const retargeted = await createQueuedWorkRetargeter(database).retarget([
      { from: EPISODE, to: MOVED, reason: "source" },
    ]);

    expect(retargeted).toBe(0);
    expect(updates).toEqual([]);
  });

  /*
   * A row whose absolute path does not end in the relative one is a row this
   * cannot reason about — a different media root, a symlinked mount. Guessing
   * would hand FFmpeg a path on a volume nobody asked about.
   */
  it("refuses a row whose two paths do not agree", async () => {
    const { pool: database, updates } = pool([
      {
        id: "job-1",
        payload: {
          relativePath: EPISODE,
          sourcePath: "/somewhere/else/entirely.mp4",
        },
      },
    ]);

    const retargeted = await createQueuedWorkRetargeter(database).retarget([
      { from: EPISODE, to: MOVED, reason: "source" },
    ]);

    expect(retargeted).toBe(0);
    expect(updates).toEqual([]);
  });

  it("does nothing when nothing moved", async () => {
    const { pool: database, updates } = pool([]);

    expect(await createQueuedWorkRetargeter(database).retarget([])).toBe(0);
    expect(updates).toEqual([]);
  });
});
