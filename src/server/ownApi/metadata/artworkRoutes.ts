import { OwnApiError } from "../ownApiHandler";
import { sendData } from "../api/envelope";
import type { RouteDefinition } from "../api/router";
import { asObjectBody, requireUuid } from "../api/validation";
import type { ImageRepository } from "../images/imageRepository";
import type { ImageStorage } from "../images/imageStorage";
import type { JobQueue } from "../tasks/jobQueue";
import { JOB_TYPES } from "../tasks/jobHandlers";
import type { MetadataRepository, MetadataTarget } from "./metadataRepository";
import {
  TMDB_IMAGE_BASE_URL,
  type TmdbArtworkKind,
  type TmdbClient,
} from "./tmdbClient";

export interface ArtworkRoutesOptions {
  metadata: MetadataRepository;
  images: ImageRepository;
  imageStorage: ImageStorage;
  tmdb: TmdbClient;
  queue: JobQueue;
}

/**
 * How a provider artwork set maps onto a stored image type, and the width the
 * chosen file is fetched at. These match the automatic pass, so an operator's
 * choice is the same size as the one it replaces and a layout cannot shift
 * simply because a human picked the poster.
 */
const ARTWORK_TARGETS: Record<
  TmdbArtworkKind,
  { imageType: string; size: string }
> = {
  poster: { imageType: "primary", size: "w780" },
  backdrop: { imageType: "backdrop", size: "w1280" },
  logo: { imageType: "logo", size: "w500" },
};

/** The preview grid wants many images at once, so it asks for small ones. */
const PREVIEW_SIZE = "w342";

const ARTWORK_KINDS = Object.keys(ARTWORK_TARGETS) as TmdbArtworkKind[];

const APPLICABLE_KINDS = new Set(["movie", "series"]);

function itemNotFound(): OwnApiError {
  return new OwnApiError(
    "ITEM_NOT_FOUND",
    "The requested item could not be found.",
    404,
  );
}

/**
 * TMDB file paths arrive from the provider but are echoed back to us by the
 * browser, so they are re-validated rather than trusted: the shape is a leading
 * slash, one path segment, and a known image extension.
 */
function requireProviderFilePath(value: unknown): string {
  if (typeof value !== "string" || !/^\/[A-Za-z0-9_-]+\.(jpg|png|webp)$/.test(value)) {
    throw new OwnApiError(
      "VALIDATION_FAILED",
      "filePath is not a provider image path.",
      422,
    );
  }
  return value;
}

function requireArtworkKind(value: unknown): TmdbArtworkKind {
  if (typeof value !== "string" || !(value in ARTWORK_TARGETS)) {
    throw new OwnApiError(
      "VALIDATION_FAILED",
      `kind must be one of ${ARTWORK_KINDS.join(", ")}.`,
      422,
    );
  }
  return value as TmdbArtworkKind;
}

const LOGO_PLACEMENTS = ["top", "middle", "bottom"] as const;

export type LogoPlacement = (typeof LOGO_PLACEMENTS)[number];

function requireLogoPlacement(value: unknown): LogoPlacement {
  if (
    typeof value !== "string" ||
    !LOGO_PLACEMENTS.includes(value as LogoPlacement)
  ) {
    throw new OwnApiError(
      "VALIDATION_FAILED",
      `placement must be one of ${LOGO_PLACEMENTS.join(", ")}.`,
      422,
    );
  }
  return value as LogoPlacement;
}

/**
 * A BCP 47 tag, which is all TMDB accepts. Anything else is rejected rather
 * than passed through, so a malformed value cannot reshape the provider query.
 */
function requireLanguageTag(value: string | null): string {
  const language = value?.trim() ?? "";
  if (!/^[a-z]{2}(-[A-Z]{2})?$/.test(language)) {
    throw new OwnApiError(
      "VALIDATION_FAILED",
      "language must be a tag such as tr-TR.",
      422,
    );
  }
  return language;
}

/**
 * The provider id to ask about, and the provider's own media type.
 *
 * A season or an episode has no artwork set of its own in this surface: the
 * automatic pass gives it the series' artwork, and an operator who wants to
 * change it changes the series.
 */
function resolveProviderTarget(target: MetadataTarget): {
  kind: "movie" | "tv";
  providerId: string;
} {
  if (!APPLICABLE_KINDS.has(target.kind)) {
    throw new OwnApiError(
      "ARTWORK_NOT_APPLICABLE",
      "Artwork can only be chosen for a film or a series.",
      422,
    );
  }

  const providerId = target.providerIds.tmdb;
  if (!providerId) {
    throw new OwnApiError(
      "PROVIDER_ID_MISSING",
      "Identify this title against TMDB before choosing artwork.",
      409,
    );
  }

  return { kind: target.kind === "series" ? "tv" : "movie", providerId };
}

