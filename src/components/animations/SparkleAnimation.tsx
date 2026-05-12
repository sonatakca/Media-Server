import { useMemo } from "react";
import { createPortal } from "react-dom";

interface SparkleAnimationProps {
  startDelay?: number;
  sparkleDuration?: number;
  sparkleCount?: number;
  minScale?: number;
  maxScale?: number;
  topMin?: number;
  topMax?: number;
  leftMin?: number;
  leftMax?: number;
  delaySpread?: number;
  zIndex?: number;
}

export function SparkleAnimation({
  startDelay = 5,
  sparkleDuration = 1.9,
  sparkleCount = 36,
  minScale = 0.55,
  maxScale = 1.8,
  topMin = 10,
  topMax = 65,
  leftMin = 8,
  leftMax = 92,
  delaySpread = 1.4,
  zIndex = 9999,
}: SparkleAnimationProps) {
  const sparkles = useMemo(
    () =>
      Array.from({ length: sparkleCount }, (_, index) => ({
        id: index,
        left: `${leftMin + Math.random() * (leftMax - leftMin)}%`,
        top: `${topMin + Math.random() * (topMax - topMin)}%`,
        delay: `${startDelay + 0.15 + Math.random() * delaySpread}s`,
        scale: minScale + Math.random() * (maxScale - minScale),
      })),
    [
      delaySpread,
      leftMax,
      leftMin,
      maxScale,
      minScale,
      sparkleCount,
      startDelay,
      topMax,
      topMin,
    ],
  );

  if (typeof document === "undefined") {
    return null;
  }

  return createPortal(
    <>
      <style>{`
        .devtools-sparkle-layer {
          position: fixed;
          inset: 0;
          width: 100vw;
          height: 100vh;
          height: 100dvh;
          pointer-events: none;
          overflow: hidden;
          opacity: 0;
          visibility: hidden;
          contain: layout paint;
          animation: devtoolsSparkleLayerStart 0s linear ${startDelay}s forwards;
        }

        @keyframes devtoolsSparkleLayerStart {
          to {
            opacity: 1;
            visibility: visible;
          }
        }

        .devtools-sparkle {
          position: absolute;
          width: 0.5rem;
          height: 0.5rem;
          opacity: 0;
          animation: devtoolsSparklePop ${sparkleDuration}s cubic-bezier(0.16, 1, 0.3, 1) forwards;
        }

        .devtools-sparkle::before,
        .devtools-sparkle::after {
          content: "";
          position: absolute;
          left: 50%;
          top: 50%;
          border-radius: 9999px;
          background: white;
          box-shadow:
            0 0 10px white,
            0 0 22px var(--accent);
          transform: translate(-50%, -50%);
        }

        .devtools-sparkle::before {
          width: 0.12rem;
          height: 1rem;
        }

        .devtools-sparkle::after {
          width: 1rem;
          height: 0.12rem;
        }

        @keyframes devtoolsSparklePop {
          0% {
            opacity: 0;
            transform: scale(0) rotate(0deg);
          }

          25% {
            opacity: 1;
            transform: scale(1.5) rotate(45deg);
          }

          72% {
            opacity: 0.9;
            transform: scale(1) rotate(120deg);
          }

          100% {
            opacity: 0;
            transform: scale(0) rotate(180deg);
          }
        }

        @media (prefers-reduced-motion: reduce) {
          .devtools-sparkle-layer,
          .devtools-sparkle {
            animation-duration: 0.01ms !important;
            animation-iteration-count: 1 !important;
          }
        }
      `}</style>

      <div
        className="devtools-sparkle-layer"
        style={{ zIndex }}
        aria-hidden="true"
      >
        {sparkles.map((sparkle) => (
          <span
            key={sparkle.id}
            className="devtools-sparkle"
            style={{
              left: sparkle.left,
              top: sparkle.top,
              animationDelay: sparkle.delay,
              transform: `scale(${sparkle.scale})`,
            }}
          />
        ))}
      </div>
    </>,
    document.body,
  );
}