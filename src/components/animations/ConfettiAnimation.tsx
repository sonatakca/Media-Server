import { useMemo } from "react";
import { createPortal } from "react-dom";
import type { CSSProperties } from "react";

interface ConfettiAnimationProps {
  startDelay?: number;
  pieceCount?: number;
  minDuration?: number;
  maxDuration?: number;
  minSizeRem?: number;
  maxSizeRem?: number;
  minDriftRem?: number;
  maxDriftRem?: number;
  delaySpread?: number;
  zIndex?: number;
}

export function ConfettiAnimation({
  startDelay = 5,
  pieceCount = 90,
  minDuration = 2.4,
  maxDuration = 4.6,
  minSizeRem = 0.32,
  maxSizeRem = 0.7,
  minDriftRem = -5,
  maxDriftRem = 5,
  delaySpread = 0.9,
  zIndex = 9999,
}: ConfettiAnimationProps) {
  const confettiPieces = useMemo(
    () =>
      Array.from({ length: pieceCount }, (_, index) => ({
        id: index,
        left: `${Math.random() * 100}%`,
        delay: `${startDelay + Math.random() * delaySpread}s`,
        duration: `${minDuration + Math.random() * (maxDuration - minDuration)}s`,
        rotate: `${Math.random() * 360}deg`,
        size: `${minSizeRem + Math.random() * (maxSizeRem - minSizeRem)}rem`,
        drift: `${minDriftRem + Math.random() * (maxDriftRem - minDriftRem)}rem`,
      })),
    [
      delaySpread,
      maxDriftRem,
      maxDuration,
      maxSizeRem,
      minDriftRem,
      minDuration,
      minSizeRem,
      pieceCount,
      startDelay,
    ],
  );

  if (typeof document === "undefined") {
    return null;
  }

  return createPortal(
    <>
      <style>{`
        .devtools-confetti-layer {
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
          animation: devtoolsConfettiLayerStart 0s linear ${startDelay}s forwards;
        }

        @keyframes devtoolsConfettiLayerStart {
          to {
            opacity: 1;
            visibility: visible;
          }
        }

        .devtools-confetti {
          position: absolute;
          top: -2rem;
          border-radius: 0.16rem;
          opacity: 0;
          background: var(--accent);
          box-shadow: 0 0 16px color-mix(in srgb, var(--accent) 55%, transparent);
          animation-name: devtoolsConfettiFall;
          animation-timing-function: cubic-bezier(0.16, 1, 0.3, 1);
          animation-fill-mode: forwards;
        }

        .devtools-confetti:nth-child(5n + 1) {
          background: #ff5c7a;
        }

        .devtools-confetti:nth-child(5n + 2) {
          background: #ffd166;
        }

        .devtools-confetti:nth-child(5n + 3) {
          background: #5cffb1;
        }

        .devtools-confetti:nth-child(5n + 4) {
          background: #5cc8ff;
        }

        .devtools-confetti:nth-child(5n + 5) {
          background: #c77dff;
        }

        @keyframes devtoolsConfettiFall {
          0% {
            opacity: 0;
            transform: translate3d(0, -3rem, 0) rotate(0deg) scale(0.8);
          }

          10% {
            opacity: 1;
          }

          100% {
            opacity: 0;
            transform: translate3d(var(--drift), 110vh, 0) rotate(760deg) scale(1);
          }
        }

        @media (prefers-reduced-motion: reduce) {
          .devtools-confetti-layer,
          .devtools-confetti {
            animation-duration: 0.01ms !important;
            animation-iteration-count: 1 !important;
          }
        }
      `}</style>

      <div
        className="devtools-confetti-layer"
        style={{ zIndex }}
        aria-hidden="true"
      >
        {confettiPieces.map((piece) => (
          <span
            key={piece.id}
            className="devtools-confetti"
            style={
              {
                left: piece.left,
                width: piece.size,
                height: `calc(${piece.size} * 1.7)`,
                animationDelay: piece.delay,
                animationDuration: piece.duration,
                rotate: piece.rotate,
                "--drift": piece.drift,
              } as CSSProperties
            }
          />
        ))}
      </div>
    </>,
    document.body,
  );
}
