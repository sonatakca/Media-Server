import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import type { ServerResponse } from "node:http";
import { OwnApiError } from "../ownApiHandler";
import { sendData, sendNoContent } from "../api/envelope";
import type { RouteDefinition } from "../api/router";
import {
  asObjectBody,
  optionalBodyInteger,
  optionalBodyString,
  requireUuid,
  validationError,
} from "../api/validation";
import { isPathInsideRoot } from "../../pathSecurity";
import { decidePlaybackPlan } from "../../../lib/playback-planner/playbackDecision";
import type { PlaybackSessionManager } from "../../../lib/playback-planner/playbackSessionManager";
import type {
  ClientCapabilities,
  PlaybackPlan,
} from "../../../lib/playback-planner/types";
import type { CatalogueRepository } from "../catalogue/catalogueRepository";
import { buildAnalysisFromInventory } from "../probe/analysisFromInventory";
import type { PlaybackSessionStore } from "./playbackSessionStore";

export const PLAYBACK_SESSION_ROUTE_BASE = "/ownAPI/v1/playback/sessions";

export interface PlaybackRoutesOptions {
  catalogue: CatalogueRepository;
  sessions: PlaybackSessionStore;
  sessionManager: PlaybackSessionManager;
  mediaRoot: string;
}

/** Native plan modes; the browser never sees a Jellyfin transcode reason again. */
type NativeMode = "DIRECT_PLAY" | "REMUX" | "DIRECT_STREAM" | "TRANSCODE";

export function toNativeMode(plan: PlaybackPlan): NativeMode {
  if (!plan.requiresFfmpeg) return "DIRECT_PLAY";
  if (plan.video.action === "transcode" || plan.subtitles.action === "burn") {
    return "TRANSCODE";
  }
  if (plan.audio.action === "transcode") return "DIRECT_STREAM";
  return "REMUX";
}

/**
 * Reason codes are stable machine-readable identifiers; the human strings that
 * accompany them are for diagnostics only and must never be parsed by a client.
 */
export function toReasonCodes(plan: PlaybackPlan): string[] {
  const codes: string[] = [];
  if (plan.container.action !== "direct") codes.push("CONTAINER_NOT_SUPPORTED");
  if (plan.video.action === "transcode") codes.push("VIDEO_CODEC_NOT_SUPPORTED");
  if (plan.audio.action === "transcode") codes.push("AUDIO_CODEC_NOT_SUPPORTED");
  if (plan.subtitles.action === "burn") codes.push("SUBTITLE_BURN_IN_REQUIRED");
  return codes;
}

function parseCapabilities(value: unknown): ClientCapabilities {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw validationError("clientCapabilities is invalid.");
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.supportsHlsNative !== "boolean" ||
    typeof candidate.supportsMediaSource !== "boolean" ||
    !Array.isArray(candidate.directFileContainers) ||
    !Array.isArray(candidate.mseContainers) ||
    typeof candidate.video !== "object" ||
    typeof candidate.audio !== "object" ||
    typeof candidate.subtitles !== "object"
  ) {
    throw validationError("clientCapabilities is invalid.");
  }
  return value as ClientCapabilities;
}

function parseByteRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | null | "unsatisfiable" {
  if (!header) return null;

  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return "unsatisfiable";

  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return "unsatisfiable";

  if (!rawStart) {
    // Suffix range: the last N bytes.
    const suffixLength = Number(rawEnd);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) {
      return "unsatisfiable";
    }
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }

  const start = Number(rawStart);
  const end = rawEnd ? Number(rawEnd) : size - 1;
  if (!Number.isFinite(start) || start >= size || end < start) {
    return "unsatisfiable";
  }
  return { start, end: Math.min(end, size - 1) };
}

const CONTENT_TYPES: Record<string, string> = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mkv: "video/x-matroska",
  m3u8: "application/vnd.apple.mpegurl",
  ts: "video/mp2t",
  m4s: "video/iso.segment",
  vtt: "text/vtt; charset=utf-8",
};

function contentTypeFor(fileName: string): string {
  const extension = path.extname(fileName).replace(".", "").toLowerCase();
  return CONTENT_TYPES[extension] ?? "application/octet-stream";
}

