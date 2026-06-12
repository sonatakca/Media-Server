// @vitest-environment node
import { constants } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createJellyfinMediaResolver,
  normalizeJellyfinServerUrl,
  type JellyfinMediaResolverOptions,
} from "./jellyfinMediaResolver";
import { isPathInsideRoot } from "./pathSecurity";

const tempDirs: string[] = [];

async function createTempDir(prefix = "seyirlik-jellyfin-resolver-") {
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function itemQueryResponse(item: unknown) {
  return {
    Items: [item],
    TotalRecordCount: 1,
    StartIndex: 0,
  };
}

function fetchItem(
  body: unknown,
  options: {
    status?: number;
    onRequest?: (input: URL, init?: RequestInit) => void;
  } = {},
): NonNullable<JellyfinMediaResolverOptions["fetchImpl"]> {
  return async (input, init) => {
    options.onRequest?.(input, init);
    return jsonResponse(body, options.status ?? 200);
  };
}

async function createResolver(
  mediaRoot: string,
  item: unknown,
  options: Partial<JellyfinMediaResolverOptions> = {},
) {
  return createJellyfinMediaResolver({
    mediaRoot,
    jellyfinServerUrl: "http://jellyfin.test/",
    apiKey: "test-api-key",
    fetchImpl: fetchItem(itemQueryResponse(item)),
    ...options,
  });
}

afterEach(async () => {
  const directories = [...tempDirs].reverse();

  tempDirs.length = 0;
  await Promise.all(
    directories.map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("jellyfin media resolver", () => {
  it("resolves a movie file media source inside the configured root", async () => {
    const mediaRoot = await createTempDir();
    const filePath = await writeMediaFile(mediaRoot, "Movies/sample.mp4");
    const resolver = await createResolver(mediaRoot, {
      Type: "Movie",
      MediaSources: [{ Protocol: "File", Path: filePath }],
    });

    const media = await resolver.resolveMedia(
      "3cb1ddd87cbc4fd9bb70e179e7990755",
    );

    expect(media.mediaId).toBe("3cb1ddd87cbc4fd9bb70e179e7990755");
    await expect(realpath(media.filePath)).resolves.toBe(
      await realpath(filePath),
    );
    expect(media.size).toBe(5);
  });

  it("resolves an episode through the item-level path fallback", async () => {
    const mediaRoot = await createTempDir();
    const filePath = await writeMediaFile(mediaRoot, "Shows/Arcane/S01E01.mkv");
    const resolver = await createResolver(mediaRoot, {
      Type: "Episode",
      Path: filePath,
      MediaSources: [],
    });

    const media = await resolver.resolveMedia("episode-1");

    await expect(realpath(media.filePath)).resolves.toBe(
      await realpath(filePath),
    );
  });

  it("handles filenames with brackets, spaces, commas, parentheses, and Unicode", async () => {
    const mediaRoot = await createTempDir();
    const relativePath =
      "Movies/Kardeş Payı [429] (Finale, Özel Bölüm)/Bölüm 1 [1080p].mkv";
    const filePath = await writeMediaFile(mediaRoot, relativePath, "unicode");
    const resolver = await createResolver(mediaRoot, {
      MediaType: "Video",
      MediaSources: [{ Protocol: "File", Path: filePath }],
    });

    const media = await resolver.resolveMedia("unicode-test");

    await expect(realpath(media.filePath)).resolves.toBe(
      await realpath(filePath),
    );
    expect(media.size).toBe(7);
  });

  it("prefers valid file media sources over the item-level path", async () => {
    const mediaRoot = await createTempDir();
    const sourcePath = await writeMediaFile(
      mediaRoot,
      "Movies/source.mp4",
      "source",
    );
    const itemPath = await writeMediaFile(mediaRoot, "Movies/item.mp4", "item");
    const resolver = await createResolver(mediaRoot, {
      Type: "Movie",
      Path: itemPath,
      MediaSources: [{ Protocol: "File", Path: sourcePath }],
    });

    const media = await resolver.resolveMedia("movie");

    await expect(realpath(media.filePath)).resolves.toBe(
      await realpath(sourcePath),
    );
  });

  it("skips non-file media sources when a later file source is valid", async () => {
    const mediaRoot = await createTempDir();
    const filePath = await writeMediaFile(mediaRoot, "Movies/local.mp4");
    const resolver = await createResolver(mediaRoot, {
      Type: "Movie",
      MediaSources: [
        { Protocol: "Http", Path: "https://cdn.example.test/movie.mp4" },
        { Protocol: "File", Path: filePath },
      ],
    });

    const media = await resolver.resolveMedia("movie");

    await expect(realpath(media.filePath)).resolves.toBe(
      await realpath(filePath),
    );
  });

  it("rejects items that only expose network sources", async () => {
    const mediaRoot = await createTempDir();
    const resolver = await createResolver(mediaRoot, {
      Type: "Movie",
      MediaSources: [
        { Protocol: "Http", Path: "https://cdn.example.test/movie.mp4" },
      ],
    });

    await expect(resolver.resolveMedia("movie")).rejects.toMatchObject({
      code: "JELLYFIN_LOCAL_PATH_REJECTED",
      statusCode: 409,
    });
  });

  it("maps missing Jellyfin items to a 404 resolver error", async () => {
    const mediaRoot = await createTempDir();
    const resolver = await createResolver(
      mediaRoot,
      {},
      {
        fetchImpl: fetchItem(
          { Items: [], TotalRecordCount: 0, StartIndex: 0 },
          { status: 200 },
        ),
      },
    );

    await expect(resolver.resolveMedia("missing")).rejects.toMatchObject({
      code: "JELLYFIN_ITEM_NOT_FOUND",
      statusCode: 404,
    });
  });

  it("keeps explicit Jellyfin HTTP 404 handling", async () => {
    const mediaRoot = await createTempDir();
    const resolver = await createResolver(
      mediaRoot,
      {},
      {
        fetchImpl: fetchItem({ error: "not found" }, { status: 404 }),
      },
    );

    await expect(resolver.resolveMedia("missing")).rejects.toMatchObject({
      code: "JELLYFIN_ITEM_NOT_FOUND",
      statusCode: 404,
    });
  });

  it("rejects non-video Jellyfin items", async () => {
    const mediaRoot = await createTempDir();
    const filePath = await writeMediaFile(mediaRoot, "Shows/series-folder");
    const resolver = await createResolver(mediaRoot, {
      Type: "Series",
      Path: filePath,
    });

    await expect(resolver.resolveMedia("series")).rejects.toMatchObject({
      code: "JELLYFIN_ITEM_NOT_VIDEO",
      statusCode: 409,
    });
  });

  it("rejects malformed Jellyfin item entries", async () => {
    const mediaRoot = await createTempDir();
    const resolver = await createResolver(mediaRoot, ["not", "an", "item"]);

    await expect(resolver.resolveMedia("movie")).rejects.toMatchObject({
      code: "JELLYFIN_RESPONSE_INVALID",
      statusCode: 502,
    });
  });

  it.each([{}, { Items: null }, { Items: {} }, { Items: ["not-an-object"] }])(
    "rejects malformed Jellyfin item query wrappers %#",
    async (wrapper) => {
      const mediaRoot = await createTempDir();
      const resolver = await createResolver(
        mediaRoot,
        {},
        {
          fetchImpl: fetchItem(wrapper),
        },
      );

      await expect(resolver.resolveMedia("movie")).rejects.toMatchObject({
        code: "JELLYFIN_RESPONSE_INVALID",
        statusCode: 502,
      });
    },
  );

  it("rejects file sources without a usable path", async () => {
    const mediaRoot = await createTempDir();
    const resolver = await createResolver(mediaRoot, {
      Type: "Movie",
      MediaSources: [{ Protocol: "File" }],
    });

    await expect(resolver.resolveMedia("movie")).rejects.toMatchObject({
      code: "JELLYFIN_LOCAL_PATH_REJECTED",
    });
  });

  it("rejects source files outside the configured root", async () => {
    const mediaRoot = await createTempDir();
    const outsideRoot = await createTempDir("seyirlik-jellyfin-outside-");
    const outsideFile = await writeMediaFile(outsideRoot, "secret.mp4");
    const resolver = await createResolver(mediaRoot, {
      Type: "Movie",
      MediaSources: [{ Protocol: "File", Path: outsideFile }],
    });

    await expect(resolver.resolveMedia("movie")).rejects.toMatchObject({
      code: "JELLYFIN_LOCAL_PATH_REJECTED",
      statusCode: 403,
    });
  });

  it("rejects sibling-prefix paths that merely start with the media root text", async () => {
    const mediaRoot = await createTempDir();
    const siblingRoot = `${mediaRoot}-evil`;

    tempDirs.push(siblingRoot);
    await mkdir(siblingRoot, { recursive: true });
    const siblingFile = await writeMediaFile(siblingRoot, "movie.mp4");
    const resolver = await createResolver(mediaRoot, {
      Type: "Movie",
      MediaSources: [{ Protocol: "File", Path: siblingFile }],
    });

    await expect(resolver.resolveMedia("movie")).rejects.toMatchObject({
      code: "JELLYFIN_LOCAL_PATH_REJECTED",
      statusCode: 403,
    });
  });

  it("rejects traversal paths after realpath resolution", async () => {
    const mediaRoot = await createTempDir();
    const outsideRoot = await createTempDir("seyirlik-jellyfin-outside-");
    const outsideFile = await writeMediaFile(outsideRoot, "secret.mp4");
    const traversalPath = path.join(
      mediaRoot,
      "..",
      path.basename(outsideRoot),
      "secret.mp4",
    );
    const resolver = await createResolver(mediaRoot, {
      Type: "Movie",
      MediaSources: [{ Protocol: "File", Path: traversalPath }],
    });

    expect(await realpath(traversalPath)).toBe(await realpath(outsideFile));
    await expect(resolver.resolveMedia("movie")).rejects.toMatchObject({
      code: "JELLYFIN_LOCAL_PATH_REJECTED",
      statusCode: 403,
    });
  });

  it("rejects directories", async () => {
    const mediaRoot = await createTempDir();
    const directory = path.join(mediaRoot, "Movies");

    await mkdir(directory, { recursive: true });
    const resolver = await createResolver(mediaRoot, {
      Type: "Movie",
      MediaSources: [{ Protocol: "File", Path: directory }],
    });

    await expect(resolver.resolveMedia("movie")).rejects.toMatchObject({
      code: "JELLYFIN_LOCAL_PATH_REJECTED",
      statusCode: 409,
    });
  });

  it("rejects missing source files", async () => {
    const mediaRoot = await createTempDir();
    const resolver = await createResolver(mediaRoot, {
      Type: "Movie",
      MediaSources: [
        { Protocol: "File", Path: path.join(mediaRoot, "missing.mp4") },
      ],
    });

    await expect(resolver.resolveMedia("movie")).rejects.toMatchObject({
      code: "JELLYFIN_LOCAL_PATH_REJECTED",
      statusCode: 409,
    });
  });

  it("rejects symlinks that escape the media root", async () => {
    const mediaRoot = await createTempDir();
    const outsideRoot = await createTempDir("seyirlik-jellyfin-outside-");
    const outsideFile = await writeMediaFile(outsideRoot, "secret.mp4");
    const linkedFile = path.join(mediaRoot, "linked.mp4");

    try {
      await symlink(outsideFile, linkedFile);
    } catch {
      return;
    }

    const resolver = await createResolver(mediaRoot, {
      Type: "Movie",
      MediaSources: [{ Protocol: "File", Path: linkedFile }],
    });

    await expect(resolver.resolveMedia("movie")).rejects.toMatchObject({
      code: "JELLYFIN_LOCAL_PATH_REJECTED",
      statusCode: 403,
    });
  });

  it("rejects unreadable files", async () => {
    const mediaRoot = await createTempDir();
    const filePath = await writeMediaFile(mediaRoot, "Movies/private.mp4");

    await chmod(filePath, 0o000);

    try {
      const permissionsAreEnforced = await access(filePath, constants.R_OK)
        .then(() => false)
        .catch(() => true);

      if (!permissionsAreEnforced) {
        return;
      }

      const resolver = await createResolver(mediaRoot, {
        Type: "Movie",
        MediaSources: [{ Protocol: "File", Path: filePath }],
      });

      await expect(resolver.resolveMedia("movie")).rejects.toMatchObject({
        code: "JELLYFIN_LOCAL_PATH_REJECTED",
        statusCode: 403,
      });
    } finally {
      await chmod(filePath, 0o600).catch(() => undefined);
    }
  });

  it("uses Windows case-insensitive containment semantics", () => {
    expect(
      isPathInsideRoot("D:\\media", "d:\\MEDIA\\Movie.mkv", {
        pathModule: path.win32,
      }),
    ).toBe(true);
    expect(
      isPathInsideRoot("D:\\media", "D:\\media-evil\\Movie.mkv", {
        pathModule: path.win32,
      }),
    ).toBe(false);
    expect(
      isPathInsideRoot("D:\\media", "D:\\media\\..\\secret\\Movie.mkv", {
        pathModule: path.win32,
      }),
    ).toBe(false);
  });

  it("sends the Jellyfin API key only as X-Emby-Token", async () => {
    const mediaRoot = await createTempDir();
    const filePath = await writeMediaFile(mediaRoot, "Movies/sample.mp4");
    let seenUrl = "";
    let seenMethod: string | undefined;
    let seenAccept: string | null = null;
    let seenToken: string | null = null;
    const resolver = await createResolver(
      mediaRoot,
      { Type: "Movie", MediaSources: [{ Protocol: "File", Path: filePath }] },
      {
        apiKey: "super-secret-test-key",
        fetchImpl: fetchItem(
          itemQueryResponse({
            Type: "Movie",
            MediaSources: [{ Protocol: "File", Path: filePath }],
          }),
          {
            onRequest: (input, init) => {
              const headers = new Headers(init?.headers);

              seenUrl = input.toString();
              seenMethod = init?.method;
              seenAccept = headers.get("Accept");
              seenToken = headers.get("X-Emby-Token");
            },
          },
        ),
      },
    );

    await resolver.resolveMedia("abc:def");

    const requestUrl = new URL(seenUrl);

    expect(requestUrl.pathname).toBe("/Items");
    expect(requestUrl.pathname).not.toContain("abc:def");
    expect(requestUrl.searchParams.get("Ids")).toBe("abc:def");
    expect(requestUrl.searchParams.get("Fields")).toBe("Path,MediaSources");
    expect(requestUrl.searchParams.get("Limit")).toBe("1");
    expect(seenUrl).toContain("Ids=abc%3Adef");
    expect(seenMethod).toBeUndefined();
    expect(seenAccept).toBe("application/json");
    expect(seenUrl).not.toContain("super-secret-test-key");
    expect(seenToken).toBe("super-secret-test-key");
  });

  it("maps Jellyfin request timeouts to a 502 without leaking details", async () => {
    const mediaRoot = await createTempDir();
    const resolver = await createJellyfinMediaResolver({
      mediaRoot,
      jellyfinServerUrl: "http://jellyfin.test",
      apiKey: "test-api-key",
      timeoutMs: 1,
      fetchImpl: (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const error = new Error("aborted");

            error.name = "AbortError";
            reject(error);
          });
        }),
    });

    await expect(resolver.resolveMedia("movie")).rejects.toMatchObject({
      code: "JELLYFIN_UNAVAILABLE",
      statusCode: 502,
      message: "Jellyfin item lookup timed out.",
    });
  });

  it("maps Jellyfin auth failures to a 502 without exposing the key", async () => {
    const mediaRoot = await createTempDir();
    const resolver = await createResolver(
      mediaRoot,
      {},
      {
        apiKey: "super-secret-test-key",
        fetchImpl: fetchItem({ error: "unauthorized" }, { status: 401 }),
      },
    );

    await expect(resolver.resolveMedia("movie")).rejects.toMatchObject({
      code: "JELLYFIN_AUTH_FAILED",
      statusCode: 502,
    });

    await resolver.resolveMedia("movie").catch((error: unknown) => {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain("super-secret-test-key");
    });
  });

  it("maps Jellyfin forbidden responses to a 502 auth failure", async () => {
    const mediaRoot = await createTempDir();
    const resolver = await createResolver(
      mediaRoot,
      {},
      {
        fetchImpl: fetchItem({ error: "forbidden" }, { status: 403 }),
      },
    );

    await expect(resolver.resolveMedia("movie")).rejects.toMatchObject({
      code: "JELLYFIN_AUTH_FAILED",
      statusCode: 502,
    });
  });

  it("logs safe metadata for unexpected Jellyfin HTTP statuses", async () => {
    const mediaRoot = await createTempDir();
    const warnings: string[] = [];
    const resolver = await createResolver(
      mediaRoot,
      {},
      {
        apiKey: "super-secret-test-key",
        logger: {
          warn: (message) => warnings.push(message),
        },
        fetchImpl: fetchItem(
          {
            error: "body contains D:\\media\\Movies\\secret.mp4",
          },
          { status: 500 },
        ),
      },
    );

    await expect(
      resolver.resolveMedia("cca0673dea01eba8cd3fe7749a25f110"),
    ).rejects.toMatchObject({
      code: "JELLYFIN_UNAVAILABLE",
      statusCode: 502,
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("HTTP 500");
    expect(warnings[0]).toContain("cca0673dea01...");
    expect(warnings[0]).not.toContain("super-secret-test-key");
    expect(warnings[0]).not.toContain("X-Emby-Token");
    expect(warnings[0]).not.toContain("D:\\media");
    expect(warnings[0]).not.toContain("body contains");
  });

  it("maps Jellyfin fetch failures to a 502 without exposing internals", async () => {
    const mediaRoot = await createTempDir();
    const resolver = await createJellyfinMediaResolver({
      mediaRoot,
      jellyfinServerUrl: "http://jellyfin.test",
      apiKey: "test-api-key",
      fetchImpl: async () => {
        throw new Error("network failed with backend-only details");
      },
    });

    await expect(resolver.resolveMedia("movie")).rejects.toMatchObject({
      code: "JELLYFIN_UNAVAILABLE",
      statusCode: 502,
      message: "Jellyfin item lookup failed.",
    });
  });

  it("does not expose absolute paths when rejecting local source paths", async () => {
    const mediaRoot = await createTempDir();
    const outsideRoot = await createTempDir("seyirlik-jellyfin-outside-");
    const outsideFile = await writeMediaFile(outsideRoot, "secret.mp4");
    const resolver = await createResolver(mediaRoot, {
      Type: "Movie",
      MediaSources: [{ Protocol: "File", Path: outsideFile }],
    });

    await resolver.resolveMedia("movie").catch((error: unknown) => {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain(mediaRoot);
      expect((error as Error).message).not.toContain(outsideFile);
    });
  });

  it("normalizes and validates Jellyfin server URLs", () => {
    expect(normalizeJellyfinServerUrl(" http://jellyfin.test:8096/ ")).toBe(
      "http://jellyfin.test:8096",
    );
    expect(normalizeJellyfinServerUrl("https://jellyfin.test/base///")).toBe(
      "https://jellyfin.test/base",
    );
    expect(() => normalizeJellyfinServerUrl("ftp://jellyfin.test")).toThrow();
  });

  it("rejects malformed Jellyfin item ids before making a request", async () => {
    const mediaRoot = await createTempDir();
    let requested = false;
    const resolver = await createJellyfinMediaResolver({
      mediaRoot,
      jellyfinServerUrl: "http://jellyfin.test",
      apiKey: "test-api-key",
      fetchImpl: async () => {
        requested = true;
        return jsonResponse({});
      },
    });

    await expect(resolver.resolveMedia("../movie")).rejects.toMatchObject({
      code: "JELLYFIN_ITEM_ID_INVALID",
      statusCode: 400,
    });
    expect(requested).toBe(false);
  });
});
