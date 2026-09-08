import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  detectSubtitlesOnDisk,
  libraryRelativePosix,
  missingWants,
  reconcileTracks,
  titleSuggestsHearingImpaired,
  trackFromStream,
  tracksFromStreams,
  type SubtitleStreamFacts,
} from "./subtitleDetection";
import { normalizeWant, type SubtitleTrack } from "./subtitleState";

/**
 * Detection, against real directories on this machine's temporary storage.
 *
 * Real files rather than a mocked filesystem, because the rule that matters —
 * which subtitle in a shared folder belongs to which episode — is a rule about
 * what is actually in a directory.
 */

const stream = (
  over: Partial<SubtitleStreamFacts> = {},
): SubtitleStreamFacts => ({
  streamIndex: 2,
  kind: "subtitle",
  codec: "subrip",
  language: "tur",
  title: null,
  isForced: false,
  isExternal: false,
  externalRelativePath: null,
  ...over,
});

describe("reading a catalogue stream", () => {
  it("ignores anything that is not a subtitle", () => {
    expect(trackFromStream(stream({ kind: "audio" }))).toBeNull();
    expect(trackFromStream(stream({ kind: "video" }))).toBeNull();
  });

  it("reads an embedded track, with its index and no path", () => {
    const track = trackFromStream(stream());
    expect(track).toMatchObject({
      origin: "embedded",
      language: "tur",
      format: "srt",
      relativePath: null,
      streamIndex: 2,
      managed: false,
    });
  });

  it("reads an external track, with its path and no index", () => {
    const track = trackFromStream(
      stream({
        isExternal: true,
        externalRelativePath: "Movies/Dune (2021)/Dune (2021).tr.srt",
        streamIndex: 1000,
      }),
    );
    expect(track).toMatchObject({
      origin: "external",
      format: "srt",
      relativePath: "Movies/Dune (2021)/Dune (2021).tr.srt",
      streamIndex: null,
    });
  });

  /*
   * An image track is a subtitle somebody may be watching. A search that could
   * not see it would decide the film has no Turkish subtitle when it has a
   * Turkish PGS one. What it is not is a download target, and `format: null`
   * is how that reads downstream.
   */
  it("keeps an image-based track but gives it no format", () => {
    const track = trackFromStream(
      stream({ codec: "hdmv_pgs_subtitle", language: "tur" }),
    );
    expect(track).toMatchObject({ origin: "embedded", format: null });
    expect(track?.language).toBe("tur");
  });

  it("leaves an unrecognised codec's format null rather than guessing", () => {
    // Still a subtitle, and still readable — just not one this can name.
    const track = trackFromStream(stream({ codec: "something_new" }));
    expect(track).not.toBeNull();
    expect(track?.format).toBeNull();
  });

  it("normalises the language and defaults an absent one to und", () => {
    expect(trackFromStream(stream({ language: "TR" }))?.language).toBe("tur");
    expect(trackFromStream(stream({ language: null }))?.language).toBe("und");
  });

  it("marks a track managed only when its path is one this system installed", () => {
    const managedPaths = new Set(["Movies/Dune (2021)/Dune (2021).tr.srt"]);
    const mine = trackFromStream(
      stream({
        isExternal: true,
        externalRelativePath: "Movies/Dune (2021)/Dune (2021).tr.srt",
      }),
      { managedPaths },
    );
    const theirs = trackFromStream(
      stream({
        isExternal: true,
        externalRelativePath: "Movies/Dune (2021)/hand-added.tr.srt",
      }),
      { managedPaths },
    );
    expect(mine?.managed).toBe(true);
    expect(theirs?.managed).toBe(false);
  });

  it("filters a mixed stream list down to subtitles", () => {
    const tracks = tracksFromStreams([
      stream({ kind: "video" }),
      stream({ kind: "audio" }),
      stream({ streamIndex: 3 }),
    ]);
    expect(tracks).toHaveLength(1);
    expect(tracks[0]?.streamIndex).toBe(3);
  });
});

describe("what a track's own title admits", () => {
  it.each([
    "SDH",
    "English SDH",
    "eng (CC)",
    "Hearing Impaired",
    "closed captions",
  ])("reads %s as hearing-impaired", (title) => {
    expect(titleSuggestsHearingImpaired(title)).toBe(true);
  });

  /* `cc` and `hi` appear inside ordinary words; the boundaries matter. */
  it.each(["Turkish", "Chicago", "Hindi commentary", "Forced", null])(
    "does not read %s as hearing-impaired",
    (title) => {
      expect(titleSuggestsHearingImpaired(title)).toBe(false);
    },
  );
});

describe("library-relative paths", () => {
  it("answers in POSIX whatever the host separator is", () => {
    const root = path.join(path.sep + "media");
    const file = path.join(root, "Movies", "Dune (2021)", "Dune.tr.srt");
    expect(libraryRelativePosix(root, file)).toBe(
      "Movies/Dune (2021)/Dune.tr.srt",
    );
  });

  it("refuses a path outside the root", () => {
    const root = path.join(path.sep + "media");
    expect(
      libraryRelativePosix(root, path.join(path.sep + "elsewhere", "x.srt")),
    ).toBeNull();
  });
});

