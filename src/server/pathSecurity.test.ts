// @vitest-environment node
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertMediaRootDirectory, TrustedPathError } from "./pathSecurity";

/*
 * Only `opendir` is controllable, and only while `failOpendirWith` is set.
 * Everything else is the real filesystem, so the directories these tests make
 * are real directories and the passing cases prove something.
 */
let failOpendirWith: NodeJS.ErrnoException | null = null;
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    opendir: (async (...args: Parameters<typeof actual.opendir>) => {
      if (failOpendirWith) throw failOpendirWith;
      return actual.opendir(...args);
    }) as typeof actual.opendir,
  };
});

/**
 * Whether the media root answers is not whether the library is readable.
 *
 * A failing external disk kept answering `stat` on the media root — plausibly
 * from cached directory metadata — while every library directory beneath it
 * returned "I/O device error" on ten attempts out of ten. Startup reported
 * `mediaStorage=available` and `ready=true` for the whole outage, which is the
 * one condition the check exists to notice.
 */
let workspace: string;
let mediaRoot: string;

beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "seyirlik-pathsec-"));
  mediaRoot = path.join(workspace, "media");
  await mkdir(path.join(mediaRoot, "Movies"), { recursive: true });
  await mkdir(path.join(mediaRoot, "Series"), { recursive: true });
  await mkdir(path.join(mediaRoot, "Books"), { recursive: true });
  await writeFile(path.join(mediaRoot, "Movies", "A Film (1999).mkv"), "x");
});

afterAll(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe("deciding whether the media root is usable", () => {
  it("accepts a root whose configured libraries open", async () => {
    const resolved = await assertMediaRootDirectory(mediaRoot, {
      requiredLibraryRoots: ["Movies", "Series"],
    });
    expect(resolved.endsWith("media")).toBe(true);
  });

  it("still accepts a root when no libraries are named", async () => {
    // The cheap check other callers rely on must not change.
    await expect(assertMediaRootDirectory(mediaRoot)).resolves.toBeTruthy();
  });

  it("refuses a configured library that is not there", async () => {
    await expect(
      assertMediaRootDirectory(mediaRoot, {
        requiredLibraryRoots: ["Movies", "Missing"],
      }),
    ).rejects.toMatchObject({ code: "MEDIA_LIBRARY_UNREADABLE" });
  });

  it("refuses when the root stats but a library read raises EIO", async () => {
    /*
     * The incident itself: `stat` on the root succeeds and the failure appears
     * only on opening a child, which is exactly what the old check never did.
     */
    const eio = new Error("EIO: i/o error, opendir") as NodeJS.ErrnoException;
    eio.code = "EIO";
    failOpendirWith = eio;
    try {
      await expect(
        assertMediaRootDirectory(mediaRoot, {
          requiredLibraryRoots: ["Movies"],
        }),
      ).rejects.toMatchObject({ code: "MEDIA_LIBRARY_UNREADABLE" });
      // And the root on its own still passes, which is why the old check did.
      failOpendirWith = null;
      await expect(assertMediaRootDirectory(mediaRoot)).resolves.toBeTruthy();
    } finally {
      failOpendirWith = null;
    }
  });

  it("raises a TrustedPathError, so callers classify it as storage", async () => {
    const eio = new Error("EIO: i/o error") as NodeJS.ErrnoException;
    eio.code = "EIO";
    failOpendirWith = eio;
    try {
      await expect(
        assertMediaRootDirectory(mediaRoot, {
          requiredLibraryRoots: ["Series"],
        }),
      ).rejects.toBeInstanceOf(TrustedPathError);
    } finally {
      failOpendirWith = null;
    }
  });

  it("does not require a library it was not given, such as Books", async () => {
    // Books is Jellyfin's; failing this server on a directory it never reads
    // would be a false alarm.
    await expect(
      assertMediaRootDirectory(mediaRoot, { requiredLibraryRoots: ["Movies"] }),
    ).resolves.toBeTruthy();
  });

  it("reports the directory operation it is about to perform", async () => {
    const seen: string[] = [];
    await assertMediaRootDirectory(mediaRoot, {
      requiredLibraryRoots: ["Movies"],
      onOperation: (operation) => seen.push(operation),
    });
    expect(seen).toContain("stat");
    expect(seen).toContain("opendir");
    expect(seen).toContain("realpath");
  });
});
