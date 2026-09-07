import { writeFileSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  archiveLegacyTrickplay,
  ArchiveRootError,
  assertRootsDisjoint,
  discoverLegacyTrickplayDirectories,
  summariseArchiveReport,
} from "./legacyTrickplayArchive";

/**
 * The destructive half of the redesign, exercised entirely on fixtures.
 *
 * Nothing here touches a real library. What it does prove is the property the
 * real run depends on: an original is removed only when a copy of it has been
 * read back and matched byte for byte, and anything that does not match keeps
 * its original.
 */
describe("archiving the Jellyfin-era trickplay folders", () => {
  let base: string;
  let mediaRoot: string;
  let archiveRoot: string;

  const movieLegacy = () =>
    path.join(mediaRoot, "Movies/Dune (2021)/Dune (2021) [438631].trickplay");
  const trailerLegacy = () =>
    path.join(mediaRoot, "Movies/Dune (2021)/trailers/trailer.trickplay");
  const episodeLegacy = () =>
    path.join(
      mediaRoot,
      "Series/The Sopranos/Season 1/The Sopranos - S01E01 - Pilot.trickplay",
    );
  const managedLive = () =>
    path.join(mediaRoot, "Movies/Dune (2021)/trickplay");

  async function writeTree(
    root: string,
    files: Record<string, string>,
  ): Promise<void> {
    for (const [relative, content] of Object.entries(files)) {
      const target = path.join(root, ...relative.split("/"));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content);
    }
  }

  beforeEach(async () => {
    base = await mkdtemp(path.join(tmpdir(), "legacy-trickplay-"));
    mediaRoot = path.join(base, "media");
    archiveRoot = path.join(base, "old-trickplays");

    await writeTree(movieLegacy(), {
      "320 - 10x10/0.jpg": "movie-sheet-zero",
      "320 - 10x10/1.jpg": "movie-sheet-one",
    });
    await writeTree(trailerLegacy(), { "320 - 10x10/0.jpg": "trailer-sheet" });
    await writeTree(episodeLegacy(), { "320 - 10x10/0.jpg": "episode-sheet" });

    // The live managed set, and the other title-owned folders, all of which
    // must still be there afterwards.
    await writeTree(managedLive(), { "sprite_0.jpg": "live" });
    for (const directory of [
      "video",
      "audio",
      "subtitle",
      "content",
      ".seyirlik",
    ]) {
      await writeTree(path.join(mediaRoot, "Movies/Dune (2021)", directory), {
        "keep.txt": "x",
      });
    }
  });

  afterEach(async () => {
    await chmod(path.join(mediaRoot, "Movies/Dune (2021)"), 0o755).catch(
      () => undefined,
    );
    await rm(base, { recursive: true, force: true });
  });

  describe("discovery", () => {
    it("finds movie, episode and trailer folders wherever they sit", async () => {
      const found = await discoverLegacyTrickplayDirectories(mediaRoot);

      expect(found).toEqual([
        "Movies/Dune (2021)/Dune (2021) [438631].trickplay",
        "Movies/Dune (2021)/trailers/trailer.trickplay",
        "Series/The Sopranos/Season 1/The Sopranos - S01E01 - Pilot.trickplay",
      ]);
    });

    /*
     * The one selection that would be unrecoverable. `trickplay` is the live
     * managed directory; a substring match would have picked it up.
     */
    it("never selects the managed trickplay directory", async () => {
      const found = await discoverLegacyTrickplayDirectories(mediaRoot);

      expect(found).not.toContain("Movies/Dune (2021)/trickplay");
      expect(found.every((entry) => entry.endsWith(".trickplay"))).toBe(true);
    });

    it("does not follow a symlinked directory out of the library", async () => {
      const outside = path.join(base, "outside");
      await writeTree(path.join(outside, "Elsewhere.trickplay"), {
        "0.jpg": "not ours",
      });
      await symlink(outside, path.join(mediaRoot, "link"));

      const found = await discoverLegacyTrickplayDirectories(mediaRoot);

      expect(found.some((entry) => entry.includes("Elsewhere"))).toBe(false);
    });
  });

  describe("the roots", () => {
    it("refuses an archive inside the library, which would archive itself", () => {
      expect(() =>
        assertRootsDisjoint(mediaRoot, path.join(mediaRoot, "old")),
      ).toThrow(ArchiveRootError);
    });

    it("refuses a library inside the archive", () => {
      expect(() =>
        assertRootsDisjoint(path.join(archiveRoot, "media"), archiveRoot),
      ).toThrow(ArchiveRootError);
    });

    it("refuses the same directory for both", () => {
      expect(() => assertRootsDisjoint(mediaRoot, mediaRoot)).toThrow(
        ArchiveRootError,
      );
    });

    it("accepts two siblings, which is the intended layout", () => {
      expect(() => assertRootsDisjoint(mediaRoot, archiveRoot)).not.toThrow();
    });
  });

  describe("a dry run", () => {
    it("reports everything and writes nothing", async () => {
      const report = await archiveLegacyTrickplay({
        mediaRoot,
        archiveRoot,
        dryRun: true,
      });

      const counts = summariseArchiveReport(report);
      expect(counts.discovered).toBe(3);
      expect(counts.archived).toBe(3);
      expect(counts.files).toBe(4);
      expect(counts.bytes).toBeGreaterThan(0);
      // Nothing created, nothing removed.
      await expect(readdir(archiveRoot)).rejects.toThrow();
      expect(await readdir(movieLegacy())).toEqual(["320 - 10x10"]);
      expect(await readdir(trailerLegacy())).toEqual(["320 - 10x10"]);
    });

    it("maps each source to a destination that keeps its place in the library", async () => {
      const report = await archiveLegacyTrickplay({
        mediaRoot,
        archiveRoot,
        dryRun: true,
      });

      const movie = report.outcomes.find((outcome) =>
        outcome.relativePath.includes("Dune"),
      );
      expect(movie?.destination).toBe(
        path.join(
          archiveRoot,
          "Movies/Dune (2021)/Dune (2021) [438631].trickplay",
        ),
      );
    });
  });

  describe("a real run", () => {
    it("preserves the hierarchy relative to the media root", async () => {
      await archiveLegacyTrickplay({ mediaRoot, archiveRoot });

      expect(
        await readFile(
          path.join(
            archiveRoot,
            "Movies/Dune (2021)/Dune (2021) [438631].trickplay/320 - 10x10/0.jpg",
          ),
          "utf8",
        ),
      ).toBe("movie-sheet-zero");
      expect(
        await readFile(
          path.join(
            archiveRoot,
            "Series/The Sopranos/Season 1/The Sopranos - S01E01 - Pilot.trickplay/320 - 10x10/0.jpg",
          ),
          "utf8",
        ),
      ).toBe("episode-sheet");
      // Never flattened by basename: two folders called `trailer.trickplay` in
      // two films would otherwise become one.
      expect(
        await readFile(
          path.join(
            archiveRoot,
            "Movies/Dune (2021)/trailers/trailer.trickplay/320 - 10x10/0.jpg",
          ),
          "utf8",
        ),
      ).toBe("trailer-sheet");
    });

    it("removes the originals it verified, and only those", async () => {
      const report = await archiveLegacyTrickplay({ mediaRoot, archiveRoot });

      expect(summariseArchiveReport(report).archived).toBe(3);
      await expect(readdir(movieLegacy())).rejects.toThrow();
      await expect(readdir(episodeLegacy())).rejects.toThrow();
    });

    /*
     * Everything else in the library is untouched, including the folder whose
     * name differs from a legacy one by a single dot.
     */
    it("leaves the live trickplay and every other title folder alone", async () => {
      await archiveLegacyTrickplay({ mediaRoot, archiveRoot });

      expect(await readdir(managedLive())).toEqual(["sprite_0.jpg"]);
      expect(
        (await readdir(path.join(mediaRoot, "Movies/Dune (2021)"))).sort(),
      ).toEqual([
        ".seyirlik",
        "audio",
        "content",
        "subtitle",
        "trailers",
        "trickplay",
        "video",
      ]);
      await expect(
        readdir(path.join(archiveRoot, "Movies/Dune (2021)/trickplay")),
      ).rejects.toThrow();
    });

    /*
     * The case that matters most: a copy that landed short or corrupt. The hook
     * damages the archived bytes after the copy and before the comparison,
     * which is what a truncated write would look like from here.
     */
    it("keeps the original when the copy does not verify", async () => {
      const report = await archiveLegacyTrickplay({
        mediaRoot,
        archiveRoot,
        onPhase: (phase, entry) => {
          if (
            phase !== "verifying" ||
            !entry?.relativePath.includes("Dune (2021) [")
          ) {
            return;
          }
          writeFileSync(
            path.join(entry.destination, "320 - 10x10", "0.jpg"),
            "truncated",
          );
        },
      });

      const counts = summariseArchiveReport(report);
      expect(counts.failed).toBe(1);
      expect(counts.archived).toBe(2);
      // The original is still every byte of what it was.
      expect(
        await readFile(
          path.join(movieLegacy(), "320 - 10x10", "0.jpg"),
          "utf8",
        ),
      ).toBe("movie-sheet-zero");
    });

    it("reports a conflict rather than overwriting, and keeps the original", async () => {
      await writeTree(
        path.join(
          archiveRoot,
          "Movies/Dune (2021)/Dune (2021) [438631].trickplay",
        ),
        { "320 - 10x10/0.jpg": "somebody else's bytes" },
      );

      const report = await archiveLegacyTrickplay({ mediaRoot, archiveRoot });

      const counts = summariseArchiveReport(report);
      expect(counts.conflicts).toBe(1);
      expect(counts.archived).toBe(2);
      // The archive is not overwritten and the original is not removed.
      expect(
        await readFile(
          path.join(
            archiveRoot,
            "Movies/Dune (2021)/Dune (2021) [438631].trickplay/320 - 10x10/0.jpg",
          ),
          "utf8",
        ),
      ).toBe("somebody else's bytes");
      expect(await readdir(movieLegacy())).toEqual(["320 - 10x10"]);
    });

    /*
     * Interruption and resume. A run killed between copying and removing leaves
     * an identical archive with the original still present; the next run must
     * recognise that rather than treating it as a collision.
     */
    it("recognises an identical prior archive and finishes the job", async () => {
      await writeTree(
        path.join(
          archiveRoot,
          "Movies/Dune (2021)/Dune (2021) [438631].trickplay",
        ),
        {
          "320 - 10x10/0.jpg": "movie-sheet-zero",
          "320 - 10x10/1.jpg": "movie-sheet-one",
        },
      );

      const report = await archiveLegacyTrickplay({ mediaRoot, archiveRoot });

      const counts = summariseArchiveReport(report);
      expect(counts.alreadyArchived).toBe(1);
      expect(counts.conflicts).toBe(0);
      await expect(readdir(movieLegacy())).rejects.toThrow();
    });

    it("never invents a second name for a folder it could not archive", async () => {
      await writeTree(
        path.join(
          archiveRoot,
          "Movies/Dune (2021)/Dune (2021) [438631].trickplay",
        ),
        { "320 - 10x10/0.jpg": "different" },
      );

      await archiveLegacyTrickplay({ mediaRoot, archiveRoot });

      const archived = await readdir(
        path.join(archiveRoot, "Movies/Dune (2021)"),
      );
      // One name, the deterministic one. No `copy`, no ` 2`, no ` (1)`.
      expect(archived.sort()).toEqual([
        "Dune (2021) [438631].trickplay",
        "trailers",
      ]);
    });

    it("refuses a symlinked legacy folder rather than deleting through it", async () => {
      const outside = path.join(base, "outside");
      await writeTree(outside, { "0.jpg": "not ours" });
      await symlink(
        outside,
        path.join(mediaRoot, "Movies/Dune (2021)/Linked.trickplay"),
      );

      const report = await archiveLegacyTrickplay({ mediaRoot, archiveRoot });

      // Not even discovered: the walk does not follow links.
      expect(
        report.outcomes.some((outcome) =>
          outcome.relativePath.includes("Linked"),
        ),
      ).toBe(false);
      expect(await readdir(outside)).toEqual(["0.jpg"]);
    });

    it("refuses a legacy folder containing a symlink rather than archiving what it points at", async () => {
      await symlink(
        path.join(base, "outside-file"),
        path.join(movieLegacy(), "escape.jpg"),
      );
      await writeFile(path.join(base, "outside-file"), "secret");

      const report = await archiveLegacyTrickplay({ mediaRoot, archiveRoot });

      const movie = report.outcomes.find((outcome) =>
        outcome.relativePath.includes("Dune (2021) ["),
      );
      expect(movie?.status).toBe("unsafe");
      expect(await readdir(movieLegacy())).toContain("escape.jpg");
      expect(await readFile(path.join(base, "outside-file"), "utf8")).toBe(
        "secret",
      );
    });

    it("does not report success when part of the run failed", async () => {
      await writeTree(
        path.join(archiveRoot, "Movies/Dune (2021)/trailers/trailer.trickplay"),
        { "320 - 10x10/0.jpg": "different" },
      );

      const counts = summariseArchiveReport(
        await archiveLegacyTrickplay({ mediaRoot, archiveRoot }),
      );

      expect(counts.discovered).toBe(3);
      expect(counts.archived).toBe(2);
      expect(counts.conflicts).toBe(1);
    });
  });
});
