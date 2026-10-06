import path from "node:path";
import { OwnApiError } from "../ownApiHandler";
import { sendData } from "../api/envelope";
import type { RouteDefinition } from "../api/router";
import { requireUuid, validationError } from "../api/validation";
import type { CatalogueRepository } from "../catalogue/catalogueRepository";
import type { UserRepository } from "../users/userRepository";
import type { RenditionService } from "../../renditionService";
import {
  extractSubtitleAsWebVtt,
  resolveTextSubtitleInput,
} from "../playback/subtitleDelivery";

export interface DownloadRoutesOptions {
  catalogue: Pick<
    CatalogueRepository,
    "canUserAccessItem" | "getPrimaryFile" | "listStreams"
  >;
  users: Pick<UserRepository, "findById">;
  renditions?: Pick<RenditionService, "createManifest">;
  mediaRoot: string;
  ffmpegPath?: string;
}

/**
 * What a device needs to keep a title for offline viewing.
 *
 * Only a title with an adaptive package can be downloaded: the package is a
 * set of plain files a browser can store and play back later through hls.js
 * with nothing on the server involved, which no original file or live
 * transcode is. The device then fetches the package through the same
 * authorised URLs playback uses; this route is where the viewer's download
 * permission is checked, and where the choice of rungs is offered.
 *
 * Text subtitles are served here too, by item rather than by playback
 * session: a stored copy is played with no session, so it needs its own
 * copy of each track, fetched once while the download runs.
 */
export function createDownloadRoutes({
  catalogue,
  users,
  renditions,
  mediaRoot,
  ffmpegPath,
}: DownloadRoutesOptions): RouteDefinition[] {
  const resolvedMediaRoot = path.resolve(mediaRoot);

  /** The account may download, and may see this item. */
  async function requireDownloadableItem(userId: string, itemId: string) {
    // An administrator can grant themselves the permission, so it is
    // theirs already; read from the stored account, not the session, so a
    // demotion takes it away at once.
    const user = await users.findById(userId);
    if (!user || (!user.isAdministrator && !user.allowDownloads)) {
      throw new OwnApiError(
        "DOWNLOADS_NOT_ALLOWED",
        "Downloads are not enabled for this account.",
        403,
      );
    }
    if (!(await catalogue.canUserAccessItem(userId, itemId))) {
      throw new OwnApiError(
        "MEDIA_NOT_FOUND",
        "The requested media could not be found.",
        404,
      );
    }
  }

  return [
    {
      method: "GET",
      path: "/downloads/items/:itemId/plan",
      access: "authenticated",
      handle: async (context) => {
        const principal = context.requirePrincipal();
        const itemId = requireUuid(context.params.itemId, "itemId");
        await requireDownloadableItem(principal.userId, itemId);

        const file = await catalogue.getPrimaryFile(itemId);
        const manifest =
          file && renditions
            ? await renditions
                .createManifest(
                  {
                    mediaId: file.id,
                    filePath: path.resolve(
                      resolvedMediaRoot,
                      ...file.relativePath.split("/"),
                    ),
                    size: Number(file.sizeBytes),
                    mtimeMs: Number(file.mtimeMs),
                  },
                  undefined,
                  {
                    hevc: context.url.searchParams.get("hevc") === "1",
                    h264: true,
                  },
                )
                .catch(() => undefined)
            : undefined;
        const adaptive = manifest?.adaptive;
        if (!adaptive || adaptive.qualities.length === 0) {
          throw new OwnApiError(
            "DOWNLOAD_UNAVAILABLE",
            "This title has no processed package to download yet.",
            409,
          );
        }

        sendData(context.response, context.requestId, {
          itemId,
          masterUrl: adaptive.playbackUrl,
          segmentTargetSeconds: adaptive.segmentTargetSeconds,
          qualities: adaptive.qualities.map((quality) => ({
            height: quality.height,
            width: quality.width,
            bitrate: quality.bitrate,
            videoCodec: quality.videoCodec,
            hdr: quality.hdr,
          })),
          audioTracks: adaptive.audioTracks.map((track) => ({
            sourceStreamIndex: track.sourceStreamIndex,
            label: track.label,
            ...(track.language ? { language: track.language } : {}),
            isDefault: track.isDefault,
          })),
          subtitles: (file ? await catalogue.listStreams(file.id) : [])
            .filter((stream) => stream.kind === "subtitle")
            .filter((stream) => stream.isTextSubtitle)
            .map((stream) => ({ streamIndex: stream.streamIndex })),
        });
      },
    },
    {
      method: "GET",
      path: "/downloads/items/:itemId/subtitles/:subtitleAsset",
      access: "authenticated",
      // Fetched by the download, which sends no CSRF header for a read.
      skipCsrf: true,
      handle: async (context) => {
        const principal = context.requirePrincipal();
        const itemId = requireUuid(context.params.itemId, "itemId");
        await requireDownloadableItem(principal.userId, itemId);
        const assetMatch = /^(\d{1,6})\.vtt$/.exec(
          context.params.subtitleAsset ?? "",
        );
        if (!assetMatch?.[1]) {
          throw validationError("The subtitle stream is invalid.");
        }

        const file = await catalogue.getPrimaryFile(itemId);
        const input =
          file && file.missingSince === null
            ? resolveTextSubtitleInput(
                file,
                await catalogue.listStreams(file.id),
                Number(assetMatch[1]),
                resolvedMediaRoot,
              )
            : null;
        if (!input) {
          throw new OwnApiError(
            "SUBTITLE_NOT_FOUND",
            "The requested subtitle could not be found.",
            404,
          );
        }

        let webVtt: Buffer;
        try {
          webVtt = await extractSubtitleAsWebVtt(
            input.inputPath,
            input.inputStreamIndex,
            ffmpegPath,
          );
        } catch {
          throw new OwnApiError(
            "SUBTITLE_UNAVAILABLE",
            "The requested subtitle could not be converted.",
            422,
          );
        }

        context.response.statusCode = 200;
        context.response.setHeader("Content-Type", "text/vtt; charset=utf-8");
        context.response.setHeader("Content-Length", String(webVtt.length));
        context.response.setHeader("Cache-Control", "private, max-age=300");
        context.response.setHeader("X-Content-Type-Options", "nosniff");
        context.response.end(context.method === "HEAD" ? undefined : webVtt);
      },
    },
  ];
}
