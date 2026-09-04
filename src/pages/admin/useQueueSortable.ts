import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import {
  edgeScrollVelocity,
  planQueueDrag,
  type QueueDragPlan,
  type SortableRect,
} from "./queueDragModel";

/**
 * A vertical sortable list driven by the pointer, for the processing queue.
 *
 * The browser's own drag and drop was what made the old queue read as broken:
 * it takes a picture of the card, floats the picture under the cursor, and
 * leaves the card itself sitting in the list — so the same episode appeared
 * twice and the list never showed where the drop would put it. Here nothing is
 * duplicated. The row under the cursor is the row being moved, and every other
 * row is translated out of its way as the target slot changes, so the list on
 * screen is always the list a release would commit.
 *
 * Two rules shape the implementation:
 *
 *  - The list's *DOM* order is frozen for the length of the gesture and the
 *    rearranging is done with transforms. Reordering the DOM under a pointer
 *    that is holding one of its rows is how cards teleport.
 *  - The card that follows the pointer is moved imperatively. The page around
 *    this list is large and repaints on a one-second poll; putting a pixel
 *    offset into React state would re-render all of it on every mouse move.
 *    Only the target index goes into state, and that changes a handful of
 *    times per drag.
 */

/** How far the pointer must travel before a press becomes a drag. */
const ACTIVATION_DISTANCE = 4;
/** Long enough to read as movement, short enough not to be an animation. */
const SETTLE_MS = 190;
const REFLOW = `transform ${SETTLE_MS}ms cubic-bezier(0.22, 1, 0.36, 1)`;

/**
 * The reflow, unless the operator has asked the machine to stop moving things.
 *
 * Rows still go where they go — the list is the whole point — they simply
 * arrive rather than travel.
 */
function reflowTransition(): string {
  if (typeof window.matchMedia !== "function") return REFLOW;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ? "none"
    : REFLOW;
}

/**
 * Held cards lift slightly; the scale rides along with the settle.
 *
 * Small on purpose: these cards run the width of the page, so a percent of
 * scale is many pixels of width, and a card that visibly grows reads as a
 * layout change rather than as something picked up.
 */
const LIFT_SCALE = 1.008;

type Settle = {
  id: string;
  offset: number;
  /**
   * A committed drop has already moved the row in the DOM, so the rows around
   * it must not animate their transforms away — they are already where they
   * belong. A cancelled drag has moved nothing, so they must.
   */
  kind: "commit" | "cancel";
};

type Session = {
  activeId: string;
  pointerId: number;
  rects: SortableRect[];
  startPageY: number;
  lastClientY: number;
  offsetY: number;
  started: boolean;
  index: number;
  order: string[];
  plan: QueueDragPlan | null;
  scrollFrame: number | null;
};

export type QueueSortable = {
  /** The order a release would commit, or null when nothing is being dragged. */
  previewOrder: string[] | null;
  /** Collects the row elements the model measures. */
  registerRow: (id: string) => (element: HTMLLIElement | null) => void;
  /** Wire to the drag handle's `onPointerDown`. */
  startDrag: (event: ReactPointerEvent<HTMLElement>, id: string) => void;
  /** Inline style for a row: its transform, and nothing else. */
  rowStyle: (id: string) => CSSProperties | undefined;
  /** True while this row is the one under the pointer. */
  isActive: (id: string) => boolean;
  /** True while this row is animating into the place it was dropped. */
  isSettling: (id: string) => boolean;
  /** Abandons the gesture and puts the list back, committing nothing. */
  cancel: () => void;
};

