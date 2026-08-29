import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatabasePool } from "../database/databasePool";
import { createImageStorage } from "./imageStorage";
import { migrateTitleArtwork } from "./titleArtworkMigration";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("title artwork migration", () => {
  it("copies a legacy image into content/ and repoints its row", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "seyirlik-art-migration-"));
    temporaryRoots.push(root);
    const mediaRoot = path.join(root, "media");
    const imageRoot = path.join(root, "generated-images");
    const titleRoot = "Movies/Dune (2021)";
    await mkdir(path.join(mediaRoot, titleRoot), { recursive: true });
    const storage = createImageStorage({ imageRoot, mediaRoot });
    const legacyBytes = await sharp({
      create: {
        width: 80,
        height: 120,
        channels: 3,
        background: "#8b5e3c",
      },
    })
      .png()
      .toBuffer();
    const legacy = await storage.store(legacyBytes, "image/png");
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            id: "image-1",
            kind: "movie",
            source_key: `movie:${titleRoot}`,
            primary_relative_path: `${titleRoot}/Dune (2021).mkv`,
            image_type: "cover",
            content_type: legacy.contentType,
            storage_key: legacy.storageKey,
          },
        ],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const result = await migrateTitleArtwork(
      { query } as unknown as Pick<DatabasePool, "query">,
      storage,
    );

    expect(result).toEqual({ migrated: 1, skipped: 0, failed: 0 });
    expect(query.mock.calls[1]?.[1]).toEqual([
      "image-1",
      expect.stringMatching(/^[0-9a-f]{64}$/),
      "image/jpeg",
      expect.any(Number),
      `media:${titleRoot}/content/cover.jpg`,
      legacy.storageKey,
    ]);
    await expect(
      sharp(storage.resolve(`media:${titleRoot}/content/cover.jpg`)).metadata(),
    ).resolves.toMatchObject({ format: "jpeg" });
  });

  it("leaves loose-file items in legacy storage because they have no title folder", async () => {
    const query = vi.fn().mockResolvedValueOnce({
      rows: [
        {
          id: "image-2",
          kind: "movie",
          source_key: "movie:Movies/Loose Film",
          primary_relative_path: "Movies/Loose Film.mkv",
          image_type: "cover",
          content_type: "image/jpeg",
          storage_key: "aa/bb/legacy.jpg",
        },
      ],
      rowCount: 1,
    });

    const result = await migrateTitleArtwork(
      { query } as unknown as Pick<DatabasePool, "query">,
      {} as never,
    );

    expect(result).toEqual({ migrated: 0, skipped: 1, failed: 0 });
    expect(query).toHaveBeenCalledTimes(1);
  });
});
