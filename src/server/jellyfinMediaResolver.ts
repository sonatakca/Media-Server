import path from "node:path";
import type {
  PlaybackMediaResolver,
  PlaybackResolvedMedia,
} from "../lib/playback-planner/playbackRoutes";
import {
  createMediaTokenRegistry,
  type MediaTokenRegistry,
} from "./mediaRegistry";
import {
  assertMediaRootDirectory,
  resolveTrustedFileInRoot,
  type TrustedPathError,
} from "./pathSecurity";

type FetchLike = (input: URL, init?: RequestInit) => Promise<Response>;

interface JellyfinItemResponse {
  Id?: unknown;
  Type?: unknown;
  MediaType?: unknown;
  Path?: unknown;
  MediaSources?: unknown;
}

interface JellyfinItemsResponse {
  Items?: unknown;
  TotalRecordCount?: unknown;
  StartIndex?: unknown;
}

interface JellyfinMediaSource {
  Id?: unknown;
  Protocol?: unknown;
  Path?: unknown;
  Container?: unknown;
}

export interface JellyfinMediaResolverLogger {
  info?(message: string): void;
  warn?(message: string): void;
}

export interface JellyfinMediaResolverOptions {
  jellyfinServerUrl: string;
  apiKey: string;
  mediaRoot: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  logger?: JellyfinMediaResolverLogger;
}

export class JellyfinMediaResolverError extends Error {
  code: string;
  statusCode: number;

  constructor(code: string, message: string, statusCode: number) {
    super(message);
    this.name = "JellyfinMediaResolverError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

const DEFAULT_TIMEOUT_MS = 8_000;
const ITEM_ID_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/;
const LOCAL_URL_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;
const VIDEO_TYPES = new Set([
  "Episode",
  "Movie",
  "MusicVideo",
  "Trailer",
  "Video",
]);

function safeItemLabel(itemId: string): string {
  return itemId.length <= 12 ? itemId : `${itemId.slice(0, 12)}...`;
}

export function normalizeJellyfinServerUrl(rawServerUrl: string): string {
  const trimmed = rawServerUrl.trim();

  if (!trimmed) {
    throw new JellyfinMediaResolverError(
      "JELLYFIN_SERVER_URL_REQUIRED",
      "SEYIRLIK_JELLYFIN_SERVER_URL is required.",
      500,
    );
  }

  let serverUrl: URL;

  try {
    serverUrl = new URL(trimmed);
  } catch {
    throw new JellyfinMediaResolverError(
      "JELLYFIN_SERVER_URL_INVALID",
      "SEYIRLIK_JELLYFIN_SERVER_URL must be a valid http(s) URL.",
      500,
    );
  }

  if (serverUrl.protocol !== "http:" && serverUrl.protocol !== "https:") {
    throw new JellyfinMediaResolverError(
      "JELLYFIN_SERVER_URL_INVALID",
      "SEYIRLIK_JELLYFIN_SERVER_URL must use http or https.",
      500,
    );
  }

  serverUrl.hash = "";
  serverUrl.search = "";

  return serverUrl.toString().replace(/\/+$/, "");
}

function validateItemId(itemId: string): string {
  const trimmed = itemId.trim();

  if (!ITEM_ID_PATTERN.test(trimmed)) {
    throw new JellyfinMediaResolverError(
      "JELLYFIN_ITEM_ID_INVALID",
      "Jellyfin item id is invalid.",
      400,
    );
  }

  return trimmed;
}

function assertJellyfinItem(value: unknown): JellyfinItemResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new JellyfinMediaResolverError(
      "JELLYFIN_RESPONSE_INVALID",
      "Jellyfin returned an invalid item response.",
      502,
    );
  }

  return value as JellyfinItemResponse;
}