async function serveFile(
  response: ServerResponse,
  absolutePath: string,
  rangeHeader: string | undefined,
  isHeadRequest: boolean,
  cacheControl: string,
): Promise<void> {
  const stats = await stat(absolutePath).catch(() => null);
  if (!stats?.isFile()) {
    throw new OwnApiError(
      "MEDIA_NOT_FOUND",
      "The requested media could not be found.",
      404,
    );
  }

  const range = parseByteRange(rangeHeader, stats.size);
  if (range === "unsatisfiable") {
    response.setHeader("Content-Range", `bytes */${stats.size}`);
    throw new OwnApiError(
      "RANGE_NOT_SATISFIABLE",
      "The requested range cannot be satisfied.",
      416,
    );
  }

  response.setHeader("Content-Type", contentTypeFor(absolutePath));
  response.setHeader("Accept-Ranges", "bytes");
  response.setHeader("Cache-Control", cacheControl);
  response.setHeader("X-Content-Type-Options", "nosniff");

  if (range) {
    response.statusCode = 206;
    response.setHeader(
      "Content-Range",
      `bytes ${range.start}-${range.end}/${stats.size}`,
    );
    response.setHeader("Content-Length", String(range.end - range.start + 1));
  } else {
    response.statusCode = 200;
    response.setHeader("Content-Length", String(stats.size));
  }

  if (isHeadRequest) {
    response.end();
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(
      absolutePath,
      range ? { start: range.start, end: range.end } : undefined,
    );
    // A client that seeks away aborts the response; that is normal, not an error.
    response.on("close", () => stream.destroy());
    stream.on("error", reject);
    stream.pipe(response).on("finish", resolve).on("error", reject);
  });
}

