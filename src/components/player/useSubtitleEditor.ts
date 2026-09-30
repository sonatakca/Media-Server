import {
  useCallback,
  useRef,
  useState,
  type MouseEvent,
  type MutableRefObject,
  type PointerEvent,
  type RefObject,
} from "react";
import {
  DEFAULT_SUBTITLE_SCALE,
  MAX_SUBTITLE_SCALE,
  MIN_SUBTITLE_SCALE,
} from "./constants";
import { clamp } from "./mediaGeometry";
import type {
  SubtitleDragState,
  SubtitlePosition,
  SubtitleResizeState,
  SubtitleSize,
} from "./types";

interface SubtitleEditorOptions {
  containerRef: RefObject<HTMLDivElement | null>;
  isSubtitleEditMode: boolean;
  setIsSubtitleEditMode: (isEditing: boolean) => void;
  /** Keeps the tap that ends a drag from also toggling playback. */
  suppressPlayerTapUntilRef: MutableRefObject<number>;
  resetTouchSeekSession: () => void;
  revealPlayerChrome: () => void;
  /** A double click on the subtitles asks the player to enter edit mode. */
  onRequestEdit: () => void;
}

/** Percent of the player, kept clear of the edges the chrome sits on. */
function toPlayerPercent(
  bounds: DOMRect,
  centerX: number,
  centerY: number,
): SubtitlePosition {
  return {
    x: clamp(((centerX - bounds.left) / bounds.width) * 100, 8, 92),
    y: clamp(((centerY - bounds.top) / bounds.height) * 100, 10, 90),
  };
}

/**
 * Where the subtitles sit and how large they are, and the drag and corner
 * handles that change it.
 *
 * Entering and leaving edit mode stays with the player, which also closes its
 * panels and hides its chrome; this owns only the overlay's own geometry.
 */
