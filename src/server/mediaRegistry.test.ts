// @vitest-environment node
import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createMediaRegistry,
  decodeMediaToken,
  encodeMediaToken,
  resolveMedia,
} from "./mediaRegistry";

async function createTempMediaRoot() {
  return mkdtemp(path.join(tmpdir(), "seyirlik-media-registry-"));
}

describe("mediaRegistry", () => {
  it("resolves a valid nested relative path", async () => {
    const root = await createTempMediaRoot();

    try {
      await mkdir(path.join(root, "Movies", "Arcane"), { recursive: true });
      await writeFile(
        path.join(root, "Movies", "Arcane", "Episode 1.mkv"),
        "ok",
      );

      const media = await resolveMedia(root, "Movies/Arcane/Episode 1.mkv");

      expect(media.mediaId).toBe("Movies/Arcane/Episode 1.mkv");
      await expect(realpath(media.filePath)).resolves.toBe(
        await realpath(path.join(root, "Movies", "Arcane", "Episode 1.mkv")),
      );
      expect(media.size).toBe(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects traversal", async () => {
    const root = await createTempMediaRoot();

    try {
      await expect(resolveMedia(root, "../secret.mkv")).rejects.toMatchObject({
        code: "MEDIA_ID_INVALID",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects encoded traversal", async () => {
    const root = await createTempMediaRoot();

    try {
      await expect(
        resolveMedia(root, "%2e%2e%2fsecret.mkv"),
      ).rejects.toMatchObject({
        code: "MEDIA_ID_INVALID",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects absolute Unix paths", async () => {
    const root = await createTempMediaRoot();

    try {
      await expect(resolveMedia(root, "/tmp/movie.mkv")).rejects.toMatchObject({
        code: "MEDIA_ID_INVALID",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects absolute Windows paths", async () => {
    const root = await createTempMediaRoot();

    try {
      await expect(
        resolveMedia(root, "C:\\Media\\movie.mkv"),
      ).rejects.toMatchObject({
        code: "MEDIA_ID_INVALID",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects mixed separators", async () => {
    const root = await createTempMediaRoot();

    try {
      await expect(
        resolveMedia(root, "Movies\\Arcane\\Episode 1.mkv"),
      ).rejects.toMatchObject({
        code: "MEDIA_ID_INVALID",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects symlinks escaping the media root", async () => {
    const root = await createTempMediaRoot();
    const outside = await mkdtemp(
      path.join(tmpdir(), "seyirlik-media-outside-"),
    );

    try {
      await writeFile(path.join(outside, "secret.mkv"), "secret");

      try {
        await symlink(
          path.join(outside, "secret.mkv"),
          path.join(root, "linked.mkv"),
        );
      } catch {
        return;
      }

      await expect(resolveMedia(root, "linked.mkv")).rejects.toMatchObject({
        code: "MEDIA_OUTSIDE_ROOT",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("rejects missing files", async () => {
    const root = await createTempMediaRoot();

    try {
      await expect(resolveMedia(root, "missing.mkv")).rejects.toMatchObject({
        code: "MEDIA_NOT_FOUND",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects directories", async () => {
    const root = await createTempMediaRoot();

    try {
      await mkdir(path.join(root, "Movies"));

      await expect(resolveMedia(root, "Movies")).rejects.toMatchObject({
        code: "MEDIA_NOT_FILE",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("round trips valid media tokens", async () => {
    const mediaId = "Movies/Arcane/Episode 1.mkv";
    const token = encodeMediaToken(mediaId);

    expect(token).not.toContain("/");
    expect(decodeMediaToken(token)).toBe(mediaId);
  });

  it("rejects invalid media tokens", () => {
    expect(() => decodeMediaToken("not+a+token")).toThrow();
  });

  it("creates a registry bound to a media root", async () => {
    const root = await createTempMediaRoot();

    try {
      await writeFile(path.join(root, "movie.mp4"), "ok");
      const registry = await createMediaRegistry(root);
      const media = await registry.resolveMedia("movie.mp4");

      expect(media.mediaId).toBe("movie.mp4");
      expect(
        registry.decodeMediaToken(registry.encodeMediaToken("movie.mp4")),
      ).toBe("movie.mp4");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