describe("detecting what is on the disk", () => {
  let root = "";
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "seyirlik-subs-"));
  });
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("finds a sidecar beside a film and reads its tags", async () => {
    const dir = path.join(root, "Movies", "Dune (2021)");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "Dune (2021).mkv"), "video");
    await writeFile(path.join(dir, "Dune (2021).tr.srt"), "1\n");
    await writeFile(path.join(dir, "Dune (2021).en.forced.srt"), "1\n");

    const tracks = await detectSubtitlesOnDisk(
      path.join(dir, "Dune (2021).mkv"),
      root,
    );
    expect(tracks).toHaveLength(2);
    expect(tracks.map((t) => t.relativePath).sort()).toEqual([
      "Movies/Dune (2021)/Dune (2021).en.forced.srt",
      "Movies/Dune (2021)/Dune (2021).tr.srt",
    ]);
    expect(tracks.every((t) => t.origin === "external")).toBe(true);
    expect(tracks.find((t) => t.language === "eng")?.forced).toBe(true);
    expect(tracks.find((t) => t.language === "tur")?.forced).toBe(false);
  });

  /*
   * The case the shared discovery exists for. Ten episodes and ten `.tr.srt`
   * in one season folder: each episode gets its own, not all ten.
   */
  it("gives each episode of a season folder only its own subtitle", async () => {
    const dir = path.join(root, "Series", "Andor", "Season 1");
    await mkdir(dir, { recursive: true });
    for (const n of ["S01E01", "S01E02"]) {
      await writeFile(path.join(dir, `Andor - ${n}.mkv`), "video");
      await writeFile(path.join(dir, `Andor - ${n}.tr.srt`), "1\n");
    }

    const first = await detectSubtitlesOnDisk(
      path.join(dir, "Andor - S01E01.mkv"),
      root,
    );
    expect(first).toHaveLength(1);
    expect(first[0]?.relativePath).toBe(
      "Series/Andor/Season 1/Andor - S01E01.tr.srt",
    );
  });

  it("reports nothing rather than throwing when the directory is gone", async () => {
    await expect(
      detectSubtitlesOnDisk(path.join(root, "nowhere", "x.mkv"), root),
    ).resolves.toEqual([]);
  });

  it("drops a sidecar that resolves outside the library root", async () => {
    const dir = path.join(root, "inside");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "film.mkv"), "video");
    await writeFile(path.join(dir, "film.tr.srt"), "1\n");
    // A root that the file is not under at all.
    const tracks = await detectSubtitlesOnDisk(
      path.join(dir, "film.mkv"),
      path.join(root, "a-different-root"),
    );
    expect(tracks).toEqual([]);
  });
});

describe("putting the two views together", () => {
  const embedded: SubtitleTrack = {
    origin: "embedded",
    language: "eng",
    format: "srt",
    relativePath: null,
    streamIndex: 2,
    forced: false,
    hearingImpaired: false,
    managed: false,
  };
  const external = (over: Partial<SubtitleTrack> = {}): SubtitleTrack => ({
    origin: "external",
    language: "tur",
    format: "srt",
    relativePath: "Movies/Dune/Dune.tr.srt",
    streamIndex: null,
    forced: false,
    hearingImpaired: false,
    managed: false,
    ...over,
  });

  it("counts a subtitle both views know about exactly once", () => {
    const tracks = reconcileTracks([embedded, external()], [external()]);
    expect(tracks).toHaveLength(2);
  });

  /* The disk was read now; the catalogue was read whenever the scan last ran. */
  it("lets the disk's reading win where they disagree", () => {
    const tracks = reconcileTracks(
      [external({ hearingImpaired: false })],
      [external({ hearingImpaired: true })],
    );
    expect(tracks).toHaveLength(1);
    expect(tracks[0]?.hearingImpaired).toBe(true);
  });

  it("keeps an embedded track the disk cannot see", () => {
    expect(reconcileTracks([embedded], [])).toEqual([embedded]);
  });
});

describe("what is still wanted", () => {
  const turkish = normalizeWant({ language: "tur" });
  const turkishForced = normalizeWant({ language: "tur", forced: true });
  const english = normalizeWant({ language: "eng" });
  const track = (over: Partial<SubtitleTrack> = {}): SubtitleTrack => ({
    origin: "external",
    language: "tur",
    format: "srt",
    relativePath: "x.srt",
    streamIndex: null,
    forced: false,
    hearingImpaired: false,
    managed: false,
    ...over,
  });

  it("drops a want an existing track answers", () => {
    expect(missingWants([turkish, english], [track()])).toEqual([english]);
  });

  it("does not let a full track answer a want for a forced one", () => {
    expect(missingWants([turkishForced], [track()])).toEqual([turkishForced]);
  });

  it("is answered by an embedded track as readily as by a file", () => {
    expect(
      missingWants(
        [turkish],
        [track({ origin: "embedded", relativePath: null })],
      ),
    ).toEqual([]);
  });

  it("keeps the order somebody wrote their languages in", () => {
    expect(missingWants([english, turkish], [])).toEqual([english, turkish]);
  });
});