export function useQueueSortable(options: {
  /** The sortable rows, in the order they are currently rendered. */
  ids: readonly string[];
  /** Called once, on release, with the whole new order. */
  onCommit: (orderedIds: string[]) => void;
  /** Called when a drag begins, with the order to hold the list in. */
  onDragStart?: (orderedIds: string[]) => void;
  /** Called when the gesture ends, however it ends. */
  onDragEnd?: () => void;
  disabled?: boolean;
}): QueueSortable {
  const { ids, onCommit, onDragStart, onDragEnd, disabled = false } = options;

  const [drag, setDrag] = useState<{
    activeId: string;
    order: string[];
    shifts: Map<string, number>;
  } | null>(null);
  const [settle, setSettle] = useState<Settle | null>(null);

  const rowsRef = useRef(new Map<string, HTMLLIElement>());
  const sessionRef = useRef<Session | null>(null);
  const idsRef = useRef(ids);
  /*
   * The rows and the callbacks are read through refs by the window listeners,
   * so that a poll landing mid-drag — which gives the page new arrays and new
   * callback identities every second — cannot tear down and re-arm the
   * listeners underneath the gesture.
   */
  const handlersRef = useRef({ onCommit, onDragStart, onDragEnd });
  useEffect(() => {
    idsRef.current = ids;
    handlersRef.current = { onCommit, onDragStart, onDragEnd };
  });

  /*
   * One ref callback per row, kept between renders. A fresh closure each time
   * would have React detach and re-attach every row on every poll — and the
   * map of measured rows would empty itself in the middle of a gesture.
   */
  const refCallbacksRef = useRef(
    new Map<string, (element: HTMLLIElement | null) => void>(),
  );
  const registerRow = useCallback((id: string) => {
    const existing = refCallbacksRef.current.get(id);
    if (existing) return existing;
    const callback = (element: HTMLLIElement | null) => {
      if (element) rowsRef.current.set(id, element);
      else rowsRef.current.delete(id);
    };
    refCallbacksRef.current.set(id, callback);
    return callback;
  }, []);

  /** Puts the held card where the pointer is, without going through React. */
  const paintActive = useCallback((session: Session, offset: number) => {
    const node = rowsRef.current.get(session.activeId);
    if (!node) return;
    node.style.transform = `translate3d(0, ${offset}px, 0) scale(${LIFT_SCALE})`;
  }, []);

  const stopEdgeScroll = useCallback((session: Session) => {
    if (session.scrollFrame !== null) {
      cancelAnimationFrame(session.scrollFrame);
      session.scrollFrame = null;
    }
  }, []);

  /** Releases everything the gesture took hold of, whatever its outcome. */
  const teardown = useCallback(
    (session: Session) => {
      stopEdgeScroll(session);
      const node = rowsRef.current.get(session.activeId);
      if (node) {
        node.style.willChange = "";
        // Cleared before the card is handed back to React, so the settle
        // below animates from where the eye left it rather than from here.
        node.style.transition = "";
      }
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      sessionRef.current = null;
      setDrag(null);
      handlersRef.current.onDragEnd?.();
    },
    [stopEdgeScroll],
  );

  /**
   * Ends the gesture with the card animating into place from wherever it was
   * left. On a drop the row has already moved in the DOM, so the animation
   * starts from the difference between the two; on a cancel it starts from the
   * full offset and returns to nothing.
   */
  const finish = useCallback(
    (session: Session, kind: "commit" | "cancel") => {
      const painted = session.plan?.magneticOffset ?? session.offsetY;
      const from =
        kind === "commit"
          ? painted - (session.plan?.activeSlotOffset ?? 0)
          : painted;
      const activeId = session.activeId;
      const node = rowsRef.current.get(activeId);
      teardown(session);
      if (!node || Math.abs(from) < 0.5) {
        if (node) node.style.transform = "";
        setSettle(null);
        return;
      }
      /*
       * React owns the transform again from here: the first render puts the
       * card back where the eye last saw it, and the next frame takes it to
       * zero with a transition, so the commit itself is never a jump.
       */
      node.style.transform = "";
      setSettle({ id: activeId, offset: from, kind });
    },
    [teardown],
  );

  const cancelDrag = useCallback(() => {
    const session = sessionRef.current;
    if (!session) return;
    if (!session.started) {
      teardown(session);
      return;
    }
    finish(session, "cancel");
  }, [finish, teardown]);

  /* The settle: one frame at the old position, then a transition to none. */
  useEffect(() => {
    if (!settle || settle.offset === 0) return;
    const frame = requestAnimationFrame(() =>
      setSettle((current) =>
        current && current.id === settle.id
          ? { ...current, offset: 0 }
          : current,
      ),
    );
    return () => cancelAnimationFrame(frame);
  }, [settle]);

  useEffect(() => {
    if (!settle || settle.offset !== 0) return;
    const timer = window.setTimeout(
      () => setSettle((current) => (current === settle ? null : current)),
      SETTLE_MS + 30,
    );
    return () => window.clearTimeout(timer);
  }, [settle]);

  /** A press that has travelled far enough becomes a drag, once. */
  const begin = useCallback((session: Session) => {
    const rects: SortableRect[] = [];
    for (const id of idsRef.current) {
      const node = rowsRef.current.get(id);
      if (!node) continue;
      const box = node.getBoundingClientRect();
      rects.push({
        id,
        // Page coordinates: an edge scroll must not move the model.
        top: box.top + window.scrollY,
        height: box.height,
      });
    }
    if (rects.length < 2) return false;
    session.rects = rects;
    session.started = true;
    session.order = rects.map((rect) => rect.id);
    session.index = session.order.indexOf(session.activeId);
    document.body.style.userSelect = "none";
    document.body.style.cursor = "grabbing";
    const node = rowsRef.current.get(session.activeId);
    if (node) {
      node.style.willChange = "transform";
      /*
       * The held card is animated for the same reason its neighbours are: its
       * position is its *slot*, and a slot changes by a whole row at a time.
       * Drawn without this the card would teleport at every boundary. Within a
       * slot the card only ever moves the few pixels of give the magnet allows,
       * so the same transition reads there as a card on a spring rather than
       * as a card lagging the pointer.
       */
      node.style.transition = reflowTransition();
    }
    handlersRef.current.onDragStart?.([...session.order]);
    setDrag({
      activeId: session.activeId,
      order: [...session.order],
      shifts: new Map(),
    });
    return true;
  }, []);

  /** Re-plans from the pointer, and tells React only when the slot changes. */
  const update = useCallback(
    (session: Session) => {
      const plan = planQueueDrag(
        session.rects,
        session.activeId,
        session.offsetY,
      );
      if (!plan) return;
      session.plan = plan;
      paintActive(session, plan.magneticOffset);
      if (plan.index === session.index) return;
      session.index = plan.index;
      session.order = plan.order;
      setDrag({
        activeId: session.activeId,
        order: plan.order,
        shifts: plan.shifts,
      });
    },
    [paintActive],
  );

  const runEdgeScroll = useCallback(
    (session: Session) => {
      const step = () => {
        session.scrollFrame = null;
        if (sessionRef.current !== session || !session.started) return;
        const velocity = edgeScrollVelocity(
          session.lastClientY,
          window.innerHeight,
        );
        if (velocity !== 0) {
          const before = window.scrollY;
          window.scrollBy(0, velocity);
          if (window.scrollY !== before) {
            // The pointer has not moved; the page under it has.
            session.offsetY =
              session.lastClientY + window.scrollY - session.startPageY;
            update(session);
          }
        }
        session.scrollFrame = requestAnimationFrame(step);
      };
      session.scrollFrame = requestAnimationFrame(step);
    },
    [update],
  );

  const startDrag = useCallback(
    (event: ReactPointerEvent<HTMLElement>, id: string) => {
      if (disabled || event.button !== 0 || sessionRef.current) return;
      if (!idsRef.current.includes(id)) return;
      // Keeps the press from selecting the text of the card underneath it.
      event.preventDefault();
      // ...but the handle still has to take focus, or a press would cost the
      // keyboard user the arrow keys that move the row without a mouse.
      event.currentTarget.focus?.();
      const session: Session = {
        activeId: id,
        pointerId: event.pointerId,
        rects: [],
        startPageY: event.clientY + window.scrollY,
        lastClientY: event.clientY,
        offsetY: 0,
        started: false,
        index: -1,
        order: [],
        plan: null,
        scrollFrame: null,
      };
      sessionRef.current = session;
      setSettle(null);
    },
    [disabled],
  );

  /*
   * The gesture is followed on the window rather than on the row: a pointer
   * that leaves the card, or the list, is still holding it.
   */
  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const session = sessionRef.current;
      if (!session || event.pointerId !== session.pointerId) return;
      session.lastClientY = event.clientY;
      session.offsetY = event.clientY + window.scrollY - session.startPageY;
      if (!session.started) {
        if (Math.abs(session.offsetY) < ACTIVATION_DISTANCE) return;
        if (!begin(session)) {
          sessionRef.current = null;
          return;
        }
        runEdgeScroll(session);
      }
      event.preventDefault();
      update(session);
    };

    const onUp = (event: PointerEvent) => {
      const session = sessionRef.current;
      if (!session || event.pointerId !== session.pointerId) return;
      if (!session.started) {
        teardown(session);
        return;
      }
      const order = session.order;
      const unchanged = order.every(
        (id, index) => id === session.rects[index]!.id,
      );
      /*
       * The DOM moves first and the animation catches up: committing inside
       * the same render as the settle's starting offset is what makes the drop
       * read as the card landing rather than as the list blinking.
       */
      if (!unchanged) handlersRef.current.onCommit([...order]);
      finish(session, "commit");
    };

    const onCancel = (event: PointerEvent) => {
      const session = sessionRef.current;
      if (!session || event.pointerId !== session.pointerId) return;
      cancelDrag();
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !sessionRef.current) return;
      event.preventDefault();
      cancelDrag();
    };

    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [begin, cancelDrag, finish, runEdgeScroll, teardown, update]);

  /* A page that unmounts mid-drag must not leave the body unselectable. */
  useEffect(
    () => () => {
      const session = sessionRef.current;
      if (session) {
        stopEdgeScroll(session);
        document.body.style.userSelect = "";
        document.body.style.cursor = "";
        sessionRef.current = null;
      }
    },
    [stopEdgeScroll],
  );

  const rowStyle = useCallback(
    (id: string): CSSProperties | undefined => {
      if (settle && settle.id === id) {
        const motion = reflowTransition();
        return {
          transform: `translate3d(0, ${settle.offset}px, 0)`,
          // The lift comes off over the same moment the card lands, rather
          // than snapping away the instant the button is released.
          transition:
            motion === "none" ? motion : `${motion}, box-shadow 190ms ease-out`,
          position: "relative",
          zIndex: 20,
        };
      }
      if (settle) {
        /*
         * After a drop these rows are already in their new places; animating
         * them from a transform they no longer have would move them twice.
         * After a cancel there is nothing to hold them, so they glide back.
         */
        return settle.kind === "commit"
          ? { transition: "none" }
          : { transition: reflowTransition() };
      }
      if (!drag) return undefined;
      if (id === drag.activeId) {
        /*
         * The transform and its transition are written straight to the node
         * while dragging, so both are deliberately absent here: naming them
         * would hand the card back to React and cost a render of the whole
         * page on every pointer move.
         */
        return { position: "relative", zIndex: 30 };
      }
      const shift = drag.shifts.get(id);
      return {
        transform: shift ? `translate3d(0, ${shift}px, 0)` : undefined,
        transition: reflowTransition(),
      };
    },
    [drag, settle],
  );

  return {
    previewOrder: drag?.order ?? null,
    registerRow,
    startDrag,
    rowStyle,
    isActive: useCallback((id: string) => drag?.activeId === id, [drag]),
    isSettling: useCallback((id: string) => settle?.id === id, [settle]),
    cancel: cancelDrag,
  };
}
