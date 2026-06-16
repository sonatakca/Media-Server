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
});
