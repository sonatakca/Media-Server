import { useMemo, useRef, useState, type MouseEvent, type PointerEvent } from "react";
import { useLanguage } from "../../i18n/LanguageContext";
import { getTrickplayImageUrl } from "../../lib/jellyfinApi";

interface SeekBarProps {
  currentTime: number;
  duration: number;
  bufferedEnd: number;
  itemId: string;
  mediaSourceId?: string;
  onSeek: (seconds: number) => void;
  onSeekPreview?: (seconds: number) => void;
}

interface HoverPreviewState {
  isVisible: boolean;
  percent: number;
  seconds: number;
  displaySeconds: number;
}



const TRICKPLAY_RESOLUTION = 320;
const TRICKPLAY_INTERVAL_SECONDS = 10;

const TRICKPLAY_COLUMNS = 10;
const TRICKPLAY_ROWS = 10;
const TRICKPLAY_IMAGES_PER_SHEET = TRICKPLAY_COLUMNS * TRICKPLAY_ROWS;

const TRICKPLAY_TILE_WIDTH = 320;
const TRICKPLAY_TILE_HEIGHT = 132;
const SEEK_DRAG_THRESHOLD_PX = 6;
const SEEK_SNAP_INTERVAL_SECONDS = 3;

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return "0:00";
  }

  const totalSeconds = Math.floor(seconds);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const remainingSeconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, "0")}:${remainingSeconds
      .toString()
      .padStart(2, "0")}`;
  }

  return `${minutes}:${remainingSeconds.toString().padStart(2, "0")}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function getDisplaySeekPoint(seconds: number, duration: number): number {
  if (!Number.isFinite(seconds) || duration <= 0) {
    return 0;
  }

  const safeSeconds = clamp(seconds, 0, duration);
  const snappedSeconds = Math.floor((safeSeconds + 0.01) / SEEK_SNAP_INTERVAL_SECONDS) * SEEK_SNAP_INTERVAL_SECONDS;

  return clamp(snappedSeconds, 0, duration);
}

function getSafeSeekTargetSeconds(displaySeconds: number, duration: number): number {
  if (!Number.isFinite(displaySeconds) || duration <= 0) {
    return 0;
  }

  return clamp(displaySeconds, 0, duration);
}