function extractSingleJellyfinItem(value: unknown): JellyfinItemResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new JellyfinMediaResolverError(
      "JELLYFIN_RESPONSE_INVALID",
      "Jellyfin returned an invalid item response.",
      502,
    );
  }

  const response = value as JellyfinItemsResponse;

  if (!Array.isArray(response.Items)) {
    throw new JellyfinMediaResolverError(
      "JELLYFIN_RESPONSE_INVALID",
      "Jellyfin returned an invalid item response.",
      502,
    );
  }

  if (response.Items.length === 0) {
    throw new JellyfinMediaResolverError(
      "JELLYFIN_ITEM_NOT_FOUND",
      "Jellyfin item was not found.",
      404,
    );
  }

  return assertJellyfinItem(response.Items[0]);
}

function isVideoItem(item: JellyfinItemResponse): boolean {
  const mediaType = typeof item.MediaType === "string" ? item.MediaType : "";
  const type = typeof item.Type === "string" ? item.Type : "";

  return mediaType === "Video" || VIDEO_TYPES.has(type);
}

function isLocalFilesystemPath(candidatePath: string): boolean {
  return (
    !LOCAL_URL_PATTERN.test(candidatePath) &&
    (path.isAbsolute(candidatePath) ||
      path.win32.isAbsolute(candidatePath) ||
      path.posix.isAbsolute(candidatePath))
  );
}

function getPathValue(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();

  return trimmed ? trimmed : null;
}

function getFileMediaSources(
  item: JellyfinItemResponse,
): JellyfinMediaSource[] {
  if (!Array.isArray(item.MediaSources)) {
    return [];
  }

  return item.MediaSources.filter((source): source is JellyfinMediaSource => {
    if (!source || typeof source !== "object" || Array.isArray(source)) {
      return false;
    }

    const protocol = (source as JellyfinMediaSource).Protocol;

    return typeof protocol === "string" && protocol.toLowerCase() === "file";
  });
}

function toPlaybackResolverError(error: unknown): JellyfinMediaResolverError {
  const maybeTrustedPathError = error as Partial<TrustedPathError> | undefined;

  if (
    maybeTrustedPathError?.name === "TrustedPathError" &&
    typeof maybeTrustedPathError.code === "string"
  ) {
    return new JellyfinMediaResolverError(
      "JELLYFIN_LOCAL_PATH_REJECTED",
      "Jellyfin item does not expose a playable local file under the configured media root.",
      maybeTrustedPathError.statusCode === 403 ? 403 : 409,
    );
  }

  if (error instanceof JellyfinMediaResolverError) {
    return error;
  }

  return new JellyfinMediaResolverError(
    "JELLYFIN_LOCAL_PATH_REJECTED",
    "Jellyfin item does not expose a playable local file under the configured media root.",
    409,
  );
}

export class JellyfinMediaResolver implements PlaybackMediaResolver {
  readonly mediaRoot: string;
  private readonly serverUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly tokenRegistry: MediaTokenRegistry;
  private readonly logger?: JellyfinMediaResolverLogger;

  constructor(
    options: JellyfinMediaResolverOptions & {
      mediaRoot: string;
      serverUrl: string;
    },
  ) {
    this.mediaRoot = options.mediaRoot;
    this.serverUrl = options.serverUrl;
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.tokenRegistry = createMediaTokenRegistry();
    this.logger = options.logger;
  }

  encodeMediaToken(mediaId: string): string {
    return this.tokenRegistry.encodeMediaToken(mediaId);
  }

  decodeMediaToken(token: string): string {
    return this.tokenRegistry.decodeMediaToken(token);
  }

