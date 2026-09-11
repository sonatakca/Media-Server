// @vitest-environment node
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabasePool } from "../database/databasePool";
import { runMigrations } from "../database/migrationRunner";
import {
  loadRenditionRegistry,
  saveRenditionRegistry,
  createEmptyRenditionRegistry,
} from "../../../renditions/registry";
import { createLibraryAdminRepository, loadTitleDetail } from "./libraryAdmin";
import { createTitleRemoval, TitleRemovalError } from "./titleRemoval";
import type { TmdbClient } from "../metadata/tmdbClient";

const databaseUrl = process.env.SEYIRLIK_TEST_DATABASE_URL;
(databaseUrl ? describe : describe.skip)(
  "the administrator's library and removing a title",
  () => {
    const pool = createDatabasePool({
      connectionString: databaseUrl!,
      maxConnections: 4,
    });
    const movies = randomUUID();
    const series = randomUUID();
    let mediaRoot: string;
    const exists = (relative: string) =>
      stat(path.join(mediaRoot, relative)).then(
        () => true,
        () => false,
      );

    async function item(input: {
      kind: string;
      title: string;
      library: string;
      sourceKey: string;
      seriesId?: string;
      parentId?: string;
      season?: number;
      episode?: number;
      desired?: boolean;
      tmdb?: string;
    }) {
      const id = randomUUID();
      await pool.query(
        `INSERT INTO items (id, library_id, kind, source_key, title, sort_title, series_id, parent_id,
           parent_index_number, index_number, desired, provider_ids)
         VALUES ($1,$2,$3,$4,$5,$5,$6,$7,$8,$9,$10,$11)`,
        [
          id,
          input.library,
          input.kind,
          input.sourceKey,
          input.title,
          input.seriesId ?? null,
          input.parentId ?? null,
          input.season ?? null,
          input.episode ?? null,
          input.desired ?? false,
          JSON.stringify(input.tmdb ? { tmdb: input.tmdb } : {}),
        ],
      );
      return id;
    }

    async function file(itemId: string, relative: string, bytes = "video") {
      await mkdir(path.dirname(path.join(mediaRoot, relative)), {
        recursive: true,
      });
      await writeFile(path.join(mediaRoot, relative), bytes);
      const id = randomUUID();
      await pool.query(
        `INSERT INTO media_files (id, item_id, relative_path, size_bytes, mtime_ms, fingerprint)
         VALUES ($1,$2,$3,$4,1,'test')`,
        [id, itemId, relative, bytes.length],
      );
      await pool.query(
        `INSERT INTO media_streams (media_file_id, stream_index, kind, codec, language, width, height)
         VALUES ($1, 0, 'video', 'h264', NULL, 3840, 1608), ($1, 1, 'audio', 'aac', 'tur', NULL, NULL),
                ($1, 2, 'audio', 'aac', 'tr', NULL, NULL), ($1, 3, 'subtitle', 'subrip', 'eng', NULL, NULL)`,
        [id],
      );
      return id;
    }

    const removal = () =>
      createTitleRemoval({
        pool,
        mediaRoot,
        renditionRoot: path.join(mediaRoot, ".seyirlik", "renditions"),
        stateRoot: path.join(mediaRoot, ".seyirlik", "state"),
      });

    beforeAll(async () => {
      // Only ever an explicitly supplied, disposable test database.
      await pool.query("DROP SCHEMA public CASCADE");
      await pool.query("CREATE SCHEMA public");
      await runMigrations(pool);
      await pool.query(
        `INSERT INTO libraries (id, slug, name, kind) VALUES ($1,'movies','Movies','movies'), ($2,'series','Series','series')`,
        [movies, series],
      );
      await pool.query(
        `INSERT INTO library_roots (id, library_id, relative_path) VALUES ($1,$2,'Movies'), ($3,$4,'Series')`,
        [randomUUID(), movies, randomUUID(), series],
      );
    });
    beforeEach(async () => {
      mediaRoot = await mkdtemp(path.join(tmpdir(), "seyirlik-removal-"));
      await pool.query("DELETE FROM items");
    });
    afterAll(async () => {
      await pool.end();
    });

    it("lists wanted, downloading and held titles with what they hold", async () => {
      const held = await item({
        kind: "movie",
        title: "Held",
        library: movies,
        sourceKey: "movie:movies/held (2000)",
      });
      await file(held, "Movies/Held (2000)/src/Held.2000.1080p-GRP.mkv");
      await item({
        kind: "movie",
        title: "Wanted",
        library: movies,
        sourceKey: "movie:movies/wanted (2001)",
        desired: true,
      });
      const repository = createLibraryAdminRepository(pool);
      const titles = await repository.listTitles("movie");
      expect(
        titles.map((t) => [t.title, t.status, t.hasMedia, t.desired]),
      ).toEqual([
        ["Held", "downloaded", true, false],
        ["Wanted", "wanted", false, true],
      ]);
      expect(titles[0]).toMatchObject({
        // A scope frame is still 2160p, and `tr` and `tur` are one language.
        resolution: 2160,
        audioLanguages: ["tur"],
        subtitleLanguages: ["eng"],
        sizeBytes: 5,
      });
    });

    it("shows a show's missing episodes from TMDB beside the ones on disk", async () => {
      const show = await item({
        kind: "series",
        title: "Show",
        library: series,
        sourceKey: "series:series/show",
        desired: true,
        tmdb: "42",
      });
      const episode = await item({
        kind: "episode",
        title: "Pilot",
        library: series,
        sourceKey: "episode:series:series/show:1:1",
        seriesId: show,
        season: 1,
        episode: 1,
      });
      await file(episode, "Series/Show/Season 1/Show - S01E01.mkv");
      const tmdb = {
        getSeries: async () => ({
          seasons: [
            { seasonNumber: 0, episodeCount: 1 },
            { seasonNumber: 1, episodeCount: 3 },
          ],
        }),
        getSeasonEpisodes: async () => [
          { seasonNumber: 1, episodeNumber: 1, title: "Pilot" },
          { seasonNumber: 1, episodeNumber: 2, airDate: "2020-01-01" },
          { seasonNumber: 1, episodeNumber: 3, airDate: "2999-01-01" },
        ],
      } as unknown as TmdbClient;
      const detail = await loadTitleDetail(
        createLibraryAdminRepository(pool),
        tmdb,
        show,
      );
      expect(
        detail!.seasons[0]!.episodes.map((e) => [e.episodeNumber, e.status]),
      ).toEqual([
        [1, "downloaded"],
        [2, "wanted"],
        [3, "unaired"],
      ]);
      expect(detail!.seasons[0]!.episodes[0]!.mediaFileId).not.toBeNull();
    });

    it("removes a film's folder, its rows, its package record and its legacy package", async () => {
      const film = await item({
        kind: "movie",
        title: "Doomed",
        library: movies,
        sourceKey: "movie:movies/doomed (2010)",
      });
      await file(film, "Movies/Doomed (2010)/src/Doomed.2010.mkv");
      await mkdir(path.join(mediaRoot, "Movies/Doomed (2010)/content"));
      await writeFile(
        path.join(mediaRoot, "Movies/Doomed (2010)/content/cover.jpg"),
        "jpg",
      );
      const neighbour = await item({
        kind: "movie",
        title: "Neighbour",
        library: movies,
        sourceKey: "movie:movies/neighbour (2011)",
      });
      await file(neighbour, "Movies/Neighbour (2011)/Neighbour.mkv");
      await pool.query(
        "INSERT INTO activity_events (event_type, item_id, summary) VALUES ('played', $1, 'x')",
        [film],
      );
      // A legacy package and its registry record, outside the title folder.
      const stateRoot = path.join(mediaRoot, ".seyirlik", "state");
      const registry = createEmptyRenditionRegistry();
      const packageId = randomUUID();
      registry.items.push({
        id: packageId,
        relativePath: "Movies/Doomed (2010)/src/Doomed.2010.mkv",
        size: 5,
        mtimeMs: 1,
        sourceFingerprint: "a".repeat(64),
        profileVersion: registry.profileVersion,
        lastSeenAt: new Date().toISOString(),
      });
      await saveRenditionRegistry(
        path.join(stateRoot, "registry.json"),
        registry,
      );
      await mkdir(path.join(mediaRoot, ".seyirlik", "renditions", packageId), {
        recursive: true,
      });

      await expect(removal().remove(film, "doomed")).rejects.toMatchObject({
        code: "confirmation",
      });
      expect(await exists("Movies/Doomed (2010)")).toBe(true);

      const report = await removal().remove(film, "Doomed");
      expect(report).toMatchObject({
        folder: "Movies/Doomed (2010)",
        leftovers: [],
      });
      expect(await exists("Movies/Doomed (2010)")).toBe(false);
      expect(await exists(`.seyirlik/renditions/${packageId}`)).toBe(false);
      expect(await readdir(path.join(mediaRoot, "Movies"))).toEqual([
        "Neighbour (2011)",
      ]);
      const rows = await pool.query(
        "SELECT (SELECT count(*) FROM items WHERE id = $1)::int AS items, (SELECT count(*) FROM activity_events WHERE item_id = $1)::int AS events",
        [film],
      );
      expect(rows.rows[0]).toEqual({ items: 0, events: 0 });
      expect(
        (await loadRenditionRegistry(path.join(stateRoot, "registry.json")))
          .items,
      ).toEqual([]);
      // The neighbour is untouched.
      expect(await exists("Movies/Neighbour (2011)/Neighbour.mkv")).toBe(true);
    });

    it("removes a whole show with its seasons and episodes", async () => {
      const show = await item({
        kind: "series",
        title: "Gone",
        library: series,
        sourceKey: "series:series/gone",
      });
      for (const n of [1, 2]) {
        const episode = await item({
          kind: "episode",
          title: `E${n}`,
          library: series,
          sourceKey: `episode:series:series/gone:1:${n}`,
          seriesId: show,
          season: 1,
          episode: n,
        });
        await file(episode, `Series/Gone/Season 1/Gone - S01E0${n}.mkv`);
      }
      const report = await removal().remove(show, "Gone");
      expect(report.folder).toBe("Series/Gone");
      expect(await exists("Series/Gone")).toBe(false);
      expect(
        (await pool.query("SELECT count(*)::int AS n FROM items")).rows[0],
      ).toEqual({ n: 0 });
    });

    it("refuses while the title is being processed, and deletes nothing", async () => {
      const film = await item({
        kind: "movie",
        title: "Busy",
        library: movies,
        sourceKey: "movie:movies/busy (2012)",
      });
      const fileId = await file(film, "Movies/Busy (2012)/Busy.mkv");
      await pool.query(
        `INSERT INTO processing_jobs (id, item_id, media_file_id, source_fingerprint, profile, state)
         VALUES ($1,$2,$3,'f','p','running')`,
        [randomUUID(), film, fileId],
      );
      await expect(removal().remove(film, "Busy")).rejects.toBeInstanceOf(
        TitleRemovalError,
      );
      expect(await exists("Movies/Busy (2012)/Busy.mkv")).toBe(true);
    });

    it("keeps a folder another title also uses, deleting only this title's files", async () => {
      const first = await item({
        kind: "movie",
        title: "Shared",
        library: movies,
        sourceKey: "movie:movies/shared",
      });
      await file(first, "Movies/Shared/first.mkv");
      const second = await item({
        kind: "movie",
        title: "Other",
        library: movies,
        sourceKey: "movie:movies/shared/other",
      });
      await file(second, "Movies/Shared/other.mkv");
      const report = await removal().remove(first, "Shared");
      expect(report.folder).toBeNull();
      expect(await exists("Movies/Shared/first.mkv")).toBe(false);
      expect(await exists("Movies/Shared/other.mkv")).toBe(true);
    });

    it("finishes a removal a crash interrupted after the rows were gone", async () => {
      const staged = path.join(
        mediaRoot,
        "Movies",
        `.seyirlik-removing-${randomUUID()}`,
      );
      await mkdir(staged, { recursive: true });
      await writeFile(path.join(staged, "x.mkv"), "x");
      const film = await item({
        kind: "movie",
        title: "Next",
        library: movies,
        sourceKey: "movie:movies/next",
        desired: true,
      });
      await removal().remove(film, "Next");
      expect(await exists(path.relative(mediaRoot, staged))).toBe(false);
    });

    afterAll(async () => {
      if (mediaRoot) await rm(mediaRoot, { recursive: true, force: true });
    });
  },
);