export function createPlaybackRoutes({
  catalogue,
  sessions,
  sessionManager,
  mediaRoot,
}: PlaybackRoutesOptions): RouteDefinition[] {
  const resolvedMediaRoot = path.resolve(mediaRoot);

  /**
   * Resolves an item to a playable file for one specific user.
   *
   * Authorization happens here rather than in a shared resolver, so possession
   * of an item or file id can never be traded for bytes from a library the
   * caller cannot see.
   */
  async function resolvePlayable(userId: string, itemId: string, mediaFileId?: string) {
    if (!(await catalogue.canUserAccessItem(userId, itemId))) {
      throw new OwnApiError(
        "ITEM_NOT_FOUND",
        "The requested item could not be found.",
        404,
      );
    }

    const file = mediaFileId
      ? await catalogue.getFileById(mediaFileId)
      : await catalogue.getPrimaryFile(itemId);

    if (!file || file.itemId !== itemId || file.missingSince !== null) {
      throw new OwnApiError(
        "MEDIA_NOT_FOUND",
        "The requested media could not be found.",
        404,
      );
    }
    if (file.probeState !== "probed") {
      throw new OwnApiError(
        "MEDIA_NOT_READY",
        "The media has not finished analysis yet.",
        409,
      );
    }

    const absolutePath = path.resolve(
      resolvedMediaRoot,
      ...file.relativePath.split("/"),
    );
    if (!isPathInsideRoot(resolvedMediaRoot, absolutePath)) {
      throw new OwnApiError(
        "MEDIA_NOT_FOUND",
        "The requested media could not be found.",
        404,
      );
    }

    const [streams, chapters] = await Promise.all([
      catalogue.listStreams(file.id),
      catalogue.listChapters(itemId),
    ]);

    return {
      file,
      absolutePath,
      analysis: buildAnalysisFromInventory({
        file,
        streams,
        filePath: absolutePath,
        chapters,
      }),
    };
  }

  function planRequestBody(raw: unknown) {
    const body = asObjectBody(raw, [
      "itemId",
      "mediaFileId",
      "clientCapabilities",
      "audioStreamIndex",
      "subtitleStreamIndex",
      "maxHeight",
      "maxBitrateBps",
    ]);

    return {
      itemId: requireUuid(optionalBodyString(body, "itemId"), "itemId"),
      mediaFileId: body.mediaFileId
        ? requireUuid(optionalBodyString(body, "mediaFileId"), "mediaFileId")
        : undefined,
      clientCapabilities: parseCapabilities(body.clientCapabilities),
      audioStreamIndex: optionalBodyInteger(body, "audioStreamIndex", {
        min: 0,
        max: 100_000,
      }),
      subtitleStreamIndex: optionalBodyInteger(body, "subtitleStreamIndex", {
        min: 0,
        max: 100_000,
      }),
      maxHeight: optionalBodyInteger(body, "maxHeight", { min: 144, max: 4_320 }),
      maxBitrateBps: optionalBodyInteger(body, "maxBitrateBps", {
        min: 100_000,
        max: 400_000_000,
      }),
    };
  }

  function buildPlan(
    request: ReturnType<typeof planRequestBody>,
    analysis: ReturnType<typeof buildAnalysisFromInventory>,
  ): PlaybackPlan {
    return decidePlaybackPlan({
      media: analysis,
      client: request.clientCapabilities,
      ...(request.audioStreamIndex === undefined
        ? {}
        : { selectedAudioStreamIndex: request.audioStreamIndex }),
      ...(request.subtitleStreamIndex === undefined
        ? {}
        : { selectedSubtitleStreamIndex: request.subtitleStreamIndex }),
      ...(request.maxHeight === undefined && request.maxBitrateBps === undefined
        ? {}
        : {
            forceQualityLimit: {
              ...(request.maxHeight === undefined
                ? {}
                : { maxHeight: request.maxHeight }),
              ...(request.maxBitrateBps === undefined
                ? {}
                : { maxBitrateBps: request.maxBitrateBps }),
            },
          }),
    });
  }

  function planDto(plan: PlaybackPlan) {
    return {
      mode: toNativeMode(plan),
      reasonCodes: toReasonCodes(plan),
      reasons: plan.reasons,
      requiresTranscode: plan.requiresFfmpeg,
      preservesOriginalVideoQuality: plan.preservesOriginalVideoQuality,
      expectedStartup: plan.expectedStartup,
      container: plan.container,
      video: plan.video,
      audio: plan.audio,
      subtitles: plan.subtitles,
      selected: plan.selected,
    };
  }

  async function requireOwnedSession(userId: string, sessionId: string) {
    const session = await sessions.get(sessionId);
    if (!session || session.userId !== userId || session.status !== "active") {
      throw new OwnApiError(
        "SESSION_NOT_FOUND",
        "The playback session could not be found.",
        404,
      );
    }
    return session;
  }

  return [
    {
      method: "POST",
      path: "/playback/plan",
      access: "authenticated",
      handle: async (context) => {
        const principal = context.requirePrincipal();
        const request = planRequestBody(await context.readJson(32 * 1_024));
        const { analysis } = await resolvePlayable(
          principal.userId,
          request.itemId,
          request.mediaFileId,
        );

        sendData(
          context.response,
          context.requestId,
          planDto(buildPlan(request, analysis)),
        );
      },
    },

    {
      method: "POST",
      path: "/playback/sessions",
      access: "authenticated",
      handle: async (context) => {
        const principal = context.requirePrincipal();
        const request = planRequestBody(await context.readJson(32 * 1_024));
        const { file, analysis } = await resolvePlayable(
          principal.userId,
          request.itemId,
          request.mediaFileId,
        );
        const plan = buildPlan(request, analysis);
        const mode = toNativeMode(plan);

        let sessionId: string;
        let deliveryUrl: string;
        let deliveryType: "file" | "hls";
        let runtimeKey: string | null = null;

        if (plan.requiresFfmpeg) {
          const runtimeSession = await sessionManager.createSession(
            plan,
            analysis,
          );
          runtimeKey = runtimeSession.sessionId;
          sessionId = runtimeSession.sessionId;
          deliveryType = "hls";
          deliveryUrl = `${PLAYBACK_SESSION_ROUTE_BASE}/${sessionId}/master.m3u8`;
        } else {
          sessionId = await sessions.nextId();
          deliveryType = "file";
          deliveryUrl = `${PLAYBACK_SESSION_ROUTE_BASE}/${sessionId}/file`;
        }

        await sessions.create({
          id: sessionId,
          userId: principal.userId,
          itemId: request.itemId,
          mediaFileId: file.id,
          mode,
          runtimeKey,
          audioStreamIndex: plan.selected.audioStreamIndex ?? null,
          subtitleStreamIndex: plan.selected.subtitleStreamIndex ?? null,
          maxHeight: request.maxHeight ?? null,
          maxBitrateBps: request.maxBitrateBps ?? null,
          reasonCodes: toReasonCodes(plan),
        });

        sendData(context.response, context.requestId, {
          sessionId,
          itemId: request.itemId,
          mediaFileId: file.id,
          plan: planDto(plan),
          delivery: { type: deliveryType, url: deliveryUrl },
        });
      },
    },

    {
      method: "GET",
      path: "/playback/sessions/:sessionId",
      access: "authenticated",
      handle: async (context) => {
        const principal = context.requirePrincipal();
        const session = await requireOwnedSession(
          principal.userId,
          requireUuid(context.params.sessionId, "sessionId"),
        );

        sendData(context.response, context.requestId, {
          sessionId: session.id,
          itemId: session.itemId,
          mode: session.mode,
          status: session.status,
          positionMs: session.positionMs,
          isPaused: session.isPaused,
          reasonCodes: session.reasonCodes,
          createdAt: session.createdAt.toISOString(),
        });
      },
    },

    {
      method: "DELETE",
      path: "/playback/sessions/:sessionId",
      access: "authenticated",
      handle: async (context) => {
        const principal = context.requirePrincipal();
        const sessionId = requireUuid(context.params.sessionId, "sessionId");
        const session = await sessions.get(sessionId);

        // Ending a session is idempotent: a player that retries its teardown
        // during unload must not receive an error.
        if (session && session.userId === principal.userId) {
          if (session.runtimeKey) {
            await sessionManager.stopSession(session.runtimeKey);
          }
          await sessions.end(sessionId);
        }
        sendNoContent(context.response);
      },
    },

    {
      method: "GET",
      path: "/playback/sessions/:sessionId/file",
      access: "authenticated",
      // Served to a <video> element, which cannot attach a CSRF header. Safe:
      // the method is read-only and the session cookie still authorizes it.
      skipCsrf: true,
      handle: async (context) => {
        const principal = context.requirePrincipal();
        const session = await requireOwnedSession(
          principal.userId,
          requireUuid(context.params.sessionId, "sessionId"),
        );

        const file = await catalogue.getFileById(session.mediaFileId);
        if (!file || file.missingSince !== null) {
          throw new OwnApiError(
            "MEDIA_NOT_FOUND",
            "The requested media could not be found.",
            404,
          );
        }

        const absolutePath = path.resolve(
          resolvedMediaRoot,
          ...file.relativePath.split("/"),
        );
        if (!isPathInsideRoot(resolvedMediaRoot, absolutePath)) {
          throw new OwnApiError(
            "MEDIA_NOT_FOUND",
            "The requested media could not be found.",
            404,
          );
        }

        await sessions.touch(session.id);
        await serveFile(
          context.response,
          absolutePath,
          context.request.headers.range as string | undefined,
          context.method === "HEAD",
          "private, max-age=0, no-cache",
        );
      },
    },

    {
      method: "GET",
      path: "/playback/sessions/:sessionId/master.m3u8",
      access: "authenticated",
      skipCsrf: true,
      handle: async (context) => {
        const principal = context.requirePrincipal();
        const session = await requireOwnedSession(
          principal.userId,
          requireUuid(context.params.sessionId, "sessionId"),
        );
        const runtime = session.runtimeKey
          ? sessionManager.getSession(session.runtimeKey)
          : undefined;
        if (!runtime) {
          throw new OwnApiError(
            "SESSION_NOT_FOUND",
            "The playback session could not be found.",
            404,
          );
        }

        await sessions.touch(session.id);
        await serveFile(
          context.response,
          path.join(runtime.outputDir, "master.m3u8"),
          undefined,
          context.method === "HEAD",
          // A playlist is session-bound and changes as segments appear.
          "no-store",
        );
      },
    },

    {
      method: "GET",
      path: "/playback/sessions/:sessionId/:segmentName",
      access: "authenticated",
      skipCsrf: true,
      handle: async (context) => {
        const principal = context.requirePrincipal();
        const session = await requireOwnedSession(
          principal.userId,
          requireUuid(context.params.sessionId, "sessionId"),
        );
        const runtime = session.runtimeKey
          ? sessionManager.getSession(session.runtimeKey)
          : undefined;
        if (!runtime) {
          throw new OwnApiError(
            "SESSION_NOT_FOUND",
            "The playback session could not be found.",
            404,
          );
        }

        // The HLS playlist references segments by bare filename, so they resolve
        // as siblings of master.m3u8. The name is re-validated here: it must
        // name a file inside the session's working directory and nothing else.
        const segmentName = context.params.segmentName ?? "";
        if (!/^[A-Za-z0-9._-]{1,128}$/.test(segmentName) || segmentName.includes("..")) {
          throw validationError("The segment name is invalid.");
        }

        const absolutePath = path.join(runtime.outputDir, segmentName);
        if (!isPathInsideRoot(path.resolve(runtime.outputDir), absolutePath)) {
          throw new OwnApiError(
            "MEDIA_NOT_FOUND",
            "The requested media could not be found.",
            404,
          );
        }

        await sessions.touch(session.id);
        await serveFile(
          context.response,
          absolutePath,
          context.request.headers.range as string | undefined,
          context.method === "HEAD",
          // Segments are immutable for the life of the session only.
          "private, max-age=60",
        );
      },
    },
  ];
}