export function useSubtitleEditor({
  containerRef,
  isSubtitleEditMode,
  setIsSubtitleEditMode,
  suppressPlayerTapUntilRef,
  resetTouchSeekSession,
  revealPlayerChrome,
  onRequestEdit,
}: SubtitleEditorOptions) {
  const subtitleOverlayRef = useRef<HTMLDivElement | null>(null);
  const subtitleDragStateRef = useRef<SubtitleDragState | null>(null);
  const subtitleResizeStateRef = useRef<SubtitleResizeState | null>(null);
  const [subtitlePosition, setSubtitlePosition] =
    useState<SubtitlePosition | null>(null);
  const [subtitleSize, setSubtitleSize] = useState<SubtitleSize>({
    scale: DEFAULT_SUBTITLE_SCALE,
  });
  const [isDraggingSubtitle, setIsDraggingSubtitle] = useState(false);
  const [isResizingSubtitle, setIsResizingSubtitle] = useState(false);

  /** Pins the overlay where it is drawn now, so the first drag starts there. */
  const initializeSubtitleEditPosition = useCallback(() => {
    const bounds = containerRef.current?.getBoundingClientRect();
    const overlayBounds = subtitleOverlayRef.current?.getBoundingClientRect();

    if (!bounds || !overlayBounds) {
      return;
    }

    const overlayCenterX = overlayBounds.left + overlayBounds.width / 2;
    const overlayCenterY = overlayBounds.top + overlayBounds.height / 2;

    setSubtitlePosition(
      (currentPosition) =>
        currentPosition ??
        toPlayerPercent(bounds, overlayCenterX, overlayCenterY),
    );
  }, [containerRef]);

  /** Drops any drag or resize in progress. */
  const clearSubtitleInteraction = useCallback(() => {
    setIsDraggingSubtitle(false);
    setIsResizingSubtitle(false);
    subtitleDragStateRef.current = null;
    subtitleResizeStateRef.current = null;
  }, []);

  /** Back to the default place and size, for a new title. */
  const resetSubtitleLayout = useCallback(() => {
    setSubtitlePosition(null);
    setSubtitleSize({ scale: DEFAULT_SUBTITLE_SCALE });
  }, []);

  const getSubtitlePositionFromPoint = (
    clientX: number,
    clientY: number,
  ): SubtitlePosition | null => {
    const bounds = containerRef.current?.getBoundingClientRect();
    const dragState = subtitleDragStateRef.current;

    if (!bounds || !dragState) {
      return null;
    }

    return toPlayerPercent(
      bounds,
      clientX - dragState.offsetX,
      clientY - dragState.offsetY,
    );
  };

  const handleSubtitleDoubleClick = (event: MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    onRequestEdit();
  };

  const handleSubtitleResizePointerDown = (
    event: PointerEvent<HTMLButtonElement>,
    directionX: -1 | 1,
    directionY: -1 | 1,
  ) => {
    event.preventDefault();
    event.stopPropagation();

    event.currentTarget.setPointerCapture(event.pointerId);

    subtitleResizeStateRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startScale: subtitleSize.scale,
      directionX,
      directionY,
    };

    setIsSubtitleEditMode(true);
    setIsResizingSubtitle(true);
    setIsDraggingSubtitle(false);
    subtitleDragStateRef.current = null;
    resetTouchSeekSession();
    revealPlayerChrome();
  };

  const handleSubtitleResizePointerMove = (
    event: PointerEvent<HTMLButtonElement>,
  ) => {
    const resizeState = subtitleResizeStateRef.current;

    if (!resizeState || resizeState.pointerId !== event.pointerId) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const deltaX =
      (event.clientX - resizeState.startClientX) * resizeState.directionX;
    const deltaY =
      (event.clientY - resizeState.startClientY) * resizeState.directionY;
    const strongestDelta =
      Math.abs(deltaX) > Math.abs(deltaY) ? deltaX : deltaY;
    const nextScale = clamp(
      resizeState.startScale + strongestDelta / 220,
      MIN_SUBTITLE_SCALE,
      MAX_SUBTITLE_SCALE,
    );

    setSubtitleSize({ scale: nextScale });
  };

  const finishSubtitleResize = (event: PointerEvent<HTMLButtonElement>) => {
    const resizeState = subtitleResizeStateRef.current;

    if (!resizeState || resizeState.pointerId !== event.pointerId) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    subtitleResizeStateRef.current = null;
    setIsResizingSubtitle(false);
    suppressPlayerTapUntilRef.current = Date.now() + 450;
    resetTouchSeekSession();
  };

  const handleSubtitleResizePointerCancel = (
    event: PointerEvent<HTMLButtonElement>,
  ) => {
    if (subtitleResizeStateRef.current?.pointerId !== event.pointerId) {
      return;
    }

    event.stopPropagation();
    subtitleResizeStateRef.current = null;
    setIsResizingSubtitle(false);
    suppressPlayerTapUntilRef.current = Date.now() + 450;
    resetTouchSeekSession();
  };

  const handleSubtitlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!isSubtitleEditMode) {
      return;
    }

    const bounds = containerRef.current?.getBoundingClientRect();
    const overlayBounds = subtitleOverlayRef.current?.getBoundingClientRect();

    if (!bounds || !overlayBounds) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);

    const overlayCenterX = overlayBounds.left + overlayBounds.width / 2;
    const overlayCenterY = overlayBounds.top + overlayBounds.height / 2;

    subtitleDragStateRef.current = {
      pointerId: event.pointerId,
      offsetX: event.clientX - overlayCenterX,
      offsetY: event.clientY - overlayCenterY,
    };

    setSubtitlePosition(
      (currentPosition) =>
        currentPosition ??
        toPlayerPercent(bounds, overlayCenterX, overlayCenterY),
    );
    setIsDraggingSubtitle(true);
    setIsResizingSubtitle(false);
    subtitleResizeStateRef.current = null;
    resetTouchSeekSession();
    revealPlayerChrome();
  };

  const handleSubtitlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const dragState = subtitleDragStateRef.current;

    if (!dragState || dragState.pointerId !== event.pointerId) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const nextPosition = getSubtitlePositionFromPoint(
      event.clientX,
      event.clientY,
    );

    if (nextPosition) {
      setSubtitlePosition(nextPosition);
    }
  };

  const finishSubtitleDrag = (event: PointerEvent<HTMLDivElement>) => {
    const dragState = subtitleDragStateRef.current;

    if (!dragState || dragState.pointerId !== event.pointerId) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    const nextPosition = getSubtitlePositionFromPoint(
      event.clientX,
      event.clientY,
    );

    if (nextPosition) {
      setSubtitlePosition(nextPosition);
    }

    subtitleDragStateRef.current = null;
    suppressPlayerTapUntilRef.current = Date.now() + 450;
    setIsDraggingSubtitle(false);
    resetTouchSeekSession();
  };

  const handleSubtitlePointerCancel = (event: PointerEvent<HTMLDivElement>) => {
    if (subtitleDragStateRef.current?.pointerId !== event.pointerId) {
      return;
    }

    event.stopPropagation();
    subtitleDragStateRef.current = null;
    suppressPlayerTapUntilRef.current = Date.now() + 450;
    setIsDraggingSubtitle(false);
    setIsResizingSubtitle(false);
    resetTouchSeekSession();
  };

  return {
    subtitleOverlayRef,
    subtitlePosition,
    subtitleSize,
    isDraggingSubtitle,
    isResizingSubtitle,
    initializeSubtitleEditPosition,
    clearSubtitleInteraction,
    resetSubtitleLayout,
    handleSubtitleDoubleClick,
    handleSubtitleResizePointerDown,
    handleSubtitleResizePointerMove,
    finishSubtitleResize,
    handleSubtitleResizePointerCancel,
    handleSubtitlePointerDown,
    handleSubtitlePointerMove,
    finishSubtitleDrag,
    handleSubtitlePointerCancel,
  };
}