export function createArtworkRoutes({
  metadata,
  images,
  imageStorage,
  tmdb,
  queue,
}: ArtworkRoutesOptions): RouteDefinition[] {
  async function requireTarget(itemId: string): Promise<MetadataTarget> {
    const target = await metadata.getTarget(itemId);
    if (!target) throw itemNotFound();
    return target;
  }

  return [
    {
      method: "GET",
      path: "/admin/items/:itemId/artwork",
      access: "admin",
      handle: async (context) => {
        const itemId = requireUuid(context.params.itemId, "itemId");
        const target = await requireTarget(itemId);
        const provider = resolveProviderTarget(target);

        const [candidates, lockedTypes, current] = await Promise.all([
          tmdb.listArtwork(provider.kind, provider.providerId),
          images.listLockedTypes(itemId),
          images.listForItems([itemId]),
        ]);

        sendData(context.response, context.requestId, {
          item: {
            id: target.id,
            title: target.title,
            kind: target.kind,
            providerId: provider.providerId,
          },
          // Which types an operator has taken over, so the page can offer to
          // hand each one back rather than guessing from the artwork alone.
          lockedTypes,
          current,
          candidates: candidates.map((candidate) => ({
            ...candidate,
            imageType: ARTWORK_TARGETS[candidate.kind].imageType,
            previewUrl: `${TMDB_IMAGE_BASE_URL}/${PREVIEW_SIZE}${candidate.filePath}`,
          })),
        });
      },
    },

    {
      method: "POST",
      path: "/admin/items/:itemId/artwork",
      access: "admin",
      handle: async (context) => {
        const itemId = requireUuid(context.params.itemId, "itemId");
        const target = await requireTarget(itemId);
        resolveProviderTarget(target);

        const body = asObjectBody(await context.readJson(2 * 1_024), [
          "kind",
          "filePath",
        ]);
        const kind = requireArtworkKind(body.kind);
        const filePath = requireProviderFilePath(body.filePath);
        const { imageType, size } = ARTWORK_TARGETS[kind];

        const sourceUrl = tmdb.buildImageUrl(filePath, size);
        let stored;
        try {
          stored = await imageStorage.fetchAndStore(sourceUrl);
        } catch {
          // Deliberately not the underlying message: it can carry the request
          // URL, and a v3 credential rides in that query string.
          throw new OwnApiError(
            "ARTWORK_FETCH_FAILED",
            "The chosen artwork could not be downloaded.",
            502,
          );
        }

        const imageId = await images.replaceLocked({
          itemId,
          imageType,
          imageIndex: 0,
          contentHash: stored.contentHash,
          contentType: stored.contentType,
          width: null,
          height: null,
          sizeBytes: stored.sizeBytes,
          storageKey: stored.storageKey,
          source: "tmdb",
          sourceUrl,
        });

        sendData(context.response, context.requestId, {
          imageId,
          imageType,
          isLocked: true,
        });
      },
    },

    {
      method: "DELETE",
      path: "/admin/items/:itemId/artwork/:kind",
      access: "admin",
      handle: async (context) => {
        const itemId = requireUuid(context.params.itemId, "itemId");
        await requireTarget(itemId);
        const kind = requireArtworkKind(context.params.kind);

        // Removing the row rather than only clearing the lock is what hands the
        // type back: the next refresh finds nothing stored and fetches the
        // provider's own choice again.
        const cleared = await images.clear(
          itemId,
          ARTWORK_TARGETS[kind].imageType,
          0,
        );

        // Reverting would otherwise leave the title with no artwork of this
        // kind until something else happened to refresh it, which reads as
        // breakage rather than as a revert.
        const taskId = cleared
          ? await queue.enqueue({
              jobType: JOB_TYPES.metadataRefresh,
              payload: { itemId },
              dedupeKey: `${JOB_TYPES.metadataRefresh}:${itemId}`,
            })
          : null;

        sendData(context.response, context.requestId, {
          imageType: ARTWORK_TARGETS[kind].imageType,
          cleared,
          taskId,
        });
      },
    },

    {
      /**
       * Where the logo is anchored over this title's artwork.
       *
       * Unlike the artwork itself this is not a provider choice, so it needs no
       * TMDB match and applies to any item that has a logo to place.
       */
      method: "PUT",
      path: "/admin/items/:itemId/logo-placement",
      access: "admin",
      handle: async (context) => {
        const itemId = requireUuid(context.params.itemId, "itemId");

        const body = asObjectBody(await context.readJson(1_024), ["placement"]);
        const placement = requireLogoPlacement(body.placement);

        if (!(await metadata.setLogoPlacement(itemId, placement))) {
          throw itemNotFound();
        }

        sendData(context.response, context.requestId, { placement });
      },
    },

    {
      /**
       * The title as the provider writes it in one language, for an operator to
       * compare before overwriting what is stored. Nothing is saved here — the
       * existing metadata PATCH does that, so a preview can never be mistaken
       * for a commit.
       */
      method: "GET",
      path: "/admin/items/:itemId/metadata/preview",
      access: "admin",
      handle: async (context) => {
        const itemId = requireUuid(context.params.itemId, "itemId");
        const target = await requireTarget(itemId);
        const provider = resolveProviderTarget(target);
        const language = requireLanguageTag(
          context.url.searchParams.get("language"),
        );

        const details =
          provider.kind === "tv"
            ? await tmdb.getSeries(provider.providerId, language)
            : await tmdb.getMovie(provider.providerId, language);

        sendData(context.response, context.requestId, {
          language,
          title: details.title,
          originalTitle: details.originalTitle ?? null,
          overview: details.overview ?? null,
          tagline: details.tagline ?? null,
        });
      },
    },
  ];
}
