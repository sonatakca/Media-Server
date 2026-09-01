import { describe, expect, it } from "vitest";
import type { DatabasePool } from "../database/databasePool";
import { createProbeService } from "./probeService";

const LIBRARY_ID = "11111111-1111-4111-8111-111111111111";

describe("probe service", () => {
  it("scopes scan-owned probe batches and their remaining count to a library", async () => {
    const queries: Array<{ sql: string; values: unknown[] }> = [];
    const pool = {
      query: async (sql: string, values: unknown[] = []) => {
        queries.push({ sql, values });
        return sql.includes("count(*)")
          ? { rows: [{ total: "0" }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      },
    } as unknown as DatabasePool;

    const result = await createProbeService({
      pool,
      mediaRoot: "/media",
      analyse: async () => {
        throw new Error("No pending file should be analysed.");
      },
    }).runBatch(LIBRARY_ID);

    expect(result).toEqual({ probed: 0, failed: 0, remaining: 0 });
    expect(queries).toHaveLength(2);
    expect(queries[0]?.sql).toContain("i.library_id = $2");
    expect(queries[0]?.values).toEqual([8, LIBRARY_ID]);
    expect(queries[1]?.sql).toContain("i.library_id = $1");
    expect(queries[1]?.values).toEqual([LIBRARY_ID]);
  });
});
