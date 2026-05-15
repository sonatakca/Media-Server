import { useMemo } from "react";
import { createPortal } from "react-dom";

interface AuroraSparkleAnimationProps {
  startDelay?: number;
  auroraDuration?: number;
  glowDuration?: number;
  sparkleDuration?: number;
  sparkleCount?: number;
  sparkleMinScale?: number;
  sparkleMaxScale?: number;
  sparkleSpreadTopMin?: number;
  sparkleSpreadTopMax?: number;
  sparkleSpreadLeftMin?: number;
  sparkleSpreadLeftMax?: number;
  zIndex?: number;
}

export function AuroraSparkleAnimation({
  startDelay = 5,
  auroraDuration = 4.6,
  glowDuration = 4.2,
  sparkleDuration = 1.9,
  sparkleCount = 36,
  sparkleMinScale = 0.55,
  sparkleMaxScale = 1.8,
  sparkleSpreadTopMin = 10,
  sparkleSpreadTopMax = 65,
  sparkleSpreadLeftMin = 8,
  sparkleSpreadLeftMax = 92,
  zIndex = 9998,
}: AuroraSparkleAnimationProps) {
  const sparkles = useMemo(
    () =>
      Array.from({ length: sparkleCount }, (_, index) => ({
        id: index,
        left: `${sparkleSpreadLeftMin + Math.random() * (sparkleSpreadLeftMax - sparkleSpreadLeftMin)}%`,
        top: `${sparkleSpreadTopMin + Math.random() * (sparkleSpreadTopMax - sparkleSpreadTopMin)}%`,
        delay: `${startDelay + 0.15 + Math.random() * 1.4}s`,
        scale:
          sparkleMinScale + Math.random() * (sparkleMaxScale - sparkleMinScale),
      })),
    [
      sparkleCount,
      sparkleMaxScale,
      sparkleMinScale,
      sparkleSpreadLeftMax,
      sparkleSpreadLeftMin,
      sparkleSpreadTopMax,
      sparkleSpreadTopMin,
      startDelay,
    ],
  );

  if (typeof document === "undefined") {
    return null;
  }

  return createPortal(
    <>
      <style>{`
        .devtools-aurora-sparkle-layer {
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
          animation: devtoolsAuroraSparkleLayerStart 0s linear ${startDelay}s forwards;
        }

        @keyframes devtoolsAuroraSparkleLayerStart {
          to {
            opacity: 1;
            visibility: visible;
          }
        }

        .devtools-vercel-aurora {
          position: absolute;
          left: 50%;
          top: 0;
          width: max(100vw, 70rem);
          height: min(54rem, 78vh);
          transform: translateX(-50%) translateY(-35%);
          opacity: 0;
          animation: devtoolsAuroraEnter ${auroraDuration}s cubic-bezier(0.16, 1, 0.3, 1) ${startDelay}s forwards;
        }

        .devtools-vercel-aurora__mask {
          position: absolute;
          inset: 0;
          overflow: hidden;
          mask-image: radial-gradient(ellipse at 50% 26%, black 18%, rgba(0, 0, 0, 0.86) 32%, transparent 72%);
          -webkit-mask-image: radial-gradient(ellipse at 50% 26%, black 18%, rgba(0, 0, 0, 0.86) 32%, transparent 72%);
        }

        .devtools-vercel-aurora__lights {
          position: absolute;
          inset: -2.5rem;
          overflow: hidden;
          filter: blur(34px);
          opacity: 0.92;
          background-image:
            repeating-linear-gradient(
              110deg,
              rgba(0, 0, 0, 0.98) 0%,
              rgba(0, 0, 0, 0.98) 7%,
              transparent 10%,
              transparent 13%,
              rgba(0, 0, 0, 0.98) 19%
            ),
            repeating-linear-gradient(
              110deg,
              rgba(20, 220, 190, 0.95) 10%,
              rgba(50, 130, 255, 0.95) 15%,
              rgba(145, 80, 255, 0.95) 20%,
              rgba(255, 70, 185, 0.95) 25%,
              rgba(255, 175, 55, 0.95) 30%
            );
          background-size: 120% 120%, 220% 220%;
          background-position: 50% 50%, 50% 50%;
        }

        .devtools-vercel-aurora__motion {
          position: absolute;
          inset: 0;
          width: 300%;
          mix-blend-mode: screen;
          background-image:
            repeating-linear-gradient(
              110deg,
              rgba(0, 0, 0, 0.96) 0%,
              rgba(0, 0, 0, 0.96) 7%,
              transparent 10%,
              transparent 12%,
              rgba(0, 0, 0, 0.96) 19%
            ),
            repeating-linear-gradient(
              110deg,
              rgba(20, 220, 190, 0.9) 10%,
              rgba(50, 130, 255, 0.9) 15%,
              rgba(145, 80, 255, 0.9) 20%,
              rgba(255, 70, 185, 0.9) 25%,
              rgba(255, 175, 55, 0.9) 30%
            );
          background-size: 100% 100%, 190% 190%;
          background-position: 50% 50%, 50% 50%;
          animation: devtoolsAuroraDrift 6.4s linear ${startDelay}s forwards;
        }

        .devtools-glow-pop {
          position: absolute;
          left: 50%;
          top: 18%;
          width: min(54rem, 96vw);
          height: min(22rem, 42vh);
          border-radius: 9999px;
          opacity: 0;
          transform: translate(-50%, -50%) scale(0.82);
          background:
            radial-gradient(circle at 34% 42%, rgba(20, 220, 190, 0.34), transparent 35%),
            radial-gradient(circle at 52% 35%, rgba(80, 150, 255, 0.36), transparent 36%),
            radial-gradient(circle at 68% 40%, rgba(190, 85, 255, 0.34), transparent 35%),
            radial-gradient(circle at 82% 48%, rgba(255, 165, 55, 0.28), transparent 38%);
          filter: blur(38px);
          animation: devtoolsGlowPop ${glowDuration}s cubic-bezier(0.16, 1, 0.3, 1) ${startDelay}s forwards;
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

        @keyframes devtoolsAuroraEnter {
          0% {
            opacity: 0;
            transform: translateX(-50%) translateY(-48%) scale(0.94);
          }

          28% {
            opacity: 0.96;
          }

          72% {
            opacity: 0.86;
          }

          100% {
            opacity: 0;
            transform: translateX(-50%) translateY(-36%) scale(1.08);
          }
        }

        @keyframes devtoolsAuroraDrift {
          0% {
            transform: translateX(-34%);
            background-position: 0% 50%, 0% 50%;
          }

          100% {
            transform: translateX(0%);
            background-position: 100% 50%, 100% 50%;
          }
        }

        @keyframes devtoolsGlowPop {
          0% {
            opacity: 0;
            transform: translate(-50%, -50%) scale(0.76);
          }

          18% {
            opacity: 1;
            transform: translate(-50%, -50%) scale(1);
          }

          72% {
            opacity: 0.72;
          }

          100% {
            opacity: 0;
            transform: translate(-50%, -50%) scale(1.18);
          }
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
          .devtools-aurora-sparkle-layer,
          .devtools-vercel-aurora,
          .devtools-vercel-aurora__motion,
          .devtools-glow-pop,
          .devtools-sparkle {
            animation-duration: 0.01ms !important;
            animation-iteration-count: 1 !important;
          }
        }
      `}</style>

      <div
        className="devtools-aurora-sparkle-layer"
        style={{ zIndex }}
        aria-hidden="true"
      >
        <div className="devtools-vercel-aurora">
          <div className="devtools-vercel-aurora__mask">
            <div className="devtools-vercel-aurora__lights">
              <div className="devtools-vercel-aurora__motion" />
            </div>
          </div>
        </div>

        <div className="devtools-glow-pop" />

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
