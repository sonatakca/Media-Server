// @vitest-environment node
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { readSchemaState } from "./migrationRunner";

/*
 * The table name is the whole point of these tests.
 *
 * Operational backup scripts asked `schema_migrations` for years — a table that
 * has never existed in this schema — and PostgreSQL answered with an error the
 * scripts discarded, so a restore-verification step that printed a migration
 * count as its evidence printed nothing. A count that is silently empty is
 * worse than no count, because it reads as a check that passed.
 */
let migrations: string;

beforeAll(async () => {
  migrations = await mkdtemp(path.join(tmpdir(), "seyirlik-schema-"));
  for (const name of ["001_first.sql", "002_second.sql", "003_third.sql"]) {
    await writeFile(path.join(migrations, name), `-- ${name}\n`);
  }
});

afterAll(async () => {
  await rm(migrations, { recursive: true, force: true });
});

/** `pg`'s `query` is heavily overloaded; the cast is at this one boundary. */
function database(
  rows: string[],
  onQuery?: (sql: string) => void,
): Pick<Pool, "query"> {
  return {
    query: vi.fn(async (sql: string) => {
      onQuery?.(sql);
      if (!/seyirlik_migrations/.test(sql)) {
        // Exactly what PostgreSQL does for the name the scripts used.
        throw Object.assign(
          new Error('relation "schema_migrations" does not exist'),
          { code: "42P01" },
        );
      }
      return { rows: rows.map((version) => ({ version })) };
    }),
  } as unknown as Pick<Pool, "query">;
}

describe("reading the schema a database is carrying", () => {
  it("asks the table that actually exists", async () => {
    let asked = "";
    await readSchemaState(
      database(["001_first"], (sql) => (asked = sql)),
      migrations,
    );
    expect(asked).toContain("seyirlik_migrations");
    expect(asked).not.toContain("schema_migrations");
  });

  it("reports the count and the newest version", async () => {
    const state = await readSchemaState(
      database(["001_first", "002_second", "003_third"]),
      migrations,
    );
    expect(state).toEqual({
      applied: 3,
      latest: "003_third",
      current: true,
      pending: [],
    });
  });

  it("names what the code has that the database does not", async () => {
    /*
     * The direction that matters operationally: code shipped ahead of its
     * schema is what stops a service starting, so the report has to say which
     * migrations are missing rather than only that something is wrong.
     */
    const state = await readSchemaState(database(["001_first"]), migrations);
    expect(state.current).toBe(false);
    expect(state.pending).toEqual(["002_second", "003_third"]);
    expect(state.latest).toBe("001_first");
  });

  it("treats a database that was never migrated as a state, not an error", async () => {
    const empty = {
      query: vi.fn(async () => {
        throw Object.assign(new Error("no such table"), { code: "42P01" });
      }),
    } as unknown as Pick<Pool, "query">;
    const state = await readSchemaState(empty, migrations);
    expect(state).toMatchObject({ applied: 0, latest: null, current: false });
    expect(state.pending).toHaveLength(3);
  });

  it("never reports a blank count as though it were a passing check", async () => {
    // The failure this replaces: an empty answer that read like success.
    const state = await readSchemaState(database([]), migrations);
    expect(state.applied).toBe(0);
    expect(state.current).toBe(false);
  });
});
