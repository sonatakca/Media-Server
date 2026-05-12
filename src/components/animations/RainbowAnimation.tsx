import { useId } from "react";
import { createPortal } from "react-dom";

type RainbowSide = "top" | "right" | "bottom" | "left" | "top-bottom" | "left-right" | "all";

interface RainbowAnimationProps {
  /**
   * Which side of the screen the rainbow comes from.
   */
  side?: RainbowSide;

  /**
   * Delay before the rainbow starts.
   * Example: 5 means nothing happens for 5 seconds.
   */
  startDelay?: number;

  /**
   * How long the rainbow takes to fade in.
   */
  fadeInDuration?: number;

  /**
   * How long the rainbow stays mostly visible.
   */
  holdDuration?: number;

  /**
   * How long the rainbow takes to fade out.
   */
  fadeOutDuration?: number;

  /**
   * How long the internal moving rainbow texture drifts.
   * Usually this should match the total rainbow duration.
   */
  driftDuration?: number;

  /**
   * How far the rainbow texture moves horizontally.
   * Larger value = stronger sweeping movement.
   */
  driftDistancePercent?: number;

  /**
   * Starting vertical position of the rainbow.
   * More negative = starts higher.
   */
  startYPercent?: number;

  /**
   * Ending vertical position of the rainbow.
   */
  endYPercent?: number;

  /**
   * Starting scale of the rainbow.
   */
  startScale?: number;

  /**
   * Ending scale of the rainbow.
   */
  endScale?: number;

  /**
   * Maximum rainbow opacity.
   */
  maxOpacity?: number;

  /**
   * Angle of the rainbow gradient lines.
   */
  stripeAngleDeg?: number;

  /**
   * Rotation applied to the whole rainbow while animating.
   * Example: 4 means it rotates 4 degrees over the full animation.
   */
  spinAngleDeg?: number;

  /**
   * Additional continuous spin speed for the internal rainbow motion.
   * Example: 0 = no spin, 0.4 = subtle, 1.2 = obvious.
   */
  spinSpeedDegPerSecond?: number;

  /**
   * Blur amount of the rainbow light.
   */
  blurPx?: number;

  /**
   * Width of the rainbow light area.
   */
  width?: string;

  /**
   * Height of the rainbow light area.
   */
  height?: string;

  /**
   * Starting horizontal stretch of the rainbow light.
   * Lower value = narrower at the beginning.
   */
  startStretchX?: number;

  /**
   * Ending horizontal stretch of the rainbow light.
   * Higher value = wider near the end.
   */
  endStretchX?: number;

  /**
   * Top position of the rainbow container.
   */
  top?: string;

  /**
   * Glow fade-in duration.
   */
  glowFadeInDuration?: number;

  /**
   * Glow visible/hold duration.
   */
  glowHoldDuration?: number;

  /**
   * Glow fade-out duration.
   */
  glowFadeOutDuration?: number;

  /**
   * Maximum glow opacity.
   */
  glowMaxOpacity?: number;

  /**
   * Horizontal position of the glow.
   */
  glowLeft?: string;

  /**
   * Vertical position of the glow.
   */
  glowTop?: string;

  /**
   * Width of the glow.
   */
  glowWidth?: string;

  /**
   * Height of the glow.
   */
  glowHeight?: string;

  /**
   * Blur amount of the glow.
   */
  glowBlurPx?: number;

  /**
   * Z-index of the animation layer.
   */
  zIndex?: number;
}

