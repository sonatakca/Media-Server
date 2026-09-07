import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  CatalogueRepository,
  MediaFileRow,
} from "../catalogue/catalogueRepository";
import type { DatabasePool } from "../database/databasePool";
import { buildTrickplayLayout } from "./trickplayLayout";
import { migrateLegacyTrickplaySets } from "./trickplayMigration";
import { jpegBytes, writeTrickplaySheets } from "./trickplayTestFixtures";
import { denyWritesInto } from "../../../test/unwritableDirectory";

const LAYOUT = buildTrickplayLayout({
  durationMs: 3_600_000,
  sourceWidth: 1920,
  sourceHeight: 1080,
});
const WIDTH = LAYOUT.columns * LAYOUT.tileWidth;
const HEIGHT = LAYOUT.rows * LAYOUT.tileHeight;

const FILE: MediaFileRow = {
  id: "11111111-1111-4111-8111-111111111111",
  itemId: "22222222-2222-4222-8222-222222222222",
  relativePath: "Movies/Dune (2021)/src/Dune (2021).mkv",
  container: "mkv",
  sizeBytes: "1",
  mtimeMs: "1",
  fingerprint: "f",
  durationMs: "3600000",
  bitrateBps: null,
  isPrimary: true,
  probeState: "probed",
  missingSince: null,
};

const PREFIX = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

/**
 * The 29 sets this server wrote under its previous layout, moved into the title
 * folders they belong to.
 *
 * These are Seyirlik's own output. They are not the Jellyfin-era
 * `*.trickplay` folders, they do not go to the operator's archive, and the two
 * populations are never handled by the same code path.
 */
