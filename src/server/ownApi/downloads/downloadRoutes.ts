import path from "node:path";
import { OwnApiError } from "../ownApiHandler";
import { sendData } from "../api/envelope";
import type { RouteDefinition } from "../api/router";
import { requireUuid } from "../api/validation";
import type { CatalogueRepository } from "../catalogue/catalogueRepository";
import type { UserRepository } from "../users/userRepository";
import type { RenditionService } from "../../renditionService";

export interface DownloadRoutesOptions {
  catalogue: Pick<CatalogueRepository, "canUserAccessItem" | "getPrimaryFile">;
  users: Pick<UserRepository, "findById">;
  renditions?: Pick<RenditionService, "createManifest">;
  mediaRoot: string;
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
 */
export function createDownloadRoutes({
  catalogue,
  users,
  renditions,
  mediaRoot,
}: DownloadRoutesOptions): RouteDefinition[] {
  const resolvedMediaRoot = path.resolve(mediaRoot);

  return [
    {
      method: "GET",
      path: "/downloads/items/:itemId/plan",
      access: "authenticated",
      handle: async (context) => {
        const principal = context.requirePrincipal();
        const itemId = requireUuid(context.params.itemId, "itemId");

        // An administrator can grant themselves the permission, so it is
        // theirs already; read from the stored account, not the session, so a
        // demotion takes it away at once.
        const user = await users.findById(principal.userId);
        if (!user || (!user.isAdministrator && !user.allowDownloads)) {
          throw new OwnApiError(
            "DOWNLOADS_NOT_ALLOWED",
            "Downloads are not enabled for this account.",
            403,
          );
        }
        if (!(await catalogue.canUserAccessItem(principal.userId, itemId))) {
          throw new OwnApiError(
            "MEDIA_NOT_FOUND",
            "The requested media could not be found.",
            404,
          );
        }

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
        });
      },
    },
  ];
}
