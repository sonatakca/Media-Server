import path from "node:path";
import { describe, expect, it } from "vitest";
import { TITLE_TRICKPLAY_DIRECTORY } from "../../../renditions/adaptive/layout";
import {
  besideTitleRoot,
  nestedTitleRoot,
} from "../../../renditions/adaptive/titleRoot";
import {
  isInsideDirectory,
  isLegacyExternalTrickplayDirectory,
  isTrickplayStagingDirectory,
  spriteFileName,
  trickplayDirectoryFor,
  trickplayStagingDirectory,
  TRICKPLAY_STAGING_PREFIX,
} from "./trickplayStorage";

/**
 * Where a title's sheets go, derived rather than invented.
 *
 * Every one of these resolves through the shared title-root resolver — the same
 * one the packager publishes `video/` and `audio/` with — so trickplay lands as
 * a sibling of them rather than in a tree of its own.
 */
/**
 * A host path, written in POSIX for readability.
 *
 * Every path below is a path on the machine the server is running on, and the
 * host is what decides how one is spelled: `path.join` normalises every
 * separator to `\` on Windows, while `path.dirname` merely truncates and leaves
 * whatever it was given. Writing the expectations as literal POSIX strings meant
 * the suite was asserting the separator rather than the rule, and half of these
 * cases turned red on Windows for a reason that had nothing to do with where a
 * package goes.
 *
 * Both the inputs and the expectations go through this, so every relationship
 * the tests are actually about holds unchanged on either host — and on POSIX it
 * returns its argument.
 */
const hostPath = (posix: string): string =>
  posix.startsWith("/")
    ? path.join(path.sep, ...posix.slice(1).split("/"))
    : path.join(...posix.split("/"));

describe("resolving a title's trickplay directory", () => {
  it("puts a movie's sheets beside the folders its package published", () => {
    const source = hostPath("/media/Movies/Dune (2021)/src/Dune (2021).mkv");
    const titleRoot = besideTitleRoot(source);

    expect(titleRoot).toBe(hostPath("/media/Movies/Dune (2021)"));
    expect(trickplayDirectoryFor(titleRoot)).toBe(
      hostPath("/media/Movies/Dune (2021)/trickplay"),
    );
    // A sibling of the other title-owned directories, not a child of one.
    expect(path.dirname(trickplayDirectoryFor(titleRoot))).toBe(
      path.dirname(path.join(titleRoot, "video")),
    );
  });

  it("puts an episode's sheets in its own folder, never in the season folder", () => {
    const source = hostPath(
      "/media/Series/Andor/Season 1/src/Andor - S01E01 - Kassa.mkv",
    );
    const titleRoot = nestedTitleRoot(source);

    expect(titleRoot).toBe(
      hostPath("/media/Series/Andor/Season 1/Andor - S01E01 - Kassa"),
    );
    expect(trickplayDirectoryFor(titleRoot)).toBe(
      hostPath("/media/Series/Andor/Season 1/Andor - S01E01 - Kassa/trickplay"),
    );
  });

  /*
   * `.seyirlik/` is the hidden playback layer: playlists and the package
   * manifest. Sheets are visible generated media and belong beside the other
   * visible generated media.
   */
  it("is never under .seyirlik and never under content", () => {
    const directory = trickplayDirectoryFor(
      hostPath("/media/Movies/Dune (2021)"),
    );

    expect(directory).not.toContain(".seyirlik");
    expect(directory).not.toContain("/content/");
    expect(path.basename(directory)).toBe(TITLE_TRICKPLAY_DIRECTORY);
  });

  it("numbers sheets from zero", () => {
    expect(spriteFileName(0)).toBe("sprite_0.jpg");
    expect(spriteFileName(12)).toBe("sprite_12.jpg");
  });
});

describe("staging directories", () => {
  it("stages inside the title folder, under a hidden name the scanner ignores", () => {
    const staging = trickplayStagingDirectory(
      hostPath("/media/Movies/Dune (2021)"),
      "abc",
    );

    expect(staging).toBe(
      hostPath("/media/Movies/Dune (2021)/.trickplay-publish-abc"),
    );
    expect(path.basename(staging).startsWith(".")).toBe(true);
    expect(isTrickplayStagingDirectory(path.basename(staging))).toBe(true);
  });

  it("does not mistake the live directory for a staging one", () => {
    expect(isTrickplayStagingDirectory(TITLE_TRICKPLAY_DIRECTORY)).toBe(false);
    expect(isTrickplayStagingDirectory(TRICKPLAY_STAGING_PREFIX)).toBe(false);
  });
});

/**
 * The predicate destructive work is allowed to use.
 *
 * This decides what the archival command copies out of the library and then
 * deletes, so the cases that must be false matter more than the ones that must
 * be true.
 */
describe("telling legacy external trickplay from the managed directory", () => {
  it("recognises movie, episode and trailer folders", () => {
    for (const name of [
      "Dune (2021) [438631].trickplay",
      "The Sopranos - S01E01 - Pilot.trickplay",
      "trailer.trickplay",
    ]) {
      expect(isLegacyExternalTrickplayDirectory(name)).toBe(true);
    }
  });

  it("never matches the managed directory", () => {
    expect(isLegacyExternalTrickplayDirectory("trickplay")).toBe(false);
    expect(isLegacyExternalTrickplayDirectory(TITLE_TRICKPLAY_DIRECTORY)).toBe(
      false,
    );
  });

  /*
   * The bug this predicate exists to make impossible: a substring test would
   * have matched every one of these, and the tool that uses it deletes.
   */
  it("never matches a name that merely contains the word", () => {
    for (const name of [
      "trickplay",
      "trickplays",
      "trickplay-backup",
      "my trickplay folder",
      "trickplay.old",
      ".trickplay",
      "",
    ]) {
      expect(isLegacyExternalTrickplayDirectory(name)).toBe(false);
    }
  });
});

describe("containment", () => {
  it("resolves before it compares, so `..` cannot pass", () => {
    expect(
      isInsideDirectory(
        hostPath("/media"),
        hostPath("/media/Movies/a.trickplay"),
      ),
    ).toBe(true);
    expect(
      isInsideDirectory(hostPath("/media"), hostPath("/media/../etc/passwd")),
    ).toBe(false);
    expect(
      isInsideDirectory(
        hostPath("/media"),
        hostPath("/media/Movies/../../etc"),
      ),
    ).toBe(false);
  });

  it("does not read a sibling with a shared prefix as being inside", () => {
    expect(
      isInsideDirectory(hostPath("/media"), hostPath("/media-old/Movies")),
    ).toBe(false);
    expect(
      isInsideDirectory(
        "/Volumes/Expansion/media",
        "/Volumes/Expansion/media-downloads",
      ),
    ).toBe(false);
  });

  it("treats a root as inside itself", () => {
    expect(isInsideDirectory(hostPath("/media"), hostPath("/media"))).toBe(
      true,
    );
  });
});
