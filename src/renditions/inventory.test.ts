import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { discoverEligibleVideoFiles } from "./inventory";

describe("rendition media discovery", () => {
  it("discovers eligible libraries and ignores Books, generated data and non-video files", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "seyirlik-inventory-"));
    await mkdir(path.join(root, "Movies"), { recursive: true });
    await mkdir(path.join(root, "Series", "Dizi"), { recursive: true });
    await mkdir(path.join(root, "Books"), { recursive: true });
    await mkdir(path.join(root, "intros"), { recursive: true });
    await mkdir(path.join(root, ".seyirlik", "work"), { recursive: true });
    await writeFile(path.join(root, "Movies", "Çağrı.mkv"), "movie");
    await writeFile(path.join(root, "Movies", "poster.jpg"), "image");
    await writeFile(
      path.join(root, "Series", "Dizi", "Bölüm 01.MP4"),
      "episode",
    );
    await writeFile(path.join(root, "Books", "bonus.mp4"), "book video");
    await writeFile(path.join(root, "intros", "intro.webm"), "intro");
    await writeFile(
      path.join(root, ".seyirlik", "work", "partial.mp4"),
      "partial",
    );

    const files = await discoverEligibleVideoFiles(root);

    expect(files.map((file) => file.relativePath)).toEqual([
      "intros/intro.webm",
      "Movies/Çağrı.mkv",
      "Series/Dizi/Bölüm 01.MP4",
    ]);
    expect(files.map((file) => file.library)).toEqual([
      "intros",
      "Movies",
      "Series",
    ]);
  });

  it("does not follow directory symlinks or junction-like links", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "seyirlik-inventory-link-"));
    const outside = await mkdtemp(path.join(tmpdir(), "seyirlik-outside-"));
    await mkdir(path.join(root, "Movies"), { recursive: true });
    await writeFile(path.join(outside, "outside.mp4"), "outside");
    await symlink(outside, path.join(root, "Movies", "linked"), "dir");
    await symlink(root, path.join(root, "Movies", "loop"), "dir");

    expect(await discoverEligibleVideoFiles(root)).toEqual([]);
  });
});
