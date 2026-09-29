import { useEffect, useRef, useState } from "react";
import {
  motion,
  motionValue,
  useTransform,
  type MotionValue,
} from "framer-motion";
import { useLanguage } from "../../i18n/LanguageContext";
import { getLogoImageUrl } from "../../lib/mediaApi";
import {
  getItemDisplayMetadata,
  getItemLogoUrl,
} from "../../lib/itemMetadataPreferences";
import { useCroppedTransparentImage } from "../../hooks/useCroppedTransparentImage";
import type { MediaItem } from "../../lib/types";
import { getHeroImageCandidates } from "../hero/heroModel";
import {
  TITLE_SCALE,
  type HeroLayout,
  type Placement,
  type StageSize,
} from "./homeHeroModel";

/**
 * One featured title, drawn once at the stage's full size.
 *
 * On stage it is at scale 1; in the queue it is this same element scaled down
 * into its slot. Nothing about a title is redrawn when it moves between the
 * two — the transform is the whole transition, which is why the miniature and
 * the stage can never disagree about how the title looks.
 */

/** Every value that places or shades a composition, owned by the choreography. */
export interface CompositionMotion {
  x: MotionValue<number>;
  y: MotionValue<number>;
  scale: MotionValue<number>;
  /** Black over the whole frame, 0–1: receding or leaving. */
  dim: MotionValue<number>;
  /** The title's own scale inside the frame: resting, open, or trailer. */
  titleScale: MotionValue<number>;
  /** The title's rise, in px, while the overview is open under it. */
  titleY: MotionValue<number>;
  /** 0–1: the trailer over the artwork. */
  trailer: MotionValue<number>;
}

export function createCompositionMotion(
  placement: Placement,
  dim = 0,
): CompositionMotion {
  return {
    x: motionValue(placement.x),
    y: motionValue(placement.y),
    scale: motionValue(placement.scale),
    dim: motionValue(dim),
    titleScale: motionValue<number>(TITLE_SCALE.rest),
    titleY: motionValue(0),
    trailer: motionValue(0),
  };
}

/** The corner radius a miniature shows on screen, whatever its scale. */
const QUEUE_RADIUS_PX = 12;

interface HeroCompositionProps {
  item: MediaItem;
  stage: StageSize;
  /** Where the title sits in the frame; the copy overlay reads the same. */
  titleBox: HeroLayout["title"];
  motion: CompositionMotion;
  /** The scale a slot holds a composition at; corners round in step with it. */
  slotScale: number;
  zIndex: number;
  /** The one on stage speaks to assistive technology; miniatures do not. */
  isStage: boolean;
  clipPath?: MotionValue<string>;
  trailerUrl?: string | null;
  isTrailerPlaying?: boolean;
  isTrailerMuted?: boolean;
  onTrailerEnded?: () => void;
  onArtworkReady?: () => void;
}

