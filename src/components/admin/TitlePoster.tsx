import { useState } from "react";
import type { TitleArtwork } from "../../lib/libraryAdminApi";
import { getLogoImageUrl, getPrimaryImageUrl } from "../../lib/mediaApi";
import {
  DEFAULT_LOGO_SHADOW,
  LOGO_SHADOW_REFERENCE_WIDTH,
  getLogoLayoutStyle,
  getLogoShadowBackdropStyle,
  getLogoShadowFilter,
} from "../../lib/logoLayout";

/**
 * A title's poster as the library cards draw it: the cover, and the logo in
 * the place, at the width and with the shadow it was adjusted to. With no
 * adjustment the logo sits at the foot of the cover, as it does on a card.
 *
 * `width` is the drawn width in pixels. The shadow is scaled to it: the card's
 * shadow reaches tens of pixels, which on a 48-pixel thumbnail would be a dark
 * smudge over the whole cover rather than a lift under the logo.
 */
export function TitlePoster({
  itemId,
  title,
  artwork,
  width,
  className = "",
}: {
  itemId: string;
  title: string;
  artwork: Pick<TitleArtwork, "coverTag" | "logoTag" | "logoLayout">;
  width: number;
  className?: string;
}) {
  const [failedCover, setFailedCover] = useState<string | null>(null);
  const [failedLogo, setFailedLogo] = useState<string | null>(null);
  // A new tag is a new image, and gets its own chance to load.
  const showCover =
    artwork.coverTag !== null && failedCover !== artwork.coverTag;
  const showLogo =
    showCover && artwork.logoTag !== null && failedLogo !== artwork.logoTag;
  const layout = artwork.logoLayout;
  const scale = width / LOGO_SHADOW_REFERENCE_WIDTH;
  const shadowFilter = getLogoShadowFilter(
    layout?.shadow ?? DEFAULT_LOGO_SHADOW,
    scale,
  );
  const backdrop = layout
    ? getLogoShadowBackdropStyle(layout.shadow, scale)
    : undefined;
  // Poster and logo requests sized for a sharp image at this width.
  const request = Math.max(80, Math.round(width * 2.5));

  const logo = showLogo ? (
    <img
      src={getLogoImageUrl(itemId, artwork.logoTag ?? undefined, request)}
      alt=""
      style={shadowFilter ? { filter: shadowFilter } : undefined}
      onError={() => setFailedLogo(artwork.logoTag)}
      className={
        layout
          ? "relative z-10 block h-auto w-full object-contain"
          : "pointer-events-none absolute inset-x-0 bottom-[6%] z-10 mx-auto h-auto max-h-[22%] w-auto max-w-[80%] object-contain"
      }
    />
  ) : null;

  return (
    <div
      className={`relative shrink-0 overflow-hidden bg-white/[0.04] ${className}`}
      style={{ width, height: Math.round(width * 1.5) }}
      aria-hidden="true"
      data-title={title}
    >
      {showCover ? (
        <img
          src={getPrimaryImageUrl(
            itemId,
            artwork.coverTag ?? undefined,
            request,
          )}
          alt=""
          loading="lazy"
          onError={() => setFailedCover(artwork.coverTag)}
          className="h-full w-full object-cover"
        />
      ) : null}
      {logo && layout ? (
        <div
          data-logo-layout="true"
          style={getLogoLayoutStyle(layout)}
          className="pointer-events-none absolute z-10"
        >
          {backdrop ? (
            <span
              data-logo-shadow-backdrop="true"
              style={backdrop}
              className="absolute inset-[6%] rounded-[45%]"
            />
          ) : null}
          {logo}
        </div>
      ) : (
        logo
      )}
    </div>
  );
}
