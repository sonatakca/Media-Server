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
import type { SampleRegion } from "../../lib/logoShadow";
import { getStageImageCandidates } from "../hero/heroModel";
import {
  stageLogoFilter,
  stageLogoReach,
  useLogoShadow,
} from "./logoShadowStyle";
import {
  QUEUE_TITLE_BOX,
  TITLE_SCALE,
  heroForm,
  heroFrameRadius,
  queueTitleTransform,
  stageness,
  tallFootGradient,
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
  titleRest: number = TITLE_SCALE.rest,
): CompositionMotion {
  return {
    x: motionValue(placement.x),
    y: motionValue(placement.y),
    scale: motionValue(placement.scale),
    dim: motionValue(dim),
    titleScale: motionValue<number>(titleRest),
    titleY: motionValue(0),
    trailer: motionValue(0),
  };
}

/** The logo's shadow in a miniature, as it appears on screen. */
const QUEUE_SHADOW_BLUR_PX = 5;
const QUEUE_SHADOW_DROP_PX = 2;

const QUEUE_LOGO_REGION: SampleRegion = {
  left: QUEUE_TITLE_BOX.left,
  top: 1 - QUEUE_TITLE_BOX.bottom - QUEUE_TITLE_BOX.height,
  width: QUEUE_TITLE_BOX.width,
  height: QUEUE_TITLE_BOX.height,
};

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
  slotHeight?: number;
  /** The title's own scale at rest, which its box is measured at. */
  titleRestScale?: number;
  /**
   * The whole frame's opacity, for a miniature stepping aside: on a tall
   * stage the queue makes way for the overview, which opens across it.
   */
  opacity?: MotionValue<number>;
  zIndex: number;
  /** The one on stage speaks to assistive technology; miniatures do not. */
  isStage: boolean;
  trailerUrl?: string | null;
  isTrailerPlaying?: boolean;
  isTrailerMuted?: boolean;
  onTrailerEnded?: () => void;
  onArtworkReady?: () => void;
  /**
   * False while the page holds the hero hidden behind its skeleton: the
   * artwork and logo load but wait to fade in until they can be seen.
   */
  isRevealed?: boolean;
}