export function SeekBar({
  currentTime,
  duration,
  bufferedEnd,
  itemId,
  mediaSourceId,
  onSeek,
  onSeekPreview,
}: SeekBarProps) {
  const { t } = useLanguage();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const pointerDownSeekStateRef = useRef<HoverPreviewState | null>(null);
  const pointerStartRef = useRef<{
    pointerId: number;
    clientX: number;
    didPassDragThreshold: boolean;
  } | null>(null);

  const [isSeeking, setIsSeeking] = useState(false);
  const [isTrickplayImageBroken, setIsTrickplayImageBroken] = useState(false);

  const [hoverPreview, setHoverPreview] = useState<HoverPreviewState>({
    isVisible: false,
    percent: 0,
    seconds: 0,
    displaySeconds: 0,
  });

  const previewSeconds = isSeeking ? hoverPreview.displaySeconds : currentTime;
  const progressPercent = duration > 0 ? (previewSeconds / duration) * 100 : 0;
  const bufferedPercent = duration > 0 ? (bufferedEnd / duration) * 100 : 0;


  const getPointerSeekState = (clientX: number): HoverPreviewState | null => {
    const bounds = rootRef.current?.getBoundingClientRect();

    if (!bounds || duration <= 0) {
      return null;
    }

    const rawPercent = ((clientX - bounds.left) / bounds.width) * 100;
    const rawSeconds = (clamp(rawPercent, 0, 100) / 100) * duration;
    const displaySeconds = getDisplaySeekPoint(rawSeconds, duration);
    const seconds = getSafeSeekTargetSeconds(displaySeconds, duration);
    const percent = duration > 0 ? (displaySeconds / duration) * 100 : 0;

    return {
      isVisible: true,
      percent,
      seconds,
      displaySeconds,
    };
  };

  const trickplay = useMemo(() => {
    if (!hoverPreview.isVisible || !itemId || !mediaSourceId || duration <= 0) {
      return null;
    }

    const globalTileIndex = Math.max(
      0,
      Math.floor(hoverPreview.displaySeconds / TRICKPLAY_INTERVAL_SECONDS),
    );

    const sheetIndex = Math.floor(globalTileIndex / TRICKPLAY_IMAGES_PER_SHEET);
    const tileIndexOnSheet = globalTileIndex % TRICKPLAY_IMAGES_PER_SHEET;

    const column = tileIndexOnSheet % TRICKPLAY_COLUMNS;
    const row = Math.floor(tileIndexOnSheet / TRICKPLAY_COLUMNS);

    return {
      imageUrl: getTrickplayImageUrl(
        itemId,
        mediaSourceId,
        TRICKPLAY_RESOLUTION,
        sheetIndex,
      ),
      column,
      row,
    };
  }, [duration, hoverPreview.displaySeconds, hoverPreview.isVisible, itemId, mediaSourceId]);

  const updateHoverPreview = (event: MouseEvent<HTMLDivElement>) => {
    const nextHoverPreview = getPointerSeekState(event.clientX);

    if (!nextHoverPreview) {
      return;
    }

    setIsTrickplayImageBroken(false);
    setHoverPreview(nextHoverPreview);
  };

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    const nextSeekState = getPointerSeekState(event.clientX);

    if (!nextSeekState) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);

    pointerStartRef.current = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      didPassDragThreshold: false,
    };
    pointerDownSeekStateRef.current = nextSeekState;

    setIsSeeking(true);
    setIsTrickplayImageBroken(false);
    setHoverPreview(nextSeekState);
    onSeekPreview?.(nextSeekState.displaySeconds);
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!isSeeking) {
      return;
    }

    const nextSeekState = getPointerSeekState(event.clientX);

    if (!nextSeekState) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    setHoverPreview(nextSeekState);

    const pointerStart = pointerStartRef.current;

    if (!pointerStart || pointerStart.pointerId !== event.pointerId) {
      return;
    }

    const movedDistance = Math.abs(event.clientX - pointerStart.clientX);

    if (!pointerStart.didPassDragThreshold && movedDistance < SEEK_DRAG_THRESHOLD_PX) {
      return;
    }

    pointerStart.didPassDragThreshold = true;
    pointerDownSeekStateRef.current = nextSeekState;
    onSeekPreview?.(nextSeekState.displaySeconds);
  };

  const finishPointerSeek = (event: PointerEvent<HTMLDivElement>) => {
    if (!isSeeking) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const pointerStart = pointerStartRef.current;
    const nextSeekState =
      pointerStart?.didPassDragThreshold
        ? getPointerSeekState(event.clientX) ?? pointerDownSeekStateRef.current
        : pointerDownSeekStateRef.current;

    if (nextSeekState) {
      setHoverPreview(nextSeekState);
      onSeekPreview?.(nextSeekState.displaySeconds);
      onSeek(nextSeekState.seconds);
    }

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    pointerStartRef.current = null;
    pointerDownSeekStateRef.current = null;
    setIsSeeking(false);
  };

  const cancelPointerSeek = (event: PointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    pointerStartRef.current = null;
    pointerDownSeekStateRef.current = null;
    setIsSeeking(false);
  };

  const hideHoverPreview = () => {
    if (isSeeking) {
      return;
    }

    setHoverPreview((current) => ({
      ...current,
      isVisible: false,
    }));
  };

  const previewLeftPercent = clamp(hoverPreview.percent, 6, 94);

  return (
    <div
      ref={rootRef}
      className="relative h-7 w-full cursor-pointer touch-none"
      onMouseMove={updateHoverPreview}
      onMouseEnter={updateHoverPreview}
      onMouseLeave={hideHoverPreview}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={finishPointerSeek}
      onPointerCancel={cancelPointerSeek}
      role="slider"
      tabIndex={0}
      aria-label={t("player.seek")}
      aria-valuemin={0}
      aria-valuemax={duration || 0}
      aria-valuenow={Math.min(currentTime, duration || 0)}
      onKeyDown={(event) => {
        if (duration <= 0) {
          return;
        }

        if (event.key === "ArrowLeft") {
          event.preventDefault();
          const displaySeconds = getDisplaySeekPoint(currentTime - 10, duration);
          onSeek(getSafeSeekTargetSeconds(displaySeconds, duration));
        }

        if (event.key === "ArrowRight") {
          event.preventDefault();
          const displaySeconds = getDisplaySeekPoint(currentTime + 10, duration);
          onSeek(getSafeSeekTargetSeconds(displaySeconds, duration));
        }
      }}
    >
      {hoverPreview.isVisible && duration > 0 ? (
        <div
          className="seyirlik-trickplay-preview"
          style={{ left: `${previewLeftPercent}%` }}
        >
          <div className="seyirlik-trickplay-preview__imageWrap">
            {trickplay?.imageUrl && !isTrickplayImageBroken ? (
              <div
                className="seyirlik-trickplay-preview__image"
                style={{
                  width: `${TRICKPLAY_TILE_WIDTH}px`,
                  height: `${TRICKPLAY_TILE_HEIGHT}px`,
                  backgroundImage: `url("${trickplay.imageUrl}")`,
                  backgroundSize: `${TRICKPLAY_TILE_WIDTH * TRICKPLAY_COLUMNS}px ${
                    TRICKPLAY_TILE_HEIGHT * TRICKPLAY_ROWS
                  }px`,
                  backgroundPosition: `-${trickplay.column * TRICKPLAY_TILE_WIDTH}px -${
                    trickplay.row * TRICKPLAY_TILE_HEIGHT
                  }px`,
                  backgroundRepeat: "no-repeat",
                }}
              >
                <img
                  src={trickplay.imageUrl}
                  alt=""
                  className="hidden"
                  onError={() => setIsTrickplayImageBroken(true)}
                />
              </div>
            ) : (
              <div className="seyirlik-trickplay-preview__fallback">
                {formatTime(hoverPreview.displaySeconds)}
              </div>
            )}
          </div>

          <div className="seyirlik-trickplay-preview__time">
            {formatTime(hoverPreview.displaySeconds)}
          </div>

          <span className="seyirlik-trickplay-preview__pointer" />
        </div>
      ) : null}

      <div className="absolute left-0 right-0 top-1/2 h-1 -translate-y-1/2 overflow-hidden rounded-full bg-white/20">
        <div className="h-full bg-white/30" style={{ width: `${bufferedPercent}%` }} />
      </div>

      <div
        className="absolute left-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-[var(--accent)]"
        style={{ width: `${progressPercent}%` }}
      />

      {hoverPreview.isVisible && duration > 0 ? (
        <div
          className="pointer-events-none absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-[var(--accent)] shadow-[0_0_18px_var(--accent)]"
          style={{ left: `${hoverPreview.percent}%` }}
        />
      ) : null}
    </div>
  );
}