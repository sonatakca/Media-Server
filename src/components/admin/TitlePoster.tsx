import { useState } from "react";
import type { TitleArtwork } from "../../lib/libraryAdminApi";
import { getLogoImageUrl, getPrimaryImageUrl } from "../../lib/mediaApi";
import {
  DEFAULT_LOGO_SHADOW,
  getLogoLayoutStyle,
  getLogoShadowBackdropStyle,
  getLogoShadowFilter,
} from "../../lib/logoLayout";

/**
 * A title's poster as the library cards draw it: the cover, and the logo in
 * the place and with the shadow it was adjusted to. With no adjustment the
 * logo sits at the foot of the cover, as it does on a card.
 */
export function TitlePoster({
  itemId,
  title,
  artwork,
  className,
}: {
  itemId: string;
  title: string;
  artwork: TitleArtwork;
  className: string;
}) {
  const [coverFailed, setCoverFailed] = useState(false);
  const [logoFailed, setLogoFailed] = useState(false);
  const showCover = artwork.coverTag !== null && !coverFailed;
  const layout = artwork.logoLayout;
  const shadowFilter = getLogoShadowFilter(
    layout?.shadow ?? DEFAULT_LOGO_SHADOW,
  );
  const logo =
    showCover && artwork.logoTag && !logoFailed ? (
      <img
        src={getLogoImageUrl(itemId, artwork.logoTag, 320)}
        alt=""
        style={shadowFilter ? { filter: shadowFilter } : undefined}
        onError={() => setLogoFailed(true)}
        className={
          layout
            ? "relative z-10 block h-auto w-full object-contain"
            : "pointer-events-none absolute inset-x-0 bottom-[6%] z-10 mx-auto h-auto max-h-[22%] w-auto max-w-[80%] object-contain"
        }
      />
    ) : null;
  const backdrop = layout ? getLogoShadowBackdropStyle(layout.shadow) : null;

  return (
    <div
      className={`relative shrink-0 overflow-hidden bg-white/[0.04] ${className}`}
      aria-hidden="true"
      data-title={title}
    >
      {showCover ? (
        <img
          src={getPrimaryImageUrl(itemId, artwork.coverTag ?? undefined, 240)}
          alt=""
          loading="lazy"
          onError={() => setCoverFailed(true)}
          className="h-full w-full object-cover"
        />
      ) : null}
      {logo && layout ? (
        <div
          style={getLogoLayoutStyle(layout)}
          className="pointer-events-none absolute z-10"
        >
          {backdrop ? (
            <span
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
