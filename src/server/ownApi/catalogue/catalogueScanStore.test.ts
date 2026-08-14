import { describe, expect, it } from "vitest";
import type { DatabasePool } from "../database/databasePool";
import { createCatalogueScanStore } from "./catalogueScanStore";

describe("catalogue scan subtitle association", () => {
  it("moves sidecars off missing cuts and onto the active primary file", async () => {
    const calls: Array<{ sql: string; values: unknown[] | undefined }> = [];
    const pool = {
      query: async (sql: string, values?: unknown[]) => {
        calls.push({ sql, values });
        return sql.includes("SELECT id FROM media_files")
          ? { rows: [{ id: "active-file" }] }
          : { rows: [] };
      },
    } as unknown as DatabasePool;

    await createCatalogueScanStore(pool).replaceExternalSubtitles("item-1", [
      {
        relativePath: "Movies/Movie/Movie.tr.srt",
        codec: "subrip",
        isText: true,
        language: "tr",
        isDefault: false,
        isForced: false,
      },
    ]);

    expect(calls[0]?.sql).toContain("missing_since IS NULL");
    expect(calls[1]?.sql).toContain(
      "media_file_id IN (SELECT id FROM media_files WHERE item_id = $1)",
    );
    expect(calls[1]?.values).toEqual(["item-1"]);
    expect(calls[2]?.values).toEqual([
      "active-file",
      10_000,
      "subrip",
      "tr",
      false,
      false,
      true,
      "Movies/Movie/Movie.tr.srt",
    ]);
  });
});