export function HeroComposition({
  item,
  stage,
  titleBox,
  logoMaxHeight,
  motion: m,
  slotScale,
  slotHeight,
  titleRestScale = TITLE_SCALE.rest,
  opacity,
  zIndex,
  isStage,
  trailerUrl,
  isTrailerPlaying = false,
  isTrailerMuted = true,
  onTrailerEnded,
  onArtworkReady,
  isRevealed = true,
}: HeroCompositionProps) {
  const { language } = useLanguage();
  const [failed, setFailed] = useState<string[]>([]);
  const [isArtworkLoaded, setIsArtworkLoaded] = useState(false);
  const [isLogoLoaded, setIsLogoLoaded] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  const form = heroForm(stage);
  const artwork = getStageImageCandidates(item, form, stage.width).find(
    (candidate) => !failed.includes(candidate.url),
  );
  /**
   * A poster carries its own lettering, so a miniature shows it as printed
   * and draws no logo; as the frame grows onto the stage the foot fades the
   * printed title away and the logo comes up in its place.
   */
  const isPoster = artwork?.type === "poster";
  const fallbackLogoUrl = item.ImageTags?.Logo
    ? getLogoImageUrl(item.Id, item.ImageTags.Logo, 1100)
    : "";
  const logoUrl = useCroppedTransparentImage(
    getItemLogoUrl(item, language, fallbackLogoUrl),
  );
  const title = getItemDisplayMetadata(item, language).title ?? item.Name;

  const radius = useTransform(m.scale, (scale) =>
    heroFrameRadius(scale, slotScale),
  );
  const clipPath = useTransform(radius, (px) => `inset(0 round ${px}px)`);
  // A hairline that stays one pixel on screen at any scale, gone by the time
  // the frame fills the stage.
  const frameShadow = useTransform(m.scale, (scale) => {
    const presence = Math.min(1, Math.max(0, (0.55 - scale) / 0.35));
    if (presence <= 0) return "none";
    return `inset 0 0 0 ${1 / scale}px rgba(205,211,219,${0.38 * presence})`;
  });
  // A tall poster's copy keeps its legibility veil as it grows onto the stage.
  const footOpacity = useTransform(
    m.scale,
    [slotScale, Math.max(slotScale + 0.01, 0.6)],
    [0, 1],
  );
  const titleOpacity = useTransform(m.trailer, [0, 1], [1, 0.92]);
  const footGradient = useMemo(
    () => tallFootGradient(stage, titleBox, titleRestScale),
    [stage, titleBox, titleRestScale],
  );

  // Crop the wider tablet miniature without changing its travel scale.
  const queueHeight = slotHeight ? slotHeight / slotScale : stage.height;
  const frameHeight = useTransform(
    m.scale,
    (scale) =>
      queueHeight + (stage.height - queueHeight) * stageness(scale, slotScale),
  );

  // In a slot the logo is drawn large at the miniature's bottom-left so it
  // reads at that size; on stage it is at its own place and size. Between
  // the two it follows the frame's scale, so a lift carries it smoothly.
  const queueMove = useMemo(
    () => queueTitleTransform({ ...stage, height: queueHeight }, titleBox),
    [stage, titleBox, queueHeight],
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
  // A black silhouette of the logo under it, as strong as the artwork needs,
  // for as long as the frame is a miniature.
  const shadow = useLogoShadow(logoUrl, artwork?.url, QUEUE_LOGO_REGION);
  const silhouetteOpacity = useTransform(toStage, (p) =>
    isPoster ? 0 : 1 - p,
  );
  // Over a poster the logo arrives late in the lift, once the printed title
  // under it has gone, so the two are never read at once.
  const logoPresence = useTransform(toStage, (p) =>
    isPoster ? Math.min(1, Math.max(0, (p - 0.35) / 0.5)) : 1,
  );
  // On stage the logo is measured where it rests, at its resting size.
  const stageLogoRegion = useMemo<SampleRegion>(() => {
    const height = titleBox.height * titleRestScale;
    return {
      left: titleBox.left / stage.width,
      top: 1 - (titleBox.bottom + height) / stage.height,
      width: (titleBox.width * titleRestScale) / stage.width,
      height: height / stage.height,
    };
  }, [stage, titleBox, titleRestScale]);
  const stageShadow = useLogoShadow(logoUrl, artwork?.url, stageLogoRegion);
  const logoFilter = useTransform(toStage, (p) =>
    stageLogoFilter(stageShadow, p),
  );
  const logoReach = stageLogoReach(stageShadow);
  const onScreen = slotScale * queueMove.scale;
  // Both filters go on frames padded by their reach, never on the images:
  // iOS WebKit can clip a filtered element to its own box (see
  // getLogoShadowFrameStyle). A blur fades out within 1.5× its radius.
  const silhouetteBlur = QUEUE_SHADOW_BLUR_PX / onScreen;
  const silhouetteReach = Math.ceil(1.5 * silhouetteBlur);

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
        height: frameHeight,
        x: m.x,
        y: m.y,
        scale: m.scale,
        transformOrigin: "0 0",
        borderRadius: radius,
        clipPath,
        boxShadow: frameShadow,
        opacity,
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
            isArtworkLoaded && isRevealed ? "opacity-100" : "opacity-0"
          } ${artwork.type === "primary" ? "blur-2xl" : ""}`}
          // A poster cut to a stage shorter than itself keeps its top, where
          // the faces are, and loses its foot, where the lettering is.
          style={isPoster ? { objectPosition: "50% 0%" } : undefined}
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

      {/* On a tall stage the copy fills the lower third, over a poster's own
          lettering: the picture sinks into the room behind it there, eased
          so no line marks where the fall begins. A miniature shows its
          poster whole and gains the fall as it grows. */}
      {form === "tall" ? (
        <motion.div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0"
          style={{ opacity: footOpacity, background: footGradient }}
        />
      ) : null}

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
              isLogoLoaded && isRevealed ? "opacity-100" : "opacity-0"
            }`}
          >
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0"
              style={{ opacity: shadow.strength }}
            >
              <motion.div
                className="absolute"
                style={{
                  inset: -silhouetteReach,
                  padding: silhouetteReach,
                  opacity: silhouetteOpacity,
                  y: QUEUE_SHADOW_DROP_PX / onScreen,
                  filter: `brightness(0) blur(${silhouetteBlur}px)`,
                }}
              >
                <img
                  src={logoUrl}
                  alt=""
                  draggable={false}
                  className="h-full w-full select-none object-contain object-left-bottom"
                />
              </motion.div>
            </div>
            <motion.div
              className="relative"
              style={{
                padding: logoReach,
                margin: -logoReach,
                filter: logoFilter,
                opacity: logoPresence,
              }}
            >
              <img
                src={logoUrl}
                alt={isStage ? title : ""}
                draggable={false}
                onLoad={() => setIsLogoLoaded(true)}
                className="block h-auto w-full select-none object-contain object-left-bottom"
                style={{ maxHeight: logoMaxHeight }}
              />
            </motion.div>
          </div>
        ) : (
          <motion.h2
            className="text-cinematic-title font-black uppercase leading-[0.9] text-white"
            style={{
              fontSize:
                form === "tall"
                  ? Math.min(stage.width * 0.1, 64)
                  : stage.height * 0.085,
              opacity: logoPresence,
            }}
          >
            {title}
          </motion.h2>
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
