import { createHash } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Content-addressed artwork storage on the generated-storage volume.
 *
 * Bytes are keyed by their own hash, so re-fetching unchanged artwork is a
 * no-op, two items sharing a poster share one file, and the hash doubles as the
 * HTTP cache validator. Nothing is ever written into the media root.
 */

const MAX_IMAGE_BYTES = 12 * 1_024 * 1_024;

const ALLOWED_CONTENT_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

export interface StoredImageBytes {
  contentHash: string;
  contentType: string;
  sizeBytes: number;
  /** Path relative to the image root; never absolute in any response. */
  storageKey: string;
}

export interface ImageStorage {
  /** Absolute path for a stored key, for delivery. */
  resolve(storageKey: string): string;
  store(bytes: Buffer, contentType: string): Promise<StoredImageBytes>;
  fetchAndStore(url: string): Promise<StoredImageBytes>;
  remove(storageKey: string): Promise<void>;
}

/**
 * Verifies the declared type against the actual magic bytes. A provider that
 * mislabels a response, or a redirect to an HTML error page, must not be stored
 * and later served as an image.
 */
export function detectImageType(bytes: Buffer): string | null {
  if (bytes.length < 12) return null;

  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "image/png";
  }
  if (
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

export interface CreateImageStorageOptions {
  /** Directory under the generated-storage volume. */
  imageRoot: string;
  fetchImpl?: typeof fetch;
}

export function createImageStorage({
  imageRoot,
  fetchImpl = fetch,
}: CreateImageStorageOptions): ImageStorage {
  const root = path.resolve(imageRoot);

  function keyFor(contentHash: string, extension: string): string {
    // Two levels of fan-out keep any one directory small enough for a
    // filesystem that degrades on very large directories.
    return `${contentHash.slice(0, 2)}/${contentHash.slice(2, 4)}/${contentHash}.${extension}`;
  }

  async function store(
    bytes: Buffer,
    declaredContentType: string,
  ): Promise<StoredImageBytes> {
    if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) {
      throw new Error("The artwork is empty or too large.");
    }

    const actualType = detectImageType(bytes);
    if (!actualType || !ALLOWED_CONTENT_TYPES[actualType]) {
      throw new Error("The artwork is not a supported image.");
    }
    if (
      ALLOWED_CONTENT_TYPES[declaredContentType] &&
      declaredContentType !== actualType
    ) {
      throw new Error("The artwork content type does not match its bytes.");
    }

    const extension = ALLOWED_CONTENT_TYPES[actualType] as string;
    const contentHash = createHash("sha256").update(bytes).digest("hex");
    const storageKey = keyFor(contentHash, extension);
    const absolutePath = path.join(root, storageKey);

    await mkdir(path.dirname(absolutePath), { recursive: true });

    // Write to a unique temporary name and rename into place, so a concurrent
    // reader never observes a partially written image.
    const temporaryPath = `${absolutePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporaryPath, bytes);
    try {
      await rename(temporaryPath, absolutePath);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }

    return {
      contentHash,
      contentType: actualType,
      sizeBytes: bytes.length,
      storageKey,
    };
  }

  return {
    resolve: (storageKey) => path.join(root, storageKey),

    store,

    fetchAndStore: async (url) => {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:") {
        throw new Error("Artwork must be fetched over HTTPS.");
      }

      const response = await fetchImpl(parsed, {
        headers: { Accept: "image/jpeg,image/png,image/webp" },
        redirect: "follow",
      });
      if (!response.ok) {
        throw new Error("The artwork could not be downloaded.");
      }

      const declaredLength = Number(response.headers.get("content-length") ?? 0);
      if (declaredLength > MAX_IMAGE_BYTES) {
        throw new Error("The artwork is empty or too large.");
      }

      const bytes = Buffer.from(await response.arrayBuffer());
      return store(
        bytes,
        (response.headers.get("content-type") ?? "").split(";", 1)[0]?.trim() ??
          "",
      );
    },

    remove: async (storageKey) => {
      await unlink(path.join(root, storageKey)).catch(() => undefined);
    },
  };
}
