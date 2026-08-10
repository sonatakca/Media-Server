import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createImageStorage, detectImageType } from "./imageStorage";

const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.alloc(64, 1),
]);
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 2),
]);
const WEBP = Buffer.concat([
  Buffer.from("RIFF"),
  Buffer.alloc(4, 0),
  Buffer.from("WEBP"),
  Buffer.alloc(64, 3),
]);
const HTML = Buffer.from("<!doctype html><html>error page</html>");

describe("detectImageType", () => {
  it("recognizes the supported formats by magic bytes", () => {
    expect(detectImageType(JPEG)).toBe("image/jpeg");
    expect(detectImageType(PNG)).toBe("image/png");
    expect(detectImageType(WEBP)).toBe("image/webp");
  });

  it("rejects content that is not an image", () => {
    expect(detectImageType(HTML)).toBeNull();
    expect(detectImageType(Buffer.alloc(4))).toBeNull();
  });
});

describe("image storage", () => {
  let imageRoot: string;

  beforeEach(async () => {
    imageRoot = await mkdtemp(path.join(tmpdir(), "seyirlik-images-"));
  });

  afterEach(async () => {
    await rm(imageRoot, { recursive: true, force: true });
  });

  it("stores bytes under their content hash and can read them back", async () => {
    const storage = createImageStorage({ imageRoot });
    const stored = await storage.store(JPEG, "image/jpeg");

    expect(stored.contentType).toBe("image/jpeg");
    expect(stored.sizeBytes).toBe(JPEG.length);
    expect(stored.storageKey.endsWith(".jpg")).toBe(true);
    await expect(readFile(storage.resolve(stored.storageKey))).resolves.toEqual(
      JPEG,
    );
  });

  it("gives identical bytes the same key, so re-fetching costs nothing", async () => {
    const storage = createImageStorage({ imageRoot });
    const first = await storage.store(JPEG, "image/jpeg");
    const second = await storage.store(Buffer.from(JPEG), "image/jpeg");

    expect(second.storageKey).toBe(first.storageKey);
    expect(second.contentHash).toBe(first.contentHash);
  });

  it("gives different bytes different keys", async () => {
    const storage = createImageStorage({ imageRoot });
    const jpeg = await storage.store(JPEG, "image/jpeg");
    const png = await storage.store(PNG, "image/png");

    expect(png.contentHash).not.toBe(jpeg.contentHash);
  });

  it("refuses content whose bytes are not an image", async () => {
    const storage = createImageStorage({ imageRoot });
    await expect(storage.store(HTML, "image/jpeg")).rejects.toThrow(
      /not a supported image/,
    );
  });

  it("refuses a declared type that contradicts the bytes", async () => {
    const storage = createImageStorage({ imageRoot });
    await expect(storage.store(PNG, "image/jpeg")).rejects.toThrow(
      /does not match/,
    );
  });

  it("refuses empty content", async () => {
    const storage = createImageStorage({ imageRoot });
    await expect(storage.store(Buffer.alloc(0), "image/jpeg")).rejects.toThrow(
      /empty or too large/,
    );
  });

  it("downloads over HTTPS and stores the result", async () => {
    const storage = createImageStorage({
      imageRoot,
      fetchImpl: (async () =>
        new Response(JPEG, {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        })) as unknown as typeof fetch,
    });

    const stored = await storage.fetchAndStore("https://images.test/poster.jpg");
    expect(stored.contentType).toBe("image/jpeg");
  });

  it("refuses to fetch artwork over plaintext HTTP", async () => {
    const storage = createImageStorage({ imageRoot });
    await expect(
      storage.fetchAndStore("http://images.test/poster.jpg"),
    ).rejects.toThrow(/HTTPS/);
  });

  it("refuses a download that returns an error page instead of an image", async () => {
    const storage = createImageStorage({
      imageRoot,
      fetchImpl: (async () =>
        new Response(HTML, {
          status: 200,
          headers: { "content-type": "text/html" },
        })) as unknown as typeof fetch,
    });

    await expect(
      storage.fetchAndStore("https://images.test/missing.jpg"),
    ).rejects.toThrow(/not a supported image/);
  });

  it("removes a stored image without failing when it is already gone", async () => {
    const storage = createImageStorage({ imageRoot });
    const stored = await storage.store(WEBP, "image/webp");

    await storage.remove(stored.storageKey);
    await expect(storage.remove(stored.storageKey)).resolves.toBeUndefined();
  });
});
