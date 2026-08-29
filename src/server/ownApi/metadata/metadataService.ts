import type { ImageRepository } from "../images/imageRepository";
import type { ImageStorage } from "../images/imageStorage";
import { selectBestMatch, type MatchCandidate } from "./matcher";
import type { MetadataRepository, MetadataTarget } from "./metadataRepository";
import {
  TmdbError,
  type TmdbClient,
  type TmdbTitleDetails,
} from "./tmdbClient";

export interface MetadataServiceOptions {
  metadata: MetadataRepository;
  images: ImageRepository;
  imageStorage: ImageStorage;
  tmdb: TmdbClient;
  /**
   * Confidence below which a match is recorded but not applied. Defaults to
   * applying medium and above, because a personal library's folder names are
   * usually deliberate.
   */
  minimumConfidence?: "high" | "medium";
}

export interface IdentifyResult {
  itemId: string;
  status: "matched" | "ambiguous" | "not-found" | "skipped" | "failed";
  providerId?: string;
  confidence?: "high" | "medium" | "low";
}

const POSTER_SIZE = "w780";
const BACKDROP_SIZE = "w1280";
const LOGO_SIZE = "w500";
const STILL_SIZE = "w300";

/**
 * Identification and metadata application.
 *
 * Two rules shape everything here: a locked field is never overwritten, and a
 * low-confidence match is recorded rather than applied. Metadata that silently
 * renames the wrong film is worse than metadata that is missing.
 */
