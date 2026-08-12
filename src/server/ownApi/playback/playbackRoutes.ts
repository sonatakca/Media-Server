import path from "node:path";
import { OwnApiError } from "../ownApiHandler";
import { serveFile } from "../api/fileDelivery";
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
import type { RenditionService } from "../../renditionService";
import type { MediaQualityManifest } from "../../../renditions/contracts";

export const PLAYBACK_SESSION_ROUTE_BASE = "/ownAPI/v1/playback/sessions";

/**
 * Where pre-encoded renditions are served from. Inside the API namespace, so a
 * rendition is behind the same session cookie as everything else rather than on
 * a second, separately-authorized surface.
 */
export const PLAYBACK_RENDITION_ROUTE_BASE = "/ownAPI/v1/playback/renditions";

export interface PlaybackRoutesOptions {
  catalogue: CatalogueRepository;
  sessions: PlaybackSessionStore;
  sessionManager: PlaybackSessionManager;
  mediaRoot: string;
  /**
   * Absent when no rendition root is configured, in which case playback still
   * works — it just has nothing but the original and live transcodes to offer.
   */
  renditions?: RenditionService;
}

/** Native plan modes; the browser never sees an upstream transcode reason again. */
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
  if (plan.video.action === "transcode")
    codes.push("VIDEO_CODEC_NOT_SUPPORTED");
  if (plan.audio.action === "transcode")
    codes.push("AUDIO_CODEC_NOT_SUPPORTED");
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

export function createPlaybackRoutes({
  catalogue,
  sessions,
  sessionManager,
  mediaRoot,
  renditions,
}: PlaybackRoutesOptions): RouteDefinition[] {
  const resolvedMediaRoot = path.resolve(mediaRoot);

  /**
   * Resolves an item to a playable file for one specific user.
   *
   * Authorization happens here rather than in a shared resolver, so possession
   * of an item or file id can never be traded for bytes from a library the
   * caller cannot see.
   */
  async function resolvePlayable(
    userId: string,
    itemId: string,
    mediaFileId?: string,
  ) {
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
      maxHeight: optionalBodyInteger(body, "maxHeight", {
        min: 144,
        max: 4_320,
      }),
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

  /**
   * The pre-encoded ladder for this file, if the offline processor produced one.
   *
   * The original is offered alongside the renditions only when it can be played
   * as-is: a plan that already needs ffmpeg has no direct file to hand over, and
   * listing one would send the browser to bytes it cannot decode.
   */
  async function buildQualityManifest(
    file: Awaited<ReturnType<typeof catalogue.getFileById>>,
    analysis: ReturnType<typeof buildAnalysisFromInventory>,
    plan: PlaybackPlan,
    capabilities: ClientCapabilities,
    deliveryUrl: string,
  ): Promise<MediaQualityManifest | undefined> {
    if (!renditions || !file) return undefined;

    const absolutePath = path.resolve(
      resolvedMediaRoot,
      ...file.relativePath.split("/"),
    );
    const video = analysis.videoStreams[0];

    try {
      return await renditions.createManifest(
        {
          mediaId: file.id,
          filePath: absolutePath,
          size: Number(file.sizeBytes),
          mtimeMs: Number(file.mtimeMs),
        },
        video && !plan.requiresFfmpeg
          ? {
              width: video.width,
              height: video.height,
              codec: video.codecName,
              container:
                analysis.container.extension ?? analysis.container.formatName,
              fileSize: Number(file.sizeBytes),
              playableUrl: deliveryUrl,
            }
          : undefined,
        {
          hevc: capabilities.video.hevc?.supported === true,
          h264: capabilities.video.h264?.supported !== false,
        },
      );
    } catch {
      // A missing or unreadable registry must not stop playback; it only means
      // there is nothing pre-encoded to offer.
      return undefined;
    }
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

        const qualityManifest = await buildQualityManifest(
          file,
          analysis,
          plan,
          request.clientCapabilities,
          deliveryUrl,
        );

        sendData(context.response, context.requestId, {
          sessionId,
          itemId: request.itemId,
          mediaFileId: file.id,
          plan: planDto(plan),
          delivery: { type: deliveryType, url: deliveryUrl },
          ...(qualityManifest ? { qualityManifest } : {}),
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

    ...(renditions
      ? [
          {
            /**
             * A pre-encoded rendition.
             *
             * The token is the media file id, so it is re-authorized here on
             * every request rather than trusted because it was minted earlier:
             * an authenticated user must still be able to see the item the file
             * belongs to. The rendition service then owns the byte serving,
             * including the walk back to the validated output root.
             */
            method: "GET",
            path: "/playback/renditions/:token/:fileId",
            access: "authenticated",
            // Served to a <video> element, which cannot attach a CSRF header.
            skipCsrf: true,
            handle: async (context) => {
              const principal = context.requirePrincipal();
              const mediaFileId = requireUuid(context.params.token, "token");

              const file = await catalogue.getFileById(mediaFileId);
              if (
                !file ||
                file.missingSince !== null ||
                !(await catalogue.canUserAccessItem(
                  principal.userId,
                  file.itemId,
                ))
              ) {
                throw new OwnApiError(
                  "MEDIA_NOT_FOUND",
                  "The requested media could not be found.",
                  404,
                );
              }

              const resolved = await renditions.resolveFile(
                mediaFileId,
                context.params.fileId ?? "",
              );
              if (!resolved) {
                throw new OwnApiError(
                  "RENDITION_NOT_FOUND",
                  "The requested rendition is unavailable.",
                  404,
                );
              }

              await serveFile(
                context.response,
                resolved.absolutePath,
                context.request.headers.range as string | undefined,
                context.method === "HEAD",
                // Addressed by content fingerprint, so it never changes; still
                // private, because it is behind a session.
                "private, max-age=31536000, immutable",
              );
            },
          } satisfies RouteDefinition,
        ]
      : []),

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
        if (
          !/^[A-Za-z0-9._-]{1,128}$/.test(segmentName) ||
          segmentName.includes("..")
        ) {
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