export function HeroComposition({
  item,
  stage,
  titleBox,
  motion: m,
  slotScale,
  zIndex,
  isStage,
  clipPath,
  trailerUrl,
  isTrailerPlaying = false,
  isTrailerMuted = true,
  onTrailerEnded,
  onArtworkReady,
}: HeroCompositionProps) {
  const { language } = useLanguage();
  const [failed, setFailed] = useState<string[]>([]);
  const [isArtworkLoaded, setIsArtworkLoaded] = useState(false);
  const [isLogoLoaded, setIsLogoLoaded] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  const artwork = getHeroImageCandidates(item).find(
    (candidate) => !failed.includes(candidate.url),
  );
  const fallbackLogoUrl = item.ImageTags?.Logo
    ? getLogoImageUrl(item.Id, item.ImageTags.Logo, 1100)
    : "";
  const logoUrl = useCroppedTransparentImage(
    getItemLogoUrl(item, language, fallbackLogoUrl),
  );
  const title = getItemDisplayMetadata(item, language).title ?? item.Name;

  const radius = useTransform(m.scale, (scale) => {
    if (scale >= 0.999) return 0;
    const towardsSlot = Math.min(1, Math.max(0, (1 - scale) / (1 - slotScale)));
    return (QUEUE_RADIUS_PX * towardsSlot) / scale;
  });
  // A hairline that stays one pixel on screen at any scale, gone by the time
  // the frame fills the stage.
  const frameShadow = useTransform(m.scale, (scale) => {
    const presence = Math.min(1, Math.max(0, (0.55 - scale) / 0.35));
    if (presence <= 0) return "none";
    return `inset 0 0 0 ${1 / scale}px rgba(255,255,255,${0.18 * presence})`;
  });
  // The scrim is for copy, and a miniature has none: it shows the artwork
  // clean, and the shade grows in with the frame.
  const scrimOpacity = useTransform(
    m.scale,
    [slotScale, Math.max(slotScale + 0.01, 0.6)],
    [0, 1],
  );
  const titleOpacity = useTransform(m.trailer, [0, 1], [1, 0.92]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (isTrailerPlaying) {
      video.muted = isTrailerMuted;
      void video.play().catch(() => onTrailerEnded?.());
    } else {
      video.pause();
    }
  }, [isTrailerMuted, isTrailerPlaying, onTrailerEnded]);

  return (
    <motion.div
      className="absolute left-0 top-0 overflow-hidden bg-[#050607]"
      style={{
        width: stage.width,
        height: stage.height,
        x: m.x,
        y: m.y,
        scale: m.scale,
        transformOrigin: "0 0",
        borderRadius: radius,
        boxShadow: frameShadow,
        clipPath,
        zIndex,
        willChange: "transform",
      }}
      aria-hidden={isStage ? undefined : true}
    >
      {artwork ? (
        <img
          src={artwork.url}
          alt=""
          draggable={false}
          loading="eager"
          decoding="async"
          fetchPriority={isStage ? "high" : "auto"}
          className={`absolute inset-0 h-full w-full select-none object-cover transition-opacity duration-500 ${
            isArtworkLoaded ? "opacity-100" : "opacity-0"
          } ${artwork.type === "primary" ? "blur-2xl" : ""}`}
          onLoad={() => {
            setIsArtworkLoaded(true);
            onArtworkReady?.();
          }}
          onError={() => setFailed((current) => [...current, artwork.url])}
        />
      ) : null}

      {trailerUrl ? (
        <motion.video
          ref={videoRef}
          src={trailerUrl}
          muted={isTrailerMuted}
          playsInline
          preload="auto"
          className="absolute inset-0 h-full w-full object-cover"
          style={{ opacity: m.trailer }}
          onEnded={onTrailerEnded}
          onError={onTrailerEnded}
        />
      ) : null}

      {/* Legibility for the title and the copy under it, bottom-left. */}
      <motion.div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          opacity: scrimOpacity,
          background:
            "radial-gradient(95% 80% at 0% 100%, rgba(5,6,7,0.9) 0%, rgba(5,6,7,0.6) 38%, rgba(5,6,7,0) 70%), linear-gradient(0deg, rgba(5,6,7,0.9) 0%, rgba(5,6,7,0) 30%), linear-gradient(180deg, rgba(5,6,7,0.6) 0%, rgba(5,6,7,0.24) 11%, rgba(5,6,7,0) 24%)",
        }}
      />

      <motion.div
        className="absolute flex items-end"
        style={{
          left: titleBox.left,
          bottom: titleBox.bottom,
          width: titleBox.width,
          height: titleBox.height,
          scale: m.titleScale,
          y: m.titleY,
          opacity: titleOpacity,
          transformOrigin: "0% 100%",
        }}
      >
        {logoUrl ? (
          <img
            src={logoUrl}
            alt={isStage ? title : ""}
            draggable={false}
            onLoad={() => setIsLogoLoaded(true)}
            className={`block max-h-full max-w-full select-none object-contain object-left-bottom drop-shadow-[0_6px_30px_rgba(0,0,0,0.55)] transition-opacity duration-500 ${
              isLogoLoaded ? "opacity-100" : "opacity-0"
            }`}
          />
        ) : (
          <h2
            className="text-cinematic-title font-black uppercase leading-[0.9] text-white"
            style={{ fontSize: stage.height * 0.085 }}
          >
            {title}
          </h2>
        )}
      </motion.div>

      <motion.div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[#050607]"
        style={{ opacity: m.dim }}
      />
    </motion.div>
  );
}