export function createMetadataService({
  metadata,
  images,
  imageStorage,
  tmdb,
  minimumConfidence = "medium",
}: MetadataServiceOptions) {
  async function storeArtwork(
    target: MetadataTarget,
    imageType: "cover" | "backdrop" | "logo" | "thumb",
    imagePath: string,
    size: string,
    imageIndex = 0,
  ): Promise<void> {
    const existing = await images.findByItemAndType(
      target.id,
      imageType,
      imageIndex,
    );
    if (existing?.isLocked) return;

    try {
      const sourceUrl = tmdb.buildImageUrl(imagePath, size);
      const stored =
        target.titleRoot && imageType !== "thumb"
          ? await imageStorage.fetchAndStoreTitleArtwork(
              sourceUrl,
              target.titleRoot,
              imageType,
            )
          : await imageStorage.fetchAndStore(sourceUrl);

      // Identical bytes mean nothing changed; skip the write so an ETag stays
      // stable and clients keep their cached copy.
      if (existing?.contentHash === stored.contentHash) return;

      await images.upsert({
        itemId: target.id,
        imageType,
        imageIndex,
        contentHash: stored.contentHash,
        contentType: stored.contentType,
        width: null,
        height: null,
        sizeBytes: stored.sizeBytes,
        storageKey: stored.storageKey,
        source: "tmdb",
        sourceUrl: null,
      });
    } catch {
      // Artwork is best-effort: a title with metadata and no poster is far more
      // useful than a failed refresh.
    }
  }

  async function applyTitle(
    target: MetadataTarget,
    details: TmdbTitleDetails,
  ): Promise<void> {
    await metadata.applyTitleMetadata(target.id, {
      title: details.title,
      ...(details.originalTitle
        ? { originalTitle: details.originalTitle }
        : {}),
      ...(details.overview ? { overview: details.overview } : {}),
      ...(details.tagline ? { tagline: details.tagline } : {}),
      ...(details.releaseDate ? { premiereDate: details.releaseDate } : {}),
      ...(details.endDate ? { endDate: details.endDate } : {}),
      ...(details.releaseDate
        ? { productionYear: Number(details.releaseDate.slice(0, 4)) }
        : {}),
      ...(details.officialRating
        ? { officialRating: details.officialRating }
        : {}),
      ...(details.communityRating === undefined
        ? {}
        : { communityRating: details.communityRating }),
      ...(details.runtimeMs === undefined
        ? {}
        : { runtimeMs: details.runtimeMs }),
      providerIds: {
        tmdb: details.providerId,
        ...(details.imdbId ? { imdb: details.imdbId } : {}),
      },
      metadataState: "matched",
    });

    await metadata.replaceGenres(target.id, details.genres);
    await metadata.replacePeople(target.id, details.people);

    if (details.posterPath) {
      await storeArtwork(target, "cover", details.posterPath, POSTER_SIZE);
    }
    if (details.logoPath) {
      await storeArtwork(target, "logo", details.logoPath, LOGO_SIZE);
    }
    for (const backdropPath of details.backdropPaths.slice(0, 1)) {
      await storeArtwork(target, "backdrop", backdropPath, BACKDROP_SIZE, 0);
    }
  }

  async function applySeriesChildren(
    target: MetadataTarget,
    providerId: string,
  ): Promise<void> {
    const episodes = await metadata.listEpisodesForSeries(target.id);
    const seasonNumbers = [
      ...new Set(
        episodes
          .map((episode) => episode.parentIndexNumber)
          .filter((season): season is number => season !== null),
      ),
    ];

    for (const seasonNumber of seasonNumbers) {
      let providerEpisodes;
      try {
        providerEpisodes = await tmdb.getSeasonEpisodes(
          providerId,
          seasonNumber,
        );
      } catch (error) {
        // A season the provider does not know about is not a failure of the
        // series refresh.
        if (error instanceof TmdbError && error.kind === "not-found") continue;
        throw error;
      }

      for (const providerEpisode of providerEpisodes) {
        const local = episodes.find(
          (episode) =>
            episode.parentIndexNumber === providerEpisode.seasonNumber &&
            episode.indexNumber === providerEpisode.episodeNumber,
        );
        if (!local) continue;

        await metadata.applyTitleMetadata(local.id, {
          ...(providerEpisode.title ? { title: providerEpisode.title } : {}),
          ...(providerEpisode.overview
            ? { overview: providerEpisode.overview }
            : {}),
          ...(providerEpisode.airDate
            ? { premiereDate: providerEpisode.airDate }
            : {}),
          ...(providerEpisode.communityRating === undefined
            ? {}
            : { communityRating: providerEpisode.communityRating }),
          metadataState: "matched",
        });

        if (providerEpisode.stillPath) {
          await storeArtwork(
            local,
            "thumb",
            providerEpisode.stillPath,
            STILL_SIZE,
          );
        }
      }
    }
  }

  async function identify(target: MetadataTarget): Promise<IdentifyResult> {
    if (target.lockedFields.includes("identity")) {
      // Move it out of the pending set as well, otherwise the batch scan would
      // keep selecting the same locked item and never terminate.
      await metadata.applyTitleMetadata(target.id, { metadataState: "locked" });
      return { itemId: target.id, status: "skipped" };
    }

    const isSeries = target.kind === "series";
    const existingProviderId = target.providerIds.tmdb;

    try {
      let providerId = existingProviderId;
      let confidence: IdentifyResult["confidence"];

      if (!providerId) {
        const candidates: MatchCandidate[] = isSeries
          ? await tmdb.searchSeries(
              target.title,
              target.productionYear ?? undefined,
            )
          : await tmdb.searchMovies(
              target.title,
              target.productionYear ?? undefined,
            );

        const match = selectBestMatch(
          {
            title: target.title,
            ...(target.productionYear === null
              ? {}
              : { year: target.productionYear }),
          },
          candidates,
        );

        if (!match) {
          await metadata.applyTitleMetadata(target.id, {
            metadataState: "unmatched",
          });
          return { itemId: target.id, status: "not-found" };
        }

        confidence = match.confidence;
        const meetsThreshold =
          match.confidence === "high" ||
          (minimumConfidence === "medium" && match.confidence === "medium");

        if (!meetsThreshold) {
          // Recorded so an administrator can confirm it, but nothing is written
          // over the scanned title.
          await metadata.applyTitleMetadata(target.id, {
            metadataState: "unmatched",
          });
          return {
            itemId: target.id,
            status: "ambiguous",
            providerId: match.candidate.providerId,
            confidence: match.confidence,
          };
        }

        providerId = match.candidate.providerId;
      }

      const details = isSeries
        ? await tmdb.getSeries(providerId)
        : await tmdb.getMovie(providerId);

      await applyTitle(target, details);
      if (isSeries) {
        await applySeriesChildren(target, providerId);
      }

      return {
        itemId: target.id,
        status: "matched",
        providerId,
        ...(confidence ? { confidence } : {}),
      };
    } catch (error) {
      if (error instanceof TmdbError && error.kind === "not-found") {
        await metadata.applyTitleMetadata(target.id, {
          metadataState: "unmatched",
        });
        return { itemId: target.id, status: "not-found" };
      }
      // A rate limit or an outage must stay retryable, so the item is left
      // pending rather than marked failed.
      if (error instanceof TmdbError) throw error;

      await metadata.markFailed(target.id);
      return { itemId: target.id, status: "failed" };
    }
  }

  return {
    identify,

    /** Refreshes one item on demand, ignoring its current metadata state. */
    refreshItem: async (itemId: string): Promise<IdentifyResult> => {
      const target = await metadata.getTarget(itemId);
      if (!target) {
        return { itemId, status: "not-found" };
      }
      return identify(target);
    },

    /** Processes a batch of never-identified items. */
    processPending: async (
      limit: number,
      libraryId?: string,
    ): Promise<IdentifyResult[]> => {
      const targets = await metadata.listPendingItems(limit, libraryId);
      const results: IdentifyResult[] = [];
      for (const target of targets) {
        results.push(await identify(target));
      }
      return results;
    },
  };
}

export type MetadataService = ReturnType<typeof createMetadataService>;
