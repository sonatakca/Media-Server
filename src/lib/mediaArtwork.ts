import type { Language } from "../i18n/translations";
import { getEpisodeDisplayMetadata } from "./episodeMetadataPreferences";
import { getItemLogoUrlById } from "./itemMetadataPreferences";
import {
  getLogoImageUrl,
  getPrimaryImageUrl,
  getThumbImageUrl,
} from "./mediaApi";
import type { MediaItem } from "./types";

export type MediaArtworkShape = "poster" | "still";

export interface MediaArtwork {
  /** "still" for episodes, which have a 16:9 frame rather than a poster. */
  shape: MediaArtworkShape;
  imageUrl: string;
  logoUrl: string;
}

interface MediaArtworkOptions {
  posterWidth?: number;
  stillWidth?: number;
  logoWidth?: number;
}

/**
 * Picks the artwork and logo for an item the way a media card does.
 *
 * An episode's own image is its still, which the metadata pass stores as a
 * thumb — episodes never have a poster of their own — and its logo belongs to
 * the series it came from. Getting either wrong leaves a blank tile, so this
 * is shared rather than reimplemented per surface.
 */
export function getMediaArtwork(
  item: MediaItem,
  language: Language,
  {
    posterWidth = 400,
    stillWidth = 600,
    logoWidth = 520,
  }: MediaArtworkOptions = {},
): MediaArtwork {
  const isEpisode = item.Type === "Episode";
  const shape: MediaArtworkShape = isEpisode ? "still" : "poster";
  const ownImageWidth = isEpisode ? stillWidth : posterWidth;

  const episodeMetadata = isEpisode
    ? getEpisodeDisplayMetadata(item, language)
    : null;

  const ownImageUrl =
    episodeMetadata?.thumbnailUrl ??
    (item.ImageTags?.Primary
      ? getPrimaryImageUrl(item.Id, item.ImageTags.Primary, ownImageWidth)
      : item.ImageTags?.Thumb
        ? getThumbImageUrl(item.Id, item.ImageTags.Thumb, ownImageWidth)
        : "");

  // An episode with no still of its own is better represented by its series
  // poster than by an empty box.
  const seriesPosterUrl =
    isEpisode && item.SeriesId && item.SeriesPrimaryImageTag
      ? getPrimaryImageUrl(
          item.SeriesId,
          item.SeriesPrimaryImageTag,
          posterWidth,
        )
      : "";

  const fallbackLogoUrl = item.ImageTags?.Logo
    ? getLogoImageUrl(item.Id, item.ImageTags.Logo, logoWidth)
    : item.ParentLogoItemId && item.ParentLogoImageTag
      ? getLogoImageUrl(
          item.ParentLogoItemId,
          item.ParentLogoImageTag,
          logoWidth,
        )
      : "";

  const logoUrl = getItemLogoUrlById(
    isEpisode ? (item.SeriesId ?? item.ParentLogoItemId) : item.Id,
    language,
    fallbackLogoUrl,
  );

  return {
    shape,
    imageUrl: ownImageUrl || seriesPosterUrl,
    logoUrl,
  };
}