describe("migrating this server's own older trickplay sets", () => {
  let base: string;
  let mediaRoot: string;
  let generatedStorage: string;
  let rows: Array<Record<string, unknown>>;
  let file: MediaFileRow | null;
  let updates: unknown[][];

  const legacyRoot = () => path.join(generatedStorage, "trickplay");
  const legacySet = () => path.join(legacyRoot(), PREFIX);
  const titleRoot = () => path.join(mediaRoot, "Movies", "Dune (2021)");
  const destination = () => path.join(titleRoot(), "trickplay");

  function dependencies() {
    const pool = {
      query: async (text: string, values?: unknown[]) => {
        if (text.trimStart().startsWith("SELECT")) {
          // The real statement selects only unmigrated sets; a fake that
          // returned everything would hide the property idempotence rests on.
          const legacy = rows.filter((row) => row.storage_prefix !== null);
          return { rows: legacy, rowCount: legacy.length };
        }
        updates.push(values ?? []);
        rows = rows.map((row) =>
          row.id === values?.[0]
            ? { ...row, storage_prefix: null, sprite_count: values?.[1] }
            : row,
        );
        return { rows: [], rowCount: 1 };
      },
    } as unknown as DatabasePool;

    const catalogue = {
      getFileById: async () => file,
      getItemKind: async () => "movie",
    } as unknown as CatalogueRepository;

    return {
      pool,
      catalogue,
      mediaRoot,
      generatedStoragePath: generatedStorage,
    };
  }

  beforeEach(async () => {
    base = await mkdtemp(path.join(tmpdir(), "trickplay-migrate-"));
    mediaRoot = path.join(base, "media");
    generatedStorage = path.join(base, "generated");
    await mkdir(path.join(titleRoot(), "src"), { recursive: true });
    await writeTrickplaySheets({
      directory: legacySet(),
      count: LAYOUT.spriteCount,
      width: WIDTH,
      height: HEIGHT,
    });
    file = FILE;
    updates = [];
    rows = [
      {
        id: "33333333-3333-4333-8333-333333333333",
        media_file_id: FILE.id,
        tile_width: LAYOUT.tileWidth,
        tile_height: LAYOUT.tileHeight,
        columns: LAYOUT.columns,
        rows: LAYOUT.rows,
        interval_ms: LAYOUT.intervalMs,
        thumbnail_count: LAYOUT.thumbnailCount,
        sprite_count: LAYOUT.spriteCount,
        storage_prefix: PREFIX,
      },
    ];
  });

  afterEach(async () => {
    await chmod(legacyRoot(), 0o755).catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  });

  it("copies the set into the title folder, verifies it, then removes the old one", async () => {
    const report = await migrateLegacyTrickplaySets(dependencies());

    expect(report.outcomes[0]?.status).toBe("migrated");
    expect((await readdir(destination())).sort()).toEqual(
      Array.from(
        { length: LAYOUT.spriteCount },
        (_, index) => `sprite_${index}.jpg`,
      ).sort(),
    );
    // The old directory goes only after the new one exists and is recorded.
    expect(await readdir(legacyRoot()).catch(() => null)).toBeNull();
    expect(updates[0]?.[0]).toBe("33333333-3333-4333-8333-333333333333");
  });

  /*
   * What every one of the real sets actually looks like.
   *
   * The library is on exFAT, so each `sprite_N.jpg` FFmpeg wrote has a `._`
   * AppleDouble twin holding the `com.apple.provenance` tag macOS could not
   * store in the file. Before sidecars were recognised as filesystem noise
   * rather than encoder output, this shape made the dry run report all
   * twenty-three sets as `invalid-source` — "holds files that are not sheets" —
   * and nothing could be migrated at all.
   */
  it("migrates a set carrying the AppleDouble sidecars an exFAT library writes", async () => {
    for (let index = 0; index < LAYOUT.spriteCount; index += 1) {
      await writeFile(
        path.join(legacySet(), `._sprite_${index}.jpg`),
        Buffer.alloc(4_096),
      );
    }

    const report = await migrateLegacyTrickplaySets(dependencies());

    expect(report.outcomes[0]?.status).toBe("migrated");
    // The sheets are all there, and the sidecars travelled with them rather
    // than being silently dropped from a verified copy.
    const arrived = (await readdir(destination())).sort();
    for (let index = 0; index < LAYOUT.spriteCount; index += 1) {
      expect(arrived).toContain(`sprite_${index}.jpg`);
      expect(arrived).toContain(`._sprite_${index}.jpg`);
    }
    expect(rows[0]?.storage_prefix).toBeNull();
    expect(await readdir(legacyRoot()).catch(() => null)).toBeNull();
    /*
     * The row must count sheets, not files. With a sidecar per sheet the two
     * differ by a factor of two, and a row claiming twice as many sheets as
     * were written sends the seek bar after sheets that do not exist.
     */
    expect(rows[0]?.sprite_count).toBe(LAYOUT.spriteCount);
    expect(updates[0]?.[1]).toBe(LAYOUT.spriteCount);
  });

  it("clears the storage prefix, which is what marks the set as migrated", async () => {
    await migrateLegacyTrickplaySets(dependencies());

    expect(rows[0]?.storage_prefix).toBeNull();
  });

  it("moves the bytes unchanged", async () => {
    const before = await readFile(path.join(legacySet(), "sprite_0.jpg"));

    await migrateLegacyTrickplaySets(dependencies());

    expect(await readFile(path.join(destination(), "sprite_0.jpg"))).toEqual(
      before,
    );
  });

  it("writes nothing and removes nothing on a dry run", async () => {
    const report = await migrateLegacyTrickplaySets({
      ...dependencies(),
      dryRun: true,
    });

    expect(report.outcomes[0]?.status).toBe("migrated");
    expect(await readdir(legacySet())).toHaveLength(LAYOUT.spriteCount);
    await expect(readdir(destination())).rejects.toThrow();
    expect(updates).toEqual([]);
  });

  /*
   * The invariant that makes this safe to run on a real library: nothing is
   * deleted that has not been proved to exist somewhere else.
   */
  it("keeps the old set when the destination cannot be written", async () => {
    /*
     * A destination that cannot be written. On POSIX that is the mode change
     * this test always made; everywhere it is also a plain file standing where
     * the trickplay directory has to go, because Windows honours the read-only
     * attribute on files and effectively ignores it on directories — the chmod
     * succeeded there, the set was migrated anyway, and this case failed
     * asserting that a migration which had in fact happened had not.
     */
    const unblock = await denyWritesInto(titleRoot());

    const report = await migrateLegacyTrickplaySets(dependencies());

    await unblock();
    expect(report.outcomes[0]?.status).toBe("failed");
    expect(await readdir(legacySet())).toHaveLength(LAYOUT.spriteCount);
    expect(updates).toEqual([]);
  });

  it("keeps the old set when it does not match its own row", async () => {
    await writeFile(path.join(legacySet(), "sprite_0.jpg"), Buffer.alloc(0));

    const report = await migrateLegacyTrickplaySets(dependencies());

    expect(report.outcomes[0]?.status).toBe("invalid-source");
    expect(await readdir(legacySet())).toHaveLength(LAYOUT.spriteCount);
    await expect(readdir(destination())).rejects.toThrow();
  });

  it("reports the truth when the old directory is simply not there", async () => {
    await rm(legacySet(), { recursive: true, force: true });

    const report = await migrateLegacyTrickplaySets(dependencies());

    expect(report.outcomes[0]?.status).toBe("source-missing");
    expect(updates).toEqual([]);
  });

  it("reports a conflict, and touches nothing, when the title holds different sheets", async () => {
    // A different set entirely: one sheet, and a different picture in it.
    await mkdir(destination(), { recursive: true });
    await writeFile(
      path.join(destination(), "sprite_0.jpg"),
      Buffer.concat([jpegBytes(WIDTH, HEIGHT), Buffer.from("different")]),
    );

    const report = await migrateLegacyTrickplaySets(dependencies());

    expect(report.outcomes[0]?.status).toBe("conflict");
    expect(await readdir(legacySet())).toHaveLength(LAYOUT.spriteCount);
    expect(await readdir(destination())).toEqual(["sprite_0.jpg"]);
    expect(updates).toEqual([]);
  });

  /*
   * Restart safety. A run killed after the swap but before the row was cleared
   * leaves exactly this state, and the next run has to finish it rather than
   * treat the title's own sheets as somebody else's.
   */
  it("finishes a run that was interrupted after the sheets had landed", async () => {
    await writeTrickplaySheets({
      directory: destination(),
      count: LAYOUT.spriteCount,
      width: WIDTH,
      height: HEIGHT,
    });

    const report = await migrateLegacyTrickplaySets(dependencies());

    expect(report.outcomes[0]?.status).toBe("already-migrated");
    expect(rows[0]?.storage_prefix).toBeNull();
    expect(await readdir(legacyRoot()).catch(() => null)).toBeNull();
  });

  it("is idempotent: a second run has nothing left to select", async () => {
    await migrateLegacyTrickplaySets(dependencies());
    const second = await migrateLegacyTrickplaySets(dependencies());

    // A cleared row is no longer a legacy row, so the second run selects
    // nothing at all rather than doing the work again and finding it done.
    expect(second.outcomes).toEqual([]);
    expect(await readdir(destination())).toHaveLength(LAYOUT.spriteCount);
  });

  it("removes the old central root once it is genuinely empty", async () => {
    const report = await migrateLegacyTrickplaySets(dependencies());

    expect(report.legacyRootRemoved).toBe(true);
  });

  /*
   * `rm` takes the `<uuid>` directory and leaves the `._<uuid>` the filesystem
   * made for it. Counting raw entries would therefore report a root holding
   * nothing but macOS bookkeeping as still in use, for ever.
   */
  it("removes the old root when only filesystem sidecars are left beside it", async () => {
    await writeFile(
      path.join(legacyRoot(), `._${PREFIX}`),
      Buffer.alloc(4_096),
    );
    await writeFile(path.join(legacyRoot(), ".DS_Store"), "x");

    const report = await migrateLegacyTrickplaySets(dependencies());

    expect(report.outcomes[0]?.status).toBe("migrated");
    expect(report.legacyRootRemoved).toBe(true);
    expect(await readdir(legacyRoot()).catch(() => null)).toBeNull();
  });

  /*
   * A directory with no row behind it cannot be migrated: there is no media
   * file to resolve a destination from. It is the reason the old root can
   * outlive a run in which every set succeeded, so it is named in the report
   * rather than silently left for an operator to find.
   */
  it("reports a directory no row claims, and leaves it exactly where it is", async () => {
    const orphan = path.join(
      legacyRoot(),
      "99999999-9999-4999-8999-999999999999",
    );
    await mkdir(orphan, { recursive: true });
    await writeFile(
      path.join(orphan, "sprite_0.jpg"),
      jpegBytes(WIDTH, HEIGHT),
    );

    const report = await migrateLegacyTrickplaySets(dependencies());

    expect(report.orphanDirectories).toEqual([
      "99999999-9999-4999-8999-999999999999",
    ]);
    // Reported is not adopted, and it is not deleted either.
    expect(report.legacyRootRemoved).toBe(false);
    expect(await readdir(orphan)).toEqual(["sprite_0.jpg"]);
  });

  it("keeps the old central root while anything is still in it", async () => {
    await writeTrickplaySheets({
      directory: path.join(legacyRoot(), "another-set"),
      count: 1,
      width: WIDTH,
      height: HEIGHT,
    });

    const report = await migrateLegacyTrickplaySets(dependencies());

    expect(report.legacyRootRemoved).toBe(false);
    expect(await readdir(legacyRoot())).toEqual(["another-set"]);
  });

  it("refuses a row whose prefix would climb out of the old root", async () => {
    rows = [
      {
        ...(rows[0] as Record<string, unknown>),
        storage_prefix: "../../escape",
      },
    ];

    const report = await migrateLegacyTrickplaySets(dependencies());

    expect(report.outcomes[0]?.status).toBe("unresolvable");
    expect(updates).toEqual([]);
  });

  it("refuses a set whose media file is no longer catalogued", async () => {
    file = null;

    const report = await migrateLegacyTrickplaySets(dependencies());

    expect(report.outcomes[0]?.status).toBe("unresolvable");
    expect(await readdir(legacySet())).toHaveLength(LAYOUT.spriteCount);
  });
});