export function RainbowAnimation({
  side = "top",
  startDelay = 5,

  fadeInDuration = 2.2,
  holdDuration = 9,
  fadeOutDuration = 3,

  driftDuration,
  driftDistancePercent = 100,

  startYPercent = -48,
  endYPercent = -36,
  startScale = 0.94,
  endScale = 1.08,
  maxOpacity = 0.96,

  stripeAngleDeg = 110,
  spinAngleDeg = 0,
  spinSpeedDegPerSecond = 0,

  blurPx = 34,
  width = "max(100vw, 70rem)",
  height = "min(54rem, 78vh)",
  startStretchX = 0.72,
  endStretchX = 1,
  top = "0",

  glowFadeInDuration = 1.8,
  glowHoldDuration = 8,
  glowFadeOutDuration = 2.8,
  glowMaxOpacity = 1,
  glowLeft = "50%",
  glowTop = "18%",
  glowWidth = "min(54rem, 96vw)",
  glowHeight = "min(22rem, 42vh)",
  glowBlurPx = 38,

  zIndex = 9998,
}: RainbowAnimationProps) {
  if (typeof document === "undefined") {
    return null;
  }

  const totalDuration = fadeInDuration + holdDuration + fadeOutDuration;
  const actualDriftDuration = driftDuration ?? totalDuration;

  const fadeInEndPercent = (fadeInDuration / totalDuration) * 100;
  const holdEndPercent = ((fadeInDuration + holdDuration) / totalDuration) * 100;

  const glowTotalDuration =
    glowFadeInDuration + glowHoldDuration + glowFadeOutDuration;

  const glowFadeInEndPercent = (glowFadeInDuration / glowTotalDuration) * 100;
  const glowHoldEndPercent =
    ((glowFadeInDuration + glowHoldDuration) / glowTotalDuration) * 100;

  const totalSpinAngle = spinAngleDeg + spinSpeedDegPerSecond * totalDuration;

  const sideConfigs: Record<RainbowSide, { rotations: number[] }> = {
    top: { rotations: [0] },
    right: { rotations: [90] },
    bottom: { rotations: [180] },
    left: { rotations: [-90] },
    "top-bottom": { rotations: [0, 180] },
    "left-right": { rotations: [-90, 90] },
    all: { rotations: [0, 90, 180, -90] },
  };

  const animationId = useId().replace(/:/g, "");
  const layerClass = `devtools-rainbow-layer-${animationId}`;
  const rainbowClass = `devtools-rainbow-${animationId}`;
  const maskClass = `devtools-rainbow__mask-${animationId}`;
  const lightsClass = `devtools-rainbow__lights-${animationId}`;
  const motionClass = `devtools-rainbow__motion-${animationId}`;
  const glowClass = `devtools-rainbow-glow-${animationId}`;
  const layerStartKeyframes = `devtoolsRainbowLayerStart-${animationId}`;
  const enterKeyframes = `devtoolsRainbowEnter-${animationId}`;
  const stretchKeyframes = `devtoolsRainbowStretch-${animationId}`;
  const driftKeyframes = `devtoolsRainbowDrift-${animationId}`;
  const glowKeyframes = `devtoolsRainbowGlow-${animationId}`;

  return createPortal(
    <>
      <style>{`
        .${layerClass} {
          position: fixed;
          left: 50%;
          top: 50%;
          width: var(--layer-width, 100vw);
          height: var(--layer-height, 100vh);
          pointer-events: none;
          overflow: hidden;
          opacity: 0;
          visibility: hidden;
          contain: layout paint;
          /* Translate centers it perfectly before applying the rotation */
          transform: translate(-50%, -50%) rotate(var(--rainbow-side-rotation, 0deg));
          transform-origin: center;
          animation: ${layerStartKeyframes} 0s linear ${startDelay}s forwards;
        }

        @keyframes ${layerStartKeyframes} {
          to {
            opacity: 1;
            visibility: visible;
          }
        }

        .${rainbowClass} {
          position: absolute;
          left: 50%;
          top: ${top};
          width: ${width};
          height: ${height};
          transform: translateX(-50%) translateY(${startYPercent}%) scale(${startScale}) rotate(0deg);
          opacity: 0;
          will-change: transform, opacity;
          animation: ${enterKeyframes} ${totalDuration}s linear ${startDelay}s forwards;
        }

        .${maskClass} {
          position: absolute;
          inset: 0;
          overflow: hidden;
          transform: scaleX(${startStretchX});
          transform-origin: 50% 28%;
          will-change: transform;
          animation: ${stretchKeyframes} ${totalDuration}s linear ${startDelay}s forwards;
          mask-image: radial-gradient(ellipse at 50% 26%, black 18%, rgba(0, 0, 0, 0.86) 32%, transparent 72%);
          -webkit-mask-image: radial-gradient(ellipse at 50% 26%, black 18%, rgba(0, 0, 0, 0.86) 32%, transparent 72%);
        }

        .${lightsClass} {
          position: absolute;
          inset: -2.5rem;
          overflow: hidden;
          filter: blur(${blurPx}px);
          opacity: 0.92;
          will-change: transform, filter, opacity;
          background-image:
            repeating-linear-gradient(
              ${stripeAngleDeg}deg,
              rgba(0, 0, 0, 0.98) 0%,
              rgba(0, 0, 0, 0.98) 7%,
              transparent 10%,
              transparent 13%,
              rgba(0, 0, 0, 0.98) 19%
            ),
            repeating-linear-gradient(
              ${stripeAngleDeg}deg,
              rgba(20, 220, 190, 0.95) 10%,
              rgba(50, 130, 255, 0.95) 15%,
              rgba(145, 80, 255, 0.95) 20%,
              rgba(255, 70, 185, 0.95) 25%,
              rgba(255, 175, 55, 0.95) 30%
            );
          background-size: 120% 120%, 220% 220%;
          background-position: 50% 50%, 50% 50%;
        }

        .${motionClass} {
          position: absolute;
          inset: 0;
          width: 300%;
          mix-blend-mode: screen;
          background-image:
            repeating-linear-gradient(
              ${stripeAngleDeg}deg,
              rgba(0, 0, 0, 0.96) 0%,
              rgba(0, 0, 0, 0.96) 7%,
              transparent 10%,
              transparent 12%,
              rgba(0, 0, 0, 0.96) 19%
            ),
            repeating-linear-gradient(
              ${stripeAngleDeg}deg,
              rgba(20, 220, 190, 0.9) 10%,
              rgba(50, 130, 255, 0.9) 15%,
              rgba(145, 80, 255, 0.9) 20%,
              rgba(255, 70, 185, 0.9) 25%,
              rgba(255, 175, 55, 0.9) 30%
            );
          background-size: 100% 100%, 190% 190%;
          background-position: 50% 50%, 50% 50%;
          will-change: transform, background-position;
          animation: ${driftKeyframes} ${actualDriftDuration}s linear ${startDelay}s forwards;
        }

        .${glowClass} {
          position: absolute;
          left: ${glowLeft};
          top: ${glowTop};
          width: ${glowWidth};
          height: ${glowHeight};
          border-radius: 9999px;
          opacity: 0;
          transform: translate(-50%, -50%) scale(0.82);
          background:
            radial-gradient(circle at 34% 42%, rgba(20, 220, 190, 0.34), transparent 35%),
            radial-gradient(circle at 52% 35%, rgba(80, 150, 255, 0.36), transparent 36%),
            radial-gradient(circle at 68% 40%, rgba(190, 85, 255, 0.34), transparent 35%),
            radial-gradient(circle at 82% 48%, rgba(255, 165, 55, 0.28), transparent 38%);
          filter: blur(${glowBlurPx}px);
          will-change: transform, opacity;
          animation: ${glowKeyframes} ${glowTotalDuration}s linear ${startDelay}s forwards;
        }

        @keyframes ${enterKeyframes} {
          0% {
            opacity: 0;
            transform: translateX(-50%) translateY(${startYPercent}%) scale(${startScale}) rotate(0deg);
          }

          ${fadeInEndPercent * 0.35}% {
            opacity: ${maxOpacity * 0.34};
            transform: translateX(-50%) translateY(${startYPercent * 0.98 + endYPercent * 0.02}%) scale(${startScale + (endScale - startScale) * 0.05}) rotate(${totalSpinAngle * 0.08}deg);
          }

          ${fadeInEndPercent}% {
            opacity: ${maxOpacity};
            transform: translateX(-50%) translateY(${startYPercent * 0.9 + endYPercent * 0.1}%) scale(${startScale + (endScale - startScale) * 0.16}) rotate(${totalSpinAngle * 0.2}deg);
          }

          ${fadeInEndPercent + (holdEndPercent - fadeInEndPercent) * 0.28}% {
            opacity: ${maxOpacity};
            transform: translateX(-50%) translateY(${startYPercent * 0.68 + endYPercent * 0.32}%) scale(${startScale + (endScale - startScale) * 0.42}) rotate(${totalSpinAngle * 0.42}deg);
          }

          ${fadeInEndPercent + (holdEndPercent - fadeInEndPercent) * 0.68}% {
            opacity: ${maxOpacity * 0.94};
            transform: translateX(-50%) translateY(${startYPercent * 0.28 + endYPercent * 0.72}%) scale(${startScale + (endScale - startScale) * 0.78}) rotate(${totalSpinAngle * 0.68}deg);
          }

          ${holdEndPercent}% {
            opacity: ${maxOpacity * 0.82};
            transform: translateX(-50%) translateY(${endYPercent}%) scale(${endScale}) rotate(${totalSpinAngle * 0.84}deg);
          }

          100% {
            opacity: 0;
            transform: translateX(-50%) translateY(${endYPercent}%) scale(${endScale * 1.015}) rotate(${totalSpinAngle}deg);
          }
        }

        @keyframes ${stretchKeyframes} {
          0% {
            transform: scaleX(${startStretchX});
          }

          ${fadeInEndPercent * 0.5}% {
            transform: scaleX(${startStretchX + (endStretchX - startStretchX) * 0.16});
          }

          ${fadeInEndPercent}% {
            transform: scaleX(${startStretchX + (endStretchX - startStretchX) * 0.32});
          }

          ${fadeInEndPercent + (holdEndPercent - fadeInEndPercent) * 0.35}% {
            transform: scaleX(${startStretchX + (endStretchX - startStretchX) * 0.62});
          }

          ${fadeInEndPercent + (holdEndPercent - fadeInEndPercent) * 0.75}% {
            transform: scaleX(${startStretchX + (endStretchX - startStretchX) * 0.9});
          }

          100% {
            transform: scaleX(${endStretchX});
          }
        }

        @keyframes ${driftKeyframes} {
          0% {
            transform: translateX(-34%) rotate(0deg);
            background-position: 0% 50%, 0% 50%;
          }

          100% {
            transform: translateX(0%) rotate(${spinSpeedDegPerSecond * actualDriftDuration}deg);
            background-position: ${driftDistancePercent}% 50%, ${driftDistancePercent}% 50%;
          }
        }

        @keyframes ${glowKeyframes} {
          0% {
            opacity: 0;
            transform: translate(-50%, -50%) scale(0.76);
          }

          ${glowFadeInEndPercent * 0.45}% {
            opacity: ${glowMaxOpacity * 0.36};
            transform: translate(-50%, -50%) scale(0.86);
          }

          ${glowFadeInEndPercent}% {
            opacity: ${glowMaxOpacity};
            transform: translate(-50%, -50%) scale(0.96);
          }

          ${glowFadeInEndPercent + (glowHoldEndPercent - glowFadeInEndPercent) * 0.45}% {
            opacity: ${glowMaxOpacity * 0.86};
            transform: translate(-50%, -50%) scale(1.04);
          }

          ${glowHoldEndPercent}% {
            opacity: ${glowMaxOpacity * 0.64};
            transform: translate(-50%, -50%) scale(1.12);
          }

          100% {
            opacity: 0;
            transform: translate(-50%, -50%) scale(1.2);
          }
        }

        @media (prefers-reduced-motion: reduce) {
          .${layerClass},
          .${rainbowClass},
          .${maskClass},
          .${motionClass},
          .${glowClass} {
            animation-duration: 0.01ms !important;
            animation-iteration-count: 1 !important;
          }
        }
      `}</style>

      {sideConfigs[side].rotations.map((rotation) => {
        const isVertical = rotation === 90 || rotation === -90;

        return (
          <div
            key={rotation}
            className={layerClass}
            style={{
              zIndex,
              "--rainbow-side-rotation": `${rotation}deg`,
              // Swap vw and vh if the container is rotated vertically
              "--layer-width": isVertical ? "100vh" : "100vw",
              "--layer-height": isVertical ? "100vw" : "100vh",
            } as React.CSSProperties}
            aria-hidden="true"
          >
            <div className={rainbowClass}>
              <div className={maskClass}>
                <div className={lightsClass}>
                  <div className={motionClass} />
                </div>
              </div>
            </div>

            <div className={glowClass} />
          </div>
        );
      })}
    </>,
    document.body,
  );
}