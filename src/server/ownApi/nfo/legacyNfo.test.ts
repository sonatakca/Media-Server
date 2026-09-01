import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { isManagedNfo, serializeNfo } from "./nfoSerializer";
import { createNfoWriter } from "./nfoWriter";

/**
 * The files already on the media volume.
 *
 * These are the shapes a Jellyfin, Radarr, Sonarr or Kodi library actually has
 * on disk, including the awkward ones: a byte-order mark, CRLF line endings,
 * Turkish text, and a file that is not even well-formed. Every one of them
 * represents work that cannot be regenerated from the catalogue, so the
 * property under test is byte-for-byte preservation, not "roughly preserved".
 */
const LEGACY_FIXTURES: Array<[name: string, contents: string]> = [
  [
    "jellyfin movie",
    `<?xml version="1.0" encoding="utf-8" standalone="yes"?>
<movie>
  <plot>Curated over years.</plot>
  <lockdata>true</lockdata>
  <dateadded>2019-04-02 21:11:03</dateadded>
  <title>Dune</title>
  <imdbid>tt1160419</imdbid>
  <tmdbid>438631</tmdbid>
  <art><poster>/media/Movies/Dune/poster.jpg</poster></art>
</movie>
`,
  ],
  [
    "jellyfin tvshow",
    `<?xml version="1.0" encoding="utf-8" standalone="yes"?>
<tvshow>
  <title>Şahsiyet</title>
  <lockdata>true</lockdata>
  <status>Ended</status>
  <episodeguide><url cache="tvdb-352489.xml">352489</url></episodeguide>
</tvshow>
`,
  ],
  [
    "jellyfin episode",
    `<?xml version="1.0" encoding="utf-8" standalone="yes"?>
<episodedetails>
  <title>Birinci Bölüm</title>
  <episode>1</episode>
  <season>1</season>
  <aired>2018-03-09</aired>
</episodedetails>
`,
  ],
  [
    "radarr movie",
    `<?xml version="1.0" encoding="utf-8"?>
<movie>
  <title>Arrival</title>
  <originaltitle>Arrival</originaltitle>
  <year>2016</year>
</movie>
`,
  ],
  [
    "sonarr episode",
    `<?xml version="1.0" encoding="utf-8"?>
<episodedetails>
  <title>Pilot</title>
  <showtitle>Example</showtitle>
</episodedetails>
`,
  ],
  [
    "hand-written kodi",
    `<movie>
  <title>Typed by hand in 2011</title>
  <rating>10</rating>
</movie>
`,
  ],
  [
    "byte-order marked with CRLF",
    `\uFEFF<?xml version="1.0" encoding="utf-8"?>\r\n<movie>\r\n  <title>Kış Uykusu</title>\r\n</movie>\r\n`,
  ],
  ["malformed but present", `<movie>\n  <title>Never closed\n`],
  ["empty", ""],
];

const OURS = serializeNfo({ root: "movie", title: "Dune" });

let mediaRoot: string;

beforeEach(async () => {
  mediaRoot = path.join(
    await mkdtemp(path.join(tmpdir(), "seyirlik-legacy-")),
    "media",
  );
  await mkdir(path.join(mediaRoot, "Movies", "Dune (2021)"), {
    recursive: true,
  });
});

function writer(overwritePolicy: "managed-only" | "force" = "managed-only") {
  return createNfoWriter({ mode: "sidecar", overwritePolicy, mediaRoot });
}

const TARGET = "Movies/Dune (2021)/movie.nfo";

function absoluteTarget(): string {
  return path.join(mediaRoot, "Movies", "Dune (2021)", "movie.nfo");
}

describe("legacy nfo preservation", () => {
  for (const [name, contents] of LEGACY_FIXTURES) {
    describe(name, () => {
      it("is not mistaken for a file this exporter wrote", () => {
        expect(isManagedNfo(contents)).toBe(false);
      });

      it("survives an export byte for byte", async () => {
        await writeFile(absoluteTarget(), contents, "utf8");

        const result = await writer().write(TARGET, OURS);

        expect(result.status).toBe("skipped-conflict");
        expect(result.reason).toBe("foreign-file");
        expect(await readFile(absoluteTarget(), "utf8")).toBe(contents);
      });

      it("survives repeated exports", async () => {
        await writeFile(absoluteTarget(), contents, "utf8");
        const target = writer();

        await target.write(TARGET, OURS);
        await target.write(TARGET, OURS);
        await target.write(TARGET, `${OURS}\n`);

        expect(await readFile(absoluteTarget(), "utf8")).toBe(contents);
      });

      it("is replaced only when an administrator asks for it by name", async () => {
        await writeFile(absoluteTarget(), contents, "utf8");

        const result = await writer().write(TARGET, OURS, { force: true });

        expect(result.status).toBe("updated");
        expect(await readFile(absoluteTarget(), "utf8")).toBe(OURS);
      });
    });
  }

  it("preserves every fixture in one pass over a library", async () => {
    const folders = LEGACY_FIXTURES.map(([name], index) => ({
      relativePath: `Movies/Title ${index}/movie.nfo`,
      directory: path.join(mediaRoot, "Movies", `Title ${index}`),
      contents: LEGACY_FIXTURES[index]?.[1] as string,
      name,
    }));

    for (const folder of folders) {
      await mkdir(folder.directory, { recursive: true });
      await writeFile(
        path.join(folder.directory, "movie.nfo"),
        folder.contents,
        "utf8",
      );
    }

    const target = writer();
    for (const folder of folders) {
      await target.write(folder.relativePath, OURS);
    }

    for (const folder of folders) {
      expect(
        await readFile(path.join(folder.directory, "movie.nfo"), "utf8"),
      ).toBe(folder.contents);
    }
  });

  it("recognises its own output, so a re-export is not a conflict", async () => {
    await writeFile(absoluteTarget(), OURS, "utf8");

    expect(isManagedNfo(OURS)).toBe(true);
    expect((await writer().write(TARGET, OURS)).status).toBe("unchanged");
  });
});
