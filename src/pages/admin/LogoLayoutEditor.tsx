import { useCallback, useRef, useState, type PointerEvent } from "react";
import {
  LOGO_NUDGE_STEP,
  clampLogoLayout,
  getLogoLayoutStyle,
  getLogoShadowBackdropStyle,
  getLogoShadowFilter,
  moveLogoLayout,
  resizeLogoLayout,
  type LogoLayout,
  type ResizeCorner,
} from "../../lib/logoLayout";
import { useLanguage } from "../../i18n/LanguageContext";

interface LogoLayoutEditorProps {
  posterUrl: string;
  logoUrl: string;
  title: string;
  layout: LogoLayout;
  onChange: (layout: LogoLayout) => void;
  disabled?: boolean;
}

const CORNERS: ResizeCorner[] = [
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
];

const CORNER_CLASSES: Record<ResizeCorner, string> = {
  "top-left": "-left-1.5 -top-1.5 cursor-nwse-resize",
  "top-right": "-right-1.5 -top-1.5 cursor-nesw-resize",
  "bottom-left": "-bottom-1.5 -left-1.5 cursor-nesw-resize",
  "bottom-right": "-bottom-1.5 -right-1.5 cursor-nwse-resize",
};

/**
 * Direct manipulation of a logo over the card it will actually appear on.
 *
 * Presets could only ever approximate: a logo that reads at the foot of one
 * poster lands on a face on the next, and how large it should be depends on how
 * busy the artwork behind it is. Both are judgements about a specific picture,
 * so they are made by looking at that picture.
 */
export function LogoLayoutEditor({
  posterUrl,
  logoUrl,
  title,
  layout,
  onChange,
  disabled = false,
}: LogoLayoutEditorProps) {
  const { t } = useLanguage();
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [activeGesture, setActiveGesture] = useState<
    "move" | ResizeCorner | null
  >(null);
  const shadowFilter = getLogoShadowFilter(layout.shadow);
  const shadowBackdropStyle = getLogoShadowBackdropStyle(layout.shadow);

  /**
   * The gesture reads from a ref rather than from props, because a pointer move
   * fires far more often than React re-renders and each one has to build on the
   * previous position rather than on whatever was last painted.
   */
  const gestureRef = useRef<{
    startX: number;
    startY: number;
    layout: LogoLayout;
  } | null>(null);

  const cardBounds = useCallback(() => {
    const rect = cardRef.current?.getBoundingClientRect();
    return { width: rect?.width ?? 0, height: rect?.height ?? 0 };
  }, []);

  const beginGesture = useCallback(
    (event: PointerEvent<HTMLElement>, gesture: "move" | ResizeCorner) => {
      if (disabled) return;
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);
      gestureRef.current = {
        startX: event.clientX,
        startY: event.clientY,
        layout,
      };
      setActiveGesture(gesture);
    },
    [disabled, layout],
  );

  const continueGesture = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      const gesture = gestureRef.current;
      if (!gesture || !activeGesture) return;

      const deltaX = event.clientX - gesture.startX;
      const deltaY = event.clientY - gesture.startY;

      onChange(
        activeGesture === "move"
          ? moveLogoLayout(gesture.layout, deltaX, deltaY, cardBounds())
          : resizeLogoLayout(
              gesture.layout,
              activeGesture,
              deltaX,
              cardBounds(),
            ),
      );
    },
    [activeGesture, cardBounds, onChange],
  );

  const endGesture = useCallback((event: PointerEvent<HTMLElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    gestureRef.current = null;
    setActiveGesture(null);
  }, []);

  /** Keyboard nudging, so placement does not require a pointer at all. */
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLElement>) => {
      if (disabled) return;

      const step = event.shiftKey ? LOGO_NUDGE_STEP * 5 : LOGO_NUDGE_STEP;
      const moves: Record<string, [number, number]> = {
        ArrowLeft: [-step, 0],
        ArrowRight: [step, 0],
        ArrowUp: [0, -step],
        ArrowDown: [0, step],
      };
      const move = moves[event.key];

      if (move) {
        event.preventDefault();
        onChange(
          clampLogoLayout({
            ...layout,
            x: layout.x + move[0],
            y: layout.y + move[1],
          }),
        );
        return;
      }

      if (event.key === "+" || event.key === "=" || event.key === "-") {
        event.preventDefault();
        const direction = event.key === "-" ? -1 : 1;
        onChange(
          clampLogoLayout({
            ...layout,
            width: layout.width + direction * LOGO_NUDGE_STEP * 2,
          }),
        );
      }
    },
    [disabled, layout, onChange],
  );

  return (
    <div
      ref={cardRef}
      className="relative aspect-[2/3] w-full max-w-[18rem] select-none overflow-hidden rounded-2xl border border-white/10 bg-black"
    >
      <img
        src={posterUrl}
        alt=""
        draggable={false}
        className="absolute inset-0 h-full w-full object-cover"
      />

      {/* Matches the card's own scrim so the preview is not more legible than
          the real thing. */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-black/75 via-black/40 to-transparent" />

      <div
        role="application"
        tabIndex={disabled ? -1 : 0}
        aria-label={t("logoLayout.dragHandleLabel")}
        style={getLogoLayoutStyle(layout)}
        onPointerDown={(event) => beginGesture(event, "move")}
        onPointerMove={continueGesture}
        onPointerUp={endGesture}
        onPointerCancel={endGesture}
        onKeyDown={handleKeyDown}
        className={`absolute touch-none outline-none ring-offset-2 ring-offset-black focus-visible:ring-2 focus-visible:ring-sky-300 ${
          disabled ? "cursor-default" : "cursor-move"
        } ${activeGesture ? "ring-2 ring-sky-300" : "ring-1 ring-white/30"}`}
      >
        {shadowBackdropStyle ? (
          <span
            aria-hidden="true"
            data-logo-shadow-backdrop="true"
            style={shadowBackdropStyle}
            className="pointer-events-none absolute inset-[6%] rounded-[45%]"
          />
        ) : null}

        <img
          src={logoUrl}
          alt={title}
          draggable={false}
          style={shadowFilter ? { filter: shadowFilter } : undefined}
          className="pointer-events-none relative z-10 block h-auto w-full object-contain"
        />

        {!disabled
          ? CORNERS.map((corner) => (
              <span
                key={corner}
                role="presentation"
                onPointerDown={(event) => beginGesture(event, corner)}
                onPointerMove={continueGesture}
                onPointerUp={endGesture}
                onPointerCancel={endGesture}
                className={`absolute z-20 h-3 w-3 touch-none rounded-full border border-black/60 bg-sky-300 ${CORNER_CLASSES[corner]}`}
              />
            ))
          : null}
      </div>
    </div>
  );
}
