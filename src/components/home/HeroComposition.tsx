import { useEffect, useMemo, useRef, useState } from "react";
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
import {
  DEFAULT_LOGO_SHADOW,
  measureLogoShadow,
  type LogoShadow,
  type SampleRegion,
} from "../../lib/logoShadow";
import { getHeroImageCandidates } from "../hero/heroModel";
import {
  QUEUE_TITLE_BOX,
  TITLE_SCALE,
  queueTitleTransform,
  stageness,
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

/** The logo's shadow in a miniature, as it appears on screen. */
const QUEUE_SHADOW_BLUR_PX = 5;
const QUEUE_SHADOW_DROP_PX = 2;

/** A small copy of the artwork, enough to measure the brightness behind a logo. */
export function sampleUrl(url: string): string {
  try {
    const parsed = new URL(url, window.location.href);
    if (parsed.searchParams.has("maxWidth"))
      parsed.searchParams.set("maxWidth", "160");
    return parsed.toString();
  } catch {
    return url;
  }
}

const QUEUE_LOGO_REGION: SampleRegion = {
  left: QUEUE_TITLE_BOX.left,
  top: 1 - QUEUE_TITLE_BOX.bottom - QUEUE_TITLE_BOX.height,
  width: QUEUE_TITLE_BOX.width,
  height: QUEUE_TITLE_BOX.height,
};

/** The shadow a logo needs against the part of the artwork behind it. */
function useLogoShadow(
  logoUrl: string,
  artworkUrl: string | undefined,
  region: SampleRegion,
) {
  const [shadow, setShadow] = useState<LogoShadow>(DEFAULT_LOGO_SHADOW);
  const { left, top, width, height } = region;
  useEffect(() => {
    if (!logoUrl || !artworkUrl) return undefined;
    let cancelled = false;
    void measureLogoShadow(logoUrl, sampleUrl(artworkUrl), {
      left,
      top,
      width,
      height,
    }).then((next) => {
      if (!cancelled) setShadow(next);
    });
    return () => {
      cancelled = true;
    };
  }, [artworkUrl, logoUrl, left, top, width, height]);
  return shadow;
}

/**
 * The halo a logo on stage stands on: its own shape, blurred, dark behind a
 * light logo and light behind a dark one, as strong as the artwork behind it
 * needs. Over a dark picture it is little more than the resting drop shadow;
 * over a white sky it is what keeps a white logo there at all. Blur is in
 * the title box's own px, which the resting title shows at 0.6×.
 */
function stageLogoFilter(shadow: LogoShadow, presence: number): string {
  const base = "drop-shadow(0 6px 30px rgba(0,0,0,0.55))";
  const s = shadow.strength * presence;
  if (s <= 0.01) return base;
  const rgb = shadow.tone === "dark" ? "0,0,0" : "255,255,255";
  return `drop-shadow(0 0 3px rgba(${rgb},${(0.55 * s).toFixed(3)})) drop-shadow(0 0 22px rgba(${rgb},${(0.6 * s).toFixed(3)})) ${base}`;
}

interface HeroCompositionProps {
  item: MediaItem;
  stage: StageSize;
  /** Where the title sits in the frame; the copy overlay reads the same. */
  titleBox: HeroLayout["title"];
  /**
   * The tallest a logo may be drawn at full size. Every logo takes the title
   * box's width and grows upward as its own proportions ask; only a logo
   * close to square, which would rise into the menu when the overview opens,
   * is held to this.
   */
  logoMaxHeight: number;
  motion: CompositionMotion;
  /** The scale a slot holds a composition at; corners round in step with it. */
  slotScale: number;
  zIndex: number;
  /** The one on stage speaks to assistive technology; miniatures do not. */
  isStage: boolean;
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
  logoMaxHeight,
  motion: m,
  slotScale,
  zIndex,
  isStage,
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
  // The scrim is for the menu, and a miniature has none: it shows the
  // artwork clean, and the shade grows in with the frame.
  const scrimOpacity = useTransform(
    m.scale,
    [slotScale, Math.max(slotScale + 0.01, 0.6)],
    [0, 1],
  );
  const titleOpacity = useTransform(m.trailer, [0, 1], [1, 0.92]);

  // In a slot the logo is drawn large at the miniature's bottom-left so it
  // reads at that size; on stage it is at its own place and size. Between
  // the two it follows the frame's scale, so a lift carries it smoothly.
  const queueMove = useMemo(
    () => queueTitleTransform(stage, titleBox),
    [stage, titleBox],
  );
  const toStage = useTransform(m.scale, (scale) => stageness(scale, slotScale));
  const titleX = useTransform(toStage, (p) => queueMove.x * (1 - p));
  const titleY = useTransform([toStage, m.titleY], (values: number[]) => {
    const [p = 1, rise = 0] = values;
    return queueMove.y * (1 - p) + rise * p;
  });
  const titleScale = useTransform(
    [toStage, m.titleScale],
    (values: number[]) => {
      const [p = 1, scale = TITLE_SCALE.rest] = values;
      return queueMove.scale + (scale - queueMove.scale) * p;
    },
  );
  // A silhouette of the logo under it, dark or light against the artwork,
  // for as long as the frame is a miniature.
  const shadow = useLogoShadow(logoUrl, artwork?.url, QUEUE_LOGO_REGION);
  const silhouetteOpacity = useTransform(toStage, (p) => 1 - p);
  // On stage the logo is measured where it rests, at its resting size.
  const stageLogoRegion = useMemo<SampleRegion>(() => {
    const height = titleBox.height * TITLE_SCALE.rest;
    return {
      left: titleBox.left / stage.width,
      top: 1 - (titleBox.bottom + height) / stage.height,
      width: (titleBox.width * TITLE_SCALE.rest) / stage.width,
      height: height / stage.height,
    };
  }, [stage, titleBox]);
  const stageShadow = useLogoShadow(logoUrl, artwork?.url, stageLogoRegion);
  const logoFilter = useTransform(toStage, (p) =>
    stageLogoFilter(stageShadow, p),
  );
  const onScreen = slotScale * queueMove.scale;

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

      {/* Legibility for the menu, in a band as tall as the hand-over at
          the foot, so the artwork between them is not dimmed. */}
      <motion.div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          opacity: scrimOpacity,
          background:
            "linear-gradient(180deg, rgba(5,6,7,0.6) 0%, rgba(5,6,7,0.24) 5.5%, rgba(5,6,7,0) 12%)",
        }}
      />

      <motion.div
        className="absolute flex items-end"
        style={{
          left: titleBox.left,
          bottom: titleBox.bottom,
          width: titleBox.width,
          height: titleBox.height,
          x: titleX,
          y: titleY,
          scale: titleScale,
          opacity: titleOpacity,
          transformOrigin: "0% 100%",
        }}
      >
        {logoUrl ? (
          <div
            className={`relative w-full transition-opacity duration-500 ${
              isLogoLoaded ? "opacity-100" : "opacity-0"
            }`}
          >
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0"
              style={{ opacity: shadow.strength }}
            >
              <motion.img
                src={logoUrl}
                alt=""
                draggable={false}
                className="h-full w-full select-none object-contain object-left-bottom"
                style={{
                  opacity: silhouetteOpacity,
                  y: QUEUE_SHADOW_DROP_PX / onScreen,
                  filter: `brightness(0)${shadow.tone === "light" ? " invert(1)" : ""} blur(${QUEUE_SHADOW_BLUR_PX / onScreen}px)`,
                }}
              />
            </div>
            <motion.img
              src={logoUrl}
              alt={isStage ? title : ""}
              draggable={false}
              onLoad={() => setIsLogoLoaded(true)}
              className="relative block h-auto w-full select-none object-contain object-left-bottom"
              style={{ maxHeight: logoMaxHeight, filter: logoFilter }}
            />
          </div>
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