  async resolveMedia(mediaId: string): Promise<PlaybackResolvedMedia> {
    const itemId = validateItemId(mediaId);
    const startedAt = Date.now();
    const item = await this.fetchItem(itemId);

    if (!isVideoItem(item)) {
      throw new JellyfinMediaResolverError(
        "JELLYFIN_ITEM_NOT_VIDEO",
        "Jellyfin item is not a playable video.",
        409,
      );
    }

    const candidates = [
      ...getFileMediaSources(item).map((source) => getPathValue(source.Path)),
      getPathValue(item.Path),
    ].filter((candidatePath): candidatePath is string =>
      Boolean(candidatePath),
    );
    let lastError: unknown;

    for (const candidatePath of candidates) {
      if (!isLocalFilesystemPath(candidatePath)) {
        lastError = new JellyfinMediaResolverError(
          "JELLYFIN_LOCAL_PATH_REJECTED",
          "Jellyfin item does not expose a playable local file under the configured media root.",
          409,
        );
        continue;
      }

      try {
        const file = await resolveTrustedFileInRoot(
          this.mediaRoot,
          candidatePath,
        );

        this.logger?.info?.(
          `[Seyirlik Playback Backend] Resolved Jellyfin item ${safeItemLabel(
            itemId,
          )} to a trusted local media file in ${Date.now() - startedAt}ms.`,
        );

        return {
          mediaId: itemId,
          filePath: file.filePath,
          size: file.size,
          mtimeMs: file.mtimeMs,
        };
      } catch (error) {
        lastError = error;
      }
    }

    this.logger?.warn?.(
      `[Seyirlik Playback Backend] Jellyfin item ${safeItemLabel(
        itemId,
      )} had no trusted local playable source.`,
    );

    throw toPlaybackResolverError(lastError);
  }

  private async fetchItem(itemId: string): Promise<JellyfinItemResponse> {
    const requestUrl = new URL("Items", `${this.serverUrl}/`);

    requestUrl.searchParams.set("Ids", itemId);
    requestUrl.searchParams.set("Fields", "Path,MediaSources");
    requestUrl.searchParams.set("Limit", "1");

    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(requestUrl, {
        headers: {
          Accept: "application/json",
          "X-Emby-Token": this.apiKey,
        },
        signal: abortController.signal,
      });

      if (response.status === 404) {
        throw new JellyfinMediaResolverError(
          "JELLYFIN_ITEM_NOT_FOUND",
          "Jellyfin item was not found.",
          404,
        );
      }

      if (response.status === 401 || response.status === 403) {
        throw new JellyfinMediaResolverError(
          "JELLYFIN_AUTH_FAILED",
          "Jellyfin rejected the configured backend API key.",
          502,
        );
      }

      if (!response.ok) {
        this.logger?.warn?.(
          `[Seyirlik Playback Backend] Jellyfin item lookup returned HTTP ${
            response.status
          } for item ${safeItemLabel(itemId)}.`,
        );

        throw new JellyfinMediaResolverError(
          "JELLYFIN_UNAVAILABLE",
          "Jellyfin item lookup failed.",
          502,
        );
      }

      return extractSingleJellyfinItem(await response.json());
    } catch (error) {
      if (error instanceof JellyfinMediaResolverError) {
        throw error;
      }

      if (error instanceof Error && error.name === "AbortError") {
        throw new JellyfinMediaResolverError(
          "JELLYFIN_UNAVAILABLE",
          "Jellyfin item lookup timed out.",
          502,
        );
      }

      throw new JellyfinMediaResolverError(
        "JELLYFIN_UNAVAILABLE",
        "Jellyfin item lookup failed.",
        502,
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

export async function createJellyfinMediaResolver(
  options: JellyfinMediaResolverOptions,
): Promise<JellyfinMediaResolver> {
  const serverUrl = normalizeJellyfinServerUrl(options.jellyfinServerUrl);

  if (!options.apiKey.trim()) {
    throw new JellyfinMediaResolverError(
      "JELLYFIN_API_KEY_REQUIRED",
      "SEYIRLIK_JELLYFIN_API_KEY is required.",
      500,
    );
  }

  const mediaRoot = await assertMediaRootDirectory(options.mediaRoot);

  return new JellyfinMediaResolver({
    ...options,
    mediaRoot,
    serverUrl,
  });
}
