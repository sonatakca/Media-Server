import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createNfoWriter,
  safeNfoSegments,
  UnsafeNfoPathError,
} from "./nfoWriter";
import { NFO_GENERATOR_COMMENT } from "./nfoSerializer";

/**
 * Every fixture here lives in a throwaway temp directory. Nothing in this file
 * may touch a real media volume, which is also the property several of these
 * tests exist to prove about the writer itself.
 */

const MANAGED = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${NFO_GENERATOR_COMMENT}\n<movie>\n  <title>Dune</title>\n</movie>\n`;

/** A real Jellyfin file, of the kind already sitting on the media volume. */
const LEGACY_JELLYFIN = `<?xml version="1.0" encoding="utf-8" standalone="yes"?>
<movie>
  <plot>Hand-curated, years old, irreplaceable.</plot>
  <lockdata>true</lockdata>
  <title>Dune</title>
  <imdbid>tt1160419</imdbid>
</movie>
`;

const LEGACY_RADARR = `<?xml version="1.0" encoding="utf-8"?>
<movie>
  <title>Dune</title>
  <!-- Created by Radarr -->
</movie>
`;

const LEGACY_KODI = `<movie>
  <title>Typed by hand in 2011</title>
</movie>
`;

let mediaRoot: string;
let generatedRoot: string;

beforeEach(async () => {
  const base = await mkdtemp(path.join(tmpdir(), "seyirlik-nfo-"));
  mediaRoot = path.join(base, "media");
  generatedRoot = path.join(base, "generated");
  await mkdir(path.join(mediaRoot, "Movies", "Dune (2021)"), {
    recursive: true,
  });
  await mkdir(generatedRoot, { recursive: true });
});

afterEach(() => {
  mediaRoot = "";
  generatedRoot = "";
});

function sidecarWriter(
  overwritePolicy: "managed-only" | "force" = "managed-only",
) {
  return createNfoWriter({ mode: "sidecar", overwritePolicy, mediaRoot });
}

function generatedWriter() {
  return createNfoWriter({
    mode: "generated",
    overwritePolicy: "managed-only",
    generatedStoragePath: generatedRoot,
  });
}

const MOVIE_PATH = "Movies/Dune (2021)/movie.nfo";

function absoluteMoviePath(): string {
  return path.join(mediaRoot, "Movies", "Dune (2021)", "movie.nfo");
}

describe("nfo writer", () => {
  describe("path validation", () => {
    it("accepts a plain descending path to an .nfo", () => {
      expect(safeNfoSegments(MOVIE_PATH)).toEqual([
        "Movies",
        "Dune (2021)",
        "movie.nfo",
      ]);
    });

    for (const [label, candidate] of [
      ["an absolute posix path", "/etc/passwd.nfo"],
      ["a parent traversal", "Movies/../../etc/passwd.nfo"],
      ["a bare traversal segment", "../escape.nfo"],
      ["a traversal in the middle", "Movies/../../../root/movie.nfo"],
      ["a current-directory segment", "Movies/./movie.nfo"],
      ["an empty segment", "Movies//movie.nfo"],
      ["a NUL byte", "Movies/Dune\u0000/movie.nfo"],
      ["a backslash separator", "Movies\\Dune\\movie.nfo"],
      ["a Windows drive letter", "C:/Movies/movie.nfo"],
      ["a UNC path", "//server/share/movie.nfo"],
      ["a non-nfo extension", "Movies/Dune (2021)/movie.mkv"],
      ["an empty string", ""],
    ] as const) {
      it(`rejects ${label}`, () => {
        expect(() => safeNfoSegments(candidate)).toThrow(UnsafeNfoPathError);
      });
    }

    it("refuses to write through a rejected path and leaves nothing behind", async () => {
      const writer = sidecarWriter();

      const result = await writer.write("../escaped.nfo", MANAGED);

      expect(result.status).toBe("skipped-conflict");
      expect(result.reason).toBe("unsafe-path");
      // The parent of the media root must be untouched.
      const parent = await readdir(path.dirname(mediaRoot));
      expect(parent).not.toContain("escaped.nfo");
    });
  });

  describe("symlink escape", () => {
    it("refuses a directory that links outside the root", async () => {
      const outside = path.join(path.dirname(mediaRoot), "outside");
      await mkdir(outside, { recursive: true });
      await symlink(outside, path.join(mediaRoot, "Escape"));

      const result = await sidecarWriter().write("Escape/movie.nfo", MANAGED);

      expect(result.status).toBe("skipped-conflict");
      expect(result.reason).toBe("outside-root");
      expect(await readdir(outside)).toEqual([]);
    });

    it("refuses when the target file itself is a symlink", async () => {
      const outside = path.join(path.dirname(mediaRoot), "target.nfo");
      await writeFile(outside, "do not touch me");
      await symlink(outside, absoluteMoviePath());

      const result = await sidecarWriter().write(MOVIE_PATH, MANAGED);

      expect(result.status).toBe("skipped-conflict");
      expect(result.reason).toBe("symlink");
      expect(await readFile(outside, "utf8")).toBe("do not touch me");
    });

    it("refuses a symlinked target even under a force overwrite", async () => {
      const outside = path.join(path.dirname(mediaRoot), "target.nfo");
      await writeFile(outside, "do not touch me");
      await symlink(outside, absoluteMoviePath());

      const result = await sidecarWriter("force").write(MOVIE_PATH, MANAGED, {
        force: true,
      });

      expect(result.status).toBe("skipped-conflict");
      expect(await readFile(outside, "utf8")).toBe("do not touch me");
    });
  });

  describe("legacy preservation", () => {
    for (const [label, contents] of [
      ["a Jellyfin", LEGACY_JELLYFIN],
      ["a Radarr", LEGACY_RADARR],
      ["a hand-written Kodi", LEGACY_KODI],
    ] as const) {
      it(`never overwrites ${label} file by default`, async () => {
        await writeFile(absoluteMoviePath(), contents, "utf8");

        const result = await sidecarWriter().write(MOVIE_PATH, MANAGED);

        expect(result.status).toBe("skipped-conflict");
        expect(result.reason).toBe("foreign-file");
        expect(await readFile(absoluteMoviePath(), "utf8")).toBe(contents);
      });
    }

    it("reports the path relative to the root, never an absolute one", async () => {
      await writeFile(absoluteMoviePath(), LEGACY_JELLYFIN, "utf8");

      const result = await sidecarWriter().write(MOVIE_PATH, MANAGED);

      expect(result.relativePath).toBe(MOVIE_PATH);
      expect(JSON.stringify(result)).not.toContain(mediaRoot);
    });

    it("replaces a legacy file only when an administrator forces it", async () => {
      await writeFile(absoluteMoviePath(), LEGACY_JELLYFIN, "utf8");

      const result = await sidecarWriter().write(MOVIE_PATH, MANAGED, {
        force: true,
      });

      expect(result.status).toBe("updated");
      expect(await readFile(absoluteMoviePath(), "utf8")).toBe(MANAGED);
    });

    it("replaces a legacy file when the configured policy is force", async () => {
      await writeFile(absoluteMoviePath(), LEGACY_KODI, "utf8");

      expect(
        (await sidecarWriter("force").write(MOVIE_PATH, MANAGED)).status,
      ).toBe("updated");
    });

    it("leaves an unrelated .nfo alone entirely", async () => {
      const unrelated = path.join(
        mediaRoot,
        "Movies",
        "Dune (2021)",
        "behind the scenes.nfo",
      );
      await writeFile(unrelated, LEGACY_KODI, "utf8");

      await sidecarWriter().write(MOVIE_PATH, MANAGED);

      expect(await readFile(unrelated, "utf8")).toBe(LEGACY_KODI);
    });
  });

  describe("managed files", () => {
    it("creates a file that was not there", async () => {
      const result = await sidecarWriter().write(MOVIE_PATH, MANAGED);

      expect(result.status).toBe("created");
      expect(await readFile(absoluteMoviePath(), "utf8")).toBe(MANAGED);
    });

    it("reports unchanged and rewrites nothing when the bytes match", async () => {
      const writer = sidecarWriter();
      await writer.write(MOVIE_PATH, MANAGED);

      expect((await writer.write(MOVIE_PATH, MANAGED)).status).toBe(
        "unchanged",
      );
    });

    it("updates its own file when the metadata changed", async () => {
      const writer = sidecarWriter();
      await writer.write(MOVIE_PATH, MANAGED);

      const changed = MANAGED.replace("Dune", "Dune: Part Two");
      expect((await writer.write(MOVIE_PATH, changed)).status).toBe("updated");
      expect(await readFile(absoluteMoviePath(), "utf8")).toBe(changed);
    });

    it("reports an existing file as managed or foreign", async () => {
      const writer = sidecarWriter();

      expect((await writer.inspect(MOVIE_PATH)).state).toBe("absent");
      await writer.write(MOVIE_PATH, MANAGED);
      expect((await writer.inspect(MOVIE_PATH)).state).toBe("managed");

      await writeFile(absoluteMoviePath(), LEGACY_JELLYFIN, "utf8");
      expect((await writer.inspect(MOVIE_PATH)).state).toBe("foreign");
    });
  });

  describe("atomic writes", () => {
    it("leaves no temporary file behind after a successful write", async () => {
      await sidecarWriter().write(MOVIE_PATH, MANAGED);

      const entries = await readdir(
        path.join(mediaRoot, "Movies", "Dune (2021)"),
      );
      expect(entries).toEqual(["movie.nfo"]);
      expect(entries.some((name) => name.endsWith(".tmp"))).toBe(false);
    });

    it("never leaves a partially written file, even under concurrent writes", async () => {
      const writer = sidecarWriter();
      const long = MANAGED.replace("Dune", "x".repeat(200_000));

      await Promise.all([
        writer.write(MOVIE_PATH, long),
        writer.write(MOVIE_PATH, long),
        writer.write(MOVIE_PATH, long),
      ]);

      // Whichever attempt landed last, the file is one complete document.
      expect(await readFile(absoluteMoviePath(), "utf8")).toBe(long);
      const entries = await readdir(
        path.join(mediaRoot, "Movies", "Dune (2021)"),
      );
      expect(entries.filter((name) => name.endsWith(".tmp"))).toEqual([]);
    });

    it("does not replace a directory that happens to sit at the target path", async () => {
      await mkdir(absoluteMoviePath(), { recursive: true });

      const result = await sidecarWriter().write(MOVIE_PATH, MANAGED);

      expect(result.status).toBe("skipped-conflict");
      expect(result.reason).toBe("not-a-regular-file");
    });
  });

  describe("modes", () => {
    it("writes under generated storage and never into the media root", async () => {
      const result = await generatedWriter().write(MOVIE_PATH, MANAGED);

      expect(result.status).toBe("created");
      expect(
        await readFile(path.join(generatedRoot, "nfo", MOVIE_PATH), "utf8"),
      ).toBe(MANAGED);
      expect(
        await readdir(path.join(mediaRoot, "Movies", "Dune (2021)")),
      ).toEqual([]);
    });

    it("creates the folders it needs under generated storage", async () => {
      const result = await generatedWriter().write(
        "Series/Deep/Season 01/S01E01.nfo",
        MANAGED,
      );

      expect(result.status).toBe("created");
    });

    for (const mode of ["disabled", "preview"] as const) {
      it(`writes nothing at all in ${mode} mode`, async () => {
        const writer = createNfoWriter({
          mode,
          overwritePolicy: "managed-only",
          mediaRoot,
          generatedStoragePath: generatedRoot,
        });

        expect(writer.canWrite).toBe(false);
        expect((await writer.write(MOVIE_PATH, MANAGED)).status).toBe(
          "skipped-disabled",
        );
        expect(
          await readdir(path.join(mediaRoot, "Movies", "Dune (2021)")),
        ).toEqual([]);
        expect(await readdir(generatedRoot)).toEqual([]);
      });
    }

    it("still reports what is on disk while previewing, without writing", async () => {
      await writeFile(absoluteMoviePath(), LEGACY_JELLYFIN, "utf8");
      const writer = createNfoWriter({
        mode: "preview",
        overwritePolicy: "managed-only",
        mediaRoot,
        generatedStoragePath: generatedRoot,
      });

      expect((await writer.inspect(MOVIE_PATH)).state).toBe("foreign");
      expect((await writer.write(MOVIE_PATH, MANAGED)).status).toBe(
        "skipped-disabled",
      );
      expect(await readFile(absoluteMoviePath(), "utf8")).toBe(LEGACY_JELLYFIN);
    });

    it("reports nothing when it was given no root to look in", async () => {
      const writer = createNfoWriter({
        mode: "disabled",
        overwritePolicy: "managed-only",
      });

      expect((await writer.inspect(MOVIE_PATH)).state).toBe("absent");
    });

    it("refuses to be built for sidecar mode without a media root", () => {
      expect(() =>
        createNfoWriter({ mode: "sidecar", overwritePolicy: "managed-only" }),
      ).toThrow(/media root|SEYIRLIK_MEDIA_ROOT/i);
    });

    it("refuses to be built for generated mode without generated storage", () => {
      expect(() =>
        createNfoWriter({ mode: "generated", overwritePolicy: "managed-only" }),
      ).toThrow(/SEYIRLIK_GENERATED_STORAGE/);
    });
  });
});
