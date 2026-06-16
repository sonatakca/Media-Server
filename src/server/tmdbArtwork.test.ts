// @vitest-environment node
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMediaRegistry } from "./mediaRegistry";
import { createPlaybackBackend, type PlaybackBackend } from "./playbackBackend";

const backends: PlaybackBackend[] = [];
const tempDirs: string[] = [];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function imageResponse(contents: string, contentType = "image/jpeg"): Response {
  return new Response(Buffer.from(contents), {
    status: 200,
    headers: { "Content-Type": contentType },
  });
}

async function createTempDir(prefix = "seyirlik-tmdb-artwork-") {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));

  tempDirs.push(directory);
  return directory;
}

async function writeMediaFile(
  mediaRoot: string,
  relativePath: string,
  contents = "media",
) {
  const filePath = path.join(mediaRoot, ...relativePath.split("/"));

  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, contents);
  return filePath;
}

async function startBackend(options: {
  mediaRoot: string;
  fetchImpl: typeof fetch;
}) {
  const mediaRegistry = await createMediaRegistry(options.mediaRoot);
  const backend = await createPlaybackBackend({
    host: "127.0.0.1",
    port: 0,
    mediaRegistry,
    mediaStore: {
      getMediaAnalysis: vi.fn(),
      saveClientCapabilities: () => undefined,
    },
    allowedOrigins: ["http://allowed.test"],
    cleanupIntervalMs: 1_000,
    tmdbApiKey: "tmdb-v3-key",
    jellyfinServerUrl: "http://jellyfin.test",
    jellyfinApiKey: "jellyfin-key",
    fetchImpl: options.fetchImpl,
  });

  await new Promise<void>((resolveListen) => {
    backend.server.listen(0, "127.0.0.1", resolveListen);
  });

  backends.push(backend);

  const address = backend.server.address() as AddressInfo;

  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  const currentBackends = [...backends];
  const currentTempDirs = [...tempDirs];

  backends.length = 0;
  tempDirs.length = 0;

  await Promise.all(currentBackends.map((backend) => backend.close()));
  await Promise.all(
    currentTempDirs.map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("TMDB artwork backend", () => {
  it("loads only English, Turkish, and no-language images", async () => {
    const mediaRoot = await createTempDir();
    const requests: URL[] = [];
    const fetchImpl: typeof fetch = vi.fn(async (input) => {
      const url = new URL(String(input));
      requests.push(url);

      if (url.hostname === "api.themoviedb.org") {
        return jsonResponse({
          backdrops: [
            {
              file_path: "/clean.jpg",
              iso_639_1: null,
              width: 1920,
              height: 1080,
              aspect_ratio: 1.778,
              vote_average: 7,
              vote_count: 3,
            },
            {
              file_path: "/english.jpg",
              iso_639_1: "en",
              width: 1920,
              height: 1080,
              aspect_ratio: 1.778,
              vote_average: 9,
              vote_count: 5,
            },
            {
              file_path: "/turkish.jpg",
              iso_639_1: "tr",
              width: 1920,
              height: 1080,
              aspect_ratio: 1.778,
              vote_average: 8,
              vote_count: 4,
            },
            {
              file_path: "/french.jpg",
              iso_639_1: "fr",
              width: 1920,
              height: 1080,
              aspect_ratio: 1.778,
              vote_average: 10,
              vote_count: 99,
            },
          ],
          posters: [],
          logos: [],
        });
      }

      return jsonResponse({ error: "unexpected request" }, 500);
    });
    const baseUrl = await startBackend({ mediaRoot, fetchImpl });
    const response = await fetch(
      `${baseUrl}/api/tmdb-artwork/images?mediaType=movie&tmdbId=11&kind=landscape&language=en`,
    );
    const payload = (await response.json()) as {
      images: Array<{ filePath: string; language: string | null }>;
      targetFileName: string;
    };

    expect(response.status).toBe(200);
    expect(payload.targetFileName).toBe("landscape.jpg");
    expect(payload.images.map((image) => image.filePath)).toEqual([
      "/clean.jpg",
      "/english.jpg",
      "/turkish.jpg",
    ]);
    expect(payload.images.map((image) => image.language)).toEqual([
      null,
      "en",
      "tr",
    ]);
    expect(requests[0].searchParams.get("include_image_language")).toBe(
      "en,tr,null",
    );
  });

  it("replaces the selected sidecar artwork next to a Jellyfin media file", async () => {
    const mediaRoot = await createTempDir();
    const mediaFile = await writeMediaFile(
      mediaRoot,
      "Movies/Dune (2021)/Dune.mp4",
    );
    const fetchImpl: typeof fetch = vi.fn(async (input) => {
      const url = new URL(String(input));

      if (url.hostname === "jellyfin.test") {
        return jsonResponse({
          Items: [
            {
              Id: "dune",
              Type: "Movie",
              Path: mediaFile,
              MediaSources: [],
            },
          ],
        });
      }

      if (url.hostname === "image.tmdb.org") {
        return imageResponse("new-backdrop");
      }

      return jsonResponse({ error: "unexpected request" }, 500);
    });
    const baseUrl = await startBackend({ mediaRoot, fetchImpl });
    const response = await fetch(`${baseUrl}/api/tmdb-artwork/apply`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        itemId: "dune",
        kind: "backdrop",
        filePath: "/abc123.jpg",
      }),
    });
    const payload = (await response.json()) as {
      targetFileName: string;
      targetPath: string;
    };

    expect(response.status).toBe(200);
    expect(payload.targetFileName).toBe("backdrop.jpg");
    await expect(realpath(payload.targetPath)).resolves.toBe(
      await realpath(
        path.join(mediaRoot, "Movies", "Dune (2021)", "backdrop.jpg"),
      ),
    );
    await expect(readFile(payload.targetPath, "utf8")).resolves.toBe(
      "new-backdrop",
    );
  });

  it("writes trailer artwork next to the owning Jellyfin parent item", async () => {
    const mediaRoot = await createTempDir();
    const mediaFile = await writeMediaFile(
      mediaRoot,
      "Movies/Dune (2021)/Dune.mp4",
    );
    const trailerFile = await writeMediaFile(
      mediaRoot,
      "Movies/Dune (2021)/trailers/trailer.mp4",
    );
    const fetchImpl: typeof fetch = vi.fn(async (input) => {
      const url = new URL(String(input));

      if (url.hostname === "jellyfin.test") {
        const itemId = url.searchParams.get("Ids");

        if (itemId === "trailer-1") {
          return jsonResponse({
            Items: [
              {
                Id: "trailer-1",
                Name: "Trailer",
                Type: "Video",
                MediaType: "Video",
                ExtraType: "Trailer",
                ParentId: "dune",
                Path: trailerFile,
                MediaSources: [],
              },
            ],
          });
        }

        if (itemId === "dune") {
          return jsonResponse({
            Items: [
              {
                Id: "dune",
                Type: "Movie",
                Path: mediaFile,
                MediaSources: [],
              },
            ],
          });
        }
      }

      if (url.hostname === "image.tmdb.org") {
        return imageResponse("owner-poster");
      }

      return jsonResponse({ error: "unexpected request" }, 500);
    });
    const baseUrl = await startBackend({ mediaRoot, fetchImpl });
    const response = await fetch(`${baseUrl}/api/tmdb-artwork/apply`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        itemId: "trailer-1",
        kind: "poster",
        filePath: "/poster.jpg",
      }),
    });
    const payload = (await response.json()) as {
      targetPath: string;
    };

    expect(response.status).toBe(200);
    await expect(realpath(payload.targetPath)).resolves.toBe(
      await realpath(
        path.join(mediaRoot, "Movies", "Dune (2021)", "folder.jpg"),
      ),
    );
    await expect(
      readFile(
        path.join(mediaRoot, "Movies", "Dune (2021)", "trailers", "folder.jpg"),
        "utf8",
      ),
    ).rejects.toThrow();
  });

  it("falls back to the directory before a trailers segment for trailer artwork", async () => {
    const mediaRoot = await createTempDir();
    const trailerFile = await writeMediaFile(
      mediaRoot,
      "Series/Andor/trailers/trailer.mp4",
    );
    const fetchImpl: typeof fetch = vi.fn(async (input) => {
      const url = new URL(String(input));

      if (url.hostname === "jellyfin.test") {
        return jsonResponse({
          Items: [
            {
              Id: "andor-trailer",
              Name: "Fragman",
              Type: "Video",
              MediaType: "Video",
              ExtraType: "Trailer",
              Path: trailerFile,
              MediaSources: [],
            },
          ],
        });
      }

      if (url.hostname === "image.tmdb.org") {
        return imageResponse("owner-backdrop");
      }

      return jsonResponse({ error: "unexpected request" }, 500);
    });
    const baseUrl = await startBackend({ mediaRoot, fetchImpl });
    const response = await fetch(`${baseUrl}/api/tmdb-artwork/apply`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        itemId: "andor-trailer",
        kind: "backdrop",
        filePath: "/backdrop.jpg",
      }),
    });
    const payload = (await response.json()) as {
      targetPath: string;
    };

    expect(response.status).toBe(200);
    await expect(realpath(payload.targetPath)).resolves.toBe(
      await realpath(path.join(mediaRoot, "Series", "Andor", "backdrop.jpg")),
    );
    await expect(
      readFile(
        path.join(mediaRoot, "Series", "Andor", "trailers", "backdrop.jpg"),
        "utf8",
      ),
    ).rejects.toThrow();
  });

  it("rejects mismatched source formats for fixed sidecar filenames", async () => {
    const mediaRoot = await createTempDir();
    const mediaFile = await writeMediaFile(
      mediaRoot,
      "Movies/Dune (2021)/Dune.mp4",
    );
    const fetchImpl: typeof fetch = vi.fn(async (input) => {
      const url = new URL(String(input));

      if (url.hostname === "jellyfin.test") {
        return jsonResponse({
          Items: [
            {
              Id: "dune",
              Type: "Movie",
              Path: mediaFile,
              MediaSources: [],
            },
          ],
        });
      }

      if (url.hostname === "image.tmdb.org") {
        return imageResponse("<svg />", "image/svg+xml");
      }

      return jsonResponse({ error: "unexpected request" }, 500);
    });
    const baseUrl = await startBackend({ mediaRoot, fetchImpl });
    const response = await fetch(`${baseUrl}/api/tmdb-artwork/apply`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        itemId: "dune",
        kind: "logo",
        filePath: "/logo.svg",
      }),
    });
    const payload = (await response.json()) as {
      error: { code: string };
    };

    expect(response.status).toBe(409);
    expect(payload.error.code).toBe("TMDB_IMAGE_TYPE_UNSUPPORTED");
  });

  it("loads episode text in English and Turkish with a selected still language", async () => {
    const mediaRoot = await createTempDir();
    const requests: URL[] = [];
    const fetchImpl: typeof fetch = vi.fn(async (input) => {
      const url = new URL(String(input));
      requests.push(url);

      if (url.hostname !== "api.themoviedb.org") {
        return jsonResponse({ error: "unexpected request" }, 500);
      }

      if (url.pathname === "/3/tv/99/season/1") {
        if (url.searchParams.get("language") === "tr-TR") {
          return jsonResponse({
            episodes: [
              {
                episode_number: 1,
                name: "Türkçe Bir",
                overview: "Türkçe açıklama bir.",
                still_path: "/ep1-tr-detail.jpg",
              },
              {
                episode_number: 2,
                name: "Türkçe İki",
                overview: "Türkçe açıklama iki.",
              },
            ],
          });
        }

        return jsonResponse({
          episodes: [
            {
              episode_number: 1,
              name: "English One",
              overview: "English overview one.",
              still_path: "/ep1-en-detail.jpg",
            },
            {
              episode_number: 2,
              name: "English Two",
              overview: "English overview two.",
              still_path: "/ep2-en-detail.jpg",
            },
          ],
        });
      }

      if (url.pathname === "/3/tv/99/season/1/episode/1/images") {
        return jsonResponse({
          stills: [
            {
              file_path: "/ep1-null.jpg",
              iso_639_1: null,
              width: 1920,
              height: 1080,
              aspect_ratio: 1.778,
              vote_average: 10,
              vote_count: 99,
            },
            {
              file_path: "/ep1-en.jpg",
              iso_639_1: "en",
              width: 1280,
              height: 720,
              aspect_ratio: 1.778,
              vote_average: 1,
              vote_count: 1,
            },
          ],
        });
      }

      if (url.pathname === "/3/tv/99/season/1/episode/2/images") {
        return jsonResponse({ stills: [] });
      }

      return jsonResponse({ error: "unexpected request" }, 500);
    });
    const baseUrl = await startBackend({ mediaRoot, fetchImpl });
    const response = await fetch(
      `${baseUrl}/api/tmdb-artwork/episode-metadata?tmdbId=99&seasonNumber=1&thumbnailLanguage=en`,
    );
    const payload = (await response.json()) as {
      episodes: Array<{
        episodeNumber: number;
        name: { en: string | null; tr: string | null };
        overview: { en: string | null; tr: string | null };
        thumbnail: { filePath: string; language: string | null } | null;
      }>;
    };

    expect(response.status).toBe(200);
    expect(payload.episodes).toHaveLength(2);
    expect(payload.episodes[0]).toMatchObject({
      episodeNumber: 1,
      name: { en: "English One", tr: "Türkçe Bir" },
      overview: {
        en: "English overview one.",
        tr: "Türkçe açıklama bir.",
      },
      thumbnail: { filePath: "/ep1-en.jpg", language: "en" },
    });
    expect(payload.episodes[1]).toMatchObject({
      episodeNumber: 2,
      name: { en: "English Two", tr: "Türkçe İki" },
      thumbnail: { filePath: "/ep2-en-detail.jpg", language: null },
    });
    expect(
      requests
        .filter((url) => url.pathname.endsWith("/images"))
        .map((url) => url.searchParams.get("include_image_language")),
    ).toEqual(["en,null", "en,null"]);
  });
});
