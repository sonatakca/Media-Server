import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
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
 * Three rules shape the implementation, and each of them exists because
 * breaking it produced a visible glitch:
 *
 *  - The list's *DOM* order is frozen for the length of the gesture and the
 *    rearranging is done with transforms. Reordering the DOM under a pointer
 *    that is holding one of its rows is how cards teleport.
 *  - The held card is drawn once per frame, from a position that pursues its
 *    target rather than being transitioned to it. A CSS transition restarted
 *    on every pointer event never finishes, and at a slot boundary — where the
 *    target moves by a whole row — it is what threw the card across the list.
 *  - The landing is a FLIP: the rows' real positions are read before the drop
 *    changes the DOM and again after, and the difference is what gets
 *    animated. Nothing is played from the model's *idea* of where a row was,
 *    so a card cannot come in from a place it was never drawn.
 */

/** How far the pointer must travel before a press becomes a drag. */
const ACTIVATION_DISTANCE = 4;
/** Long enough to read as movement, short enough not to be an animation. */
const SLIDE_MS = 200;
const SLIDE_EASING = "cubic-bezier(0.22, 1, 0.36, 1)";
const REFLOW = `transform ${SLIDE_MS}ms ${SLIDE_EASING}`;
/**
 * The time constant of the held card's pursuit of its slot.
 *
 * The card is never *placed* at its target, it is drawn a fraction of the way
 * towards it every frame, which makes the whole gesture continuous: within a
 * slot the target is the pointer and the card tracks it closely enough to feel
 * held, and at a boundary the target jumps by a row and the card travels the
 * distance instead of teleporting. About 60ms puts it within a pixel of a
 * settled target in a fifth of a second, which is the same moment the rows it
 * displaced finish moving.
 */
const FOLLOW_MS = 60;
/** One frame at sixty a second, which is what the edge scroll is measured in. */
const FRAME_MS = 1000 / 60;

/**
 * Held cards lift slightly; the scale rides along with the landing.
 *
 * Small on purpose: these cards run the width of the page, so a percent of
 * scale is many pixels of width, and a card that visibly grows reads as a
 * layout change rather than as something picked up.
 */
const LIFT_SCALE = 1.008;

function prefersReducedMotion(): boolean {
  if (typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * The reflow, unless the operator has asked the machine to stop moving things.
 *
 * Rows still go where they go — the list is the whole point — they simply
 * arrive rather than travel.
 */
function reflowTransition(): string {
  return prefersReducedMotion() ? "none" : REFLOW;
}

type Session = {
  /** The row under the pointer: the one the gesture is anchored on. */
  activeId: string;
  /**
   * Every row being carried, the held one included.
   *
   * One row unless the operator has a selection and grabbed a member of it.
   * The whole gesture is written in terms of this block, and a block of one
   * behaves exactly as a single row did.
   */
  members: string[];
  pointerId: number;
  rects: SortableRect[];
  startPageY: number;
  lastClientY: number;
  offsetY: number;
  started: boolean;
  index: number;
  order: string[];
  plan: QueueDragPlan | null;
  /** Where each carried card is drawn, in pixels from where it began. */
  painted: Map<string, number>;
  /** The previous frame's timestamp, so the pursuit is frame-rate independent. */
  lastFrame: number;
  /** Set by a render: the rows may have changed height and need re-reading. */
  remeasure: boolean;
  reduceMotion: boolean;
  frame: number | null;
};

/** Where every row was drawn at the moment the gesture ended. */
type Landing = { members: Set<string>; from: Map<string, number> };

export type QueueSortable = {
  /** The order a release would commit, or null when nothing is being dragged. */
  previewOrder: string[] | null;
  /** Collects the row elements the model measures. */
  registerRow: (id: string) => (element: HTMLLIElement | null) => void;
  /**
   * Wire to the drag handle's `onPointerDown`.
   *
   * `block` names every row the press should carry, the held one included; it
   * defaults to the held row alone. Rows the list does not hold are ignored,
   * so a stale selection cannot start a gesture the queue cannot finish.
   */
  startDrag: (
    event: ReactPointerEvent<HTMLElement>,
    id: string,
    block?: readonly string[],
  ) => void;
  /** Inline style for a row: its transform, and nothing else. */
  rowStyle: (id: string) => CSSProperties | undefined;
  /** True while this row is one of the rows being carried. */
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
    members: Set<string>;
    order: string[];
    shifts: Map<string, number>;
  } | null>(null);
  /** The rows currently flying into the places they were dropped. */
  const [settling, setSettling] = useState<ReadonlySet<string> | null>(null);

  const rowsRef = useRef(new Map<string, HTMLLIElement>());
  const sessionRef = useRef<Session | null>(null);
  const idsRef = useRef(ids);
  /** The landing animations in flight, so a second gesture can cancel them. */
  const flightRef = useRef(new Map<string, Animation>());
  /** Rects captured at the end of a gesture, waiting for the render to land. */
  const landingRef = useRef<Landing | null>(null);
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

  /** Stops any landing still playing, so a new gesture starts from rest. */
  const stopLandings = useCallback(() => {
    for (const animation of flightRef.current.values()) animation.cancel();
    flightRef.current.clear();
  }, []);

  /**
   * The list's geometry, in layout coordinates.
   *
   * `offsetTop` and `offsetHeight` are read rather than the bounding rect
   * because they ignore transforms: the rows are all displaced by this very
   * gesture, and measuring what is on screen would feed the drag's own output
   * back into its input. It also means the geometry can be re-read at any
   * moment — which it has to be, because the page polls once a second and a
   * card whose progress bar wraps onto a second line is a card whose
   * neighbours have all moved.
   */
  const measure = useCallback((session: Session) => {
    const rects: SortableRect[] = [];
    for (const id of idsRef.current) {
      const node = rowsRef.current.get(id);
      if (!node) continue;
      rects.push({ id, top: node.offsetTop, height: node.offsetHeight });
    }
    if (rects.length < 2) return false;
    session.rects = rects;
    return true;
  }, []);

  /** Re-plans from the pointer, and tells React only when something moved. */
  const replan = useCallback((session: Session, force = false) => {
    const plan = planQueueDrag(
      session.rects,
      session.members,
      session.offsetY,
      session.activeId,
    );
    if (!plan) return;
    const changed = force || plan.index !== session.index;
    session.plan = plan;
    if (!changed) return;
    session.index = plan.index;
    session.order = plan.order;
    setDrag({
      activeId: session.activeId,
      members: new Set(session.members),
      order: plan.order,
      shifts: plan.shifts,
    });
  }, []);

  const stopFrame = useCallback((session: Session) => {
    if (session.frame !== null) {
      cancelAnimationFrame(session.frame);
      session.frame = null;
    }
  }, []);

  /** Releases everything the gesture took hold of, whatever its outcome. */
  const teardown = useCallback(
    (session: Session) => {
      stopFrame(session);
      for (const id of session.members) {
        const node = rowsRef.current.get(id);
        if (!node) continue;
        node.style.willChange = "";
        node.style.transition = "";
        /*
         * Cleared before the cards are handed back to React. The landing plays
         * from where they were *measured*, a moment ago and by the caller, so
         * nothing is lost by putting them back in their slots here.
         */
        node.style.transform = "";
      }
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      sessionRef.current = null;
      setDrag(null);
      handlersRef.current.onDragEnd?.();
    },
    [stopFrame],
  );

  /**
   * Ends the gesture, and hands the landing to the layout effect below.
   *
   * Both outcomes are the same problem — every row is drawn somewhere, and in
   * a moment React will have put them all somewhere else — so both are solved
   * the same way: read where they are now, let the render happen, and animate
   * the difference. A commit has moved the rows in the DOM and a cancel has
   * not, and neither this function nor the effect has to know which.
   */
  const finish = useCallback(
    (session: Session) => {
      const members = new Set(session.members);
      const from = new Map<string, number>();
      for (const [id, node] of rowsRef.current) {
        from.set(id, node.getBoundingClientRect().top);
      }
      landingRef.current = { members, from };
      teardown(session);
      setSettling(members);
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
    finish(session);
  }, [finish, teardown]);

  /**
   * The landing itself, played after the render that rearranged the list.
   *
   * Every row that moved is put back where the eye last saw it and animated
   * from there, on the compositor, in one pass. The animations are the Web
   * Animations API rather than a transition so that the first frame is the
   * *old* position: an inline transform written here and cleared next frame
   * gives the browser a chance to paint the new one in between, and that one
   * frame is the flicker this replaced.
   */
  useLayoutEffect(() => {
    const landing = landingRef.current;
    if (!landing) return;
    landingRef.current = null;
    const reduce = prefersReducedMotion();
    let last: Animation | null = null;
    for (const [id, node] of rowsRef.current) {
      const before = landing.from.get(id);
      if (before === undefined) continue;
      const delta = before - node.getBoundingClientRect().top;
      const isHeld = landing.members.has(id);
      // A carried card is always animated, even when it lands where it was
      // picked up: its lift has to come off over the same moment.
      if (!isHeld && Math.abs(delta) < 0.5) continue;
      flightRef.current.get(id)?.cancel();
      flightRef.current.delete(id);
      if (reduce || typeof node.animate !== "function") continue;
      const lift = isHeld ? ` scale(${LIFT_SCALE})` : "";
      const animation = node.animate(
        [
          { transform: `translate3d(0, ${delta}px, 0)${lift}` },
          { transform: "translate3d(0, 0, 0) scale(1)" },
        ],
        { duration: SLIDE_MS, easing: SLIDE_EASING },
      );
      flightRef.current.set(id, animation);
      void animation.finished
        .then(() => {
          if (flightRef.current.get(id) === animation) {
            flightRef.current.delete(id);
          }
        })
        .catch(() => {});
      if (isHeld) last = animation;
    }
    /*
     * The lift stays on until the cards have actually arrived. Taking it off at
     * the release instead is what made a drop read as the card being dropped
     * *and* something else sliding into place.
     */
    const done = () =>
      setSettling((current) => (current === landing.members ? null : current));
    if (last) void last.finished.then(done).catch(() => {});
    else done();
  });

  /*
   * A render may have changed the rows' heights — the page polls once a second
   * — so the geometry is marked stale and re-read on the next frame rather
   * than on every frame, which would cost a forced layout per frame for
   * nothing.
   */
  useLayoutEffect(() => {
    const session = sessionRef.current;
    if (session?.started) session.remeasure = true;
  });

  /** One frame: the edge scroll, the pursuit, and the single paint. */
  const runFrame = useCallback(
    (session: Session, now: number) => {
      /*
       * Everything below is scaled by the time the frame actually took rather
       * than assuming sixty of them a second. A background tab, a slow machine
       * or a browser that has throttled its animations then produces the same
       * gesture at a lower sample rate, instead of a card that crawls and a
       * page that will not scroll.
       */
      const elapsed = Math.min(Math.max(now - session.lastFrame, 0), 1000);
      session.lastFrame = now;
      const velocity = edgeScrollVelocity(
        session.lastClientY,
        window.innerHeight,
      );
      let moved = false;
      if (velocity !== 0) {
        const before = window.scrollY;
        // The model speaks in pixels per frame at sixty a second. A long frame
        // is worth several of them — but only so many, or one stalled frame
        // would throw the page across the document.
        window.scrollBy(0, (velocity * Math.min(elapsed, 100)) / FRAME_MS);
        if (window.scrollY !== before) {
          // The pointer has not moved; the page under it has.
          session.offsetY =
            session.lastClientY + window.scrollY - session.startPageY;
          moved = true;
        }
      }
      if (session.remeasure) {
        session.remeasure = false;
        // Fresh geometry moves every row's slot, so React is told even when
        // the index the drop would use has not changed.
        if (measure(session)) replan(session, true);
      } else if (moved) {
        replan(session);
      }

      const block = session.plan?.magneticOffset ?? session.offsetY;
      const alpha = session.reduceMotion
        ? 1
        : 1 - Math.exp(-elapsed / FOLLOW_MS);
      for (const id of session.members) {
        /*
         * Each carried row pursues its own place in the block. They all move
         * with the same constant towards targets that differ by a fixed
         * distance, so the block travels as one — and a selection that was
         * scattered down the queue gathers into it rather than appearing
         * already stacked.
         */
        const target = block + (session.plan?.memberAnchors.get(id) ?? 0);
        const painted = session.painted.get(id) ?? 0;
        const next =
          Math.abs(target - painted) < 0.1
            ? target
            : painted + (target - painted) * alpha;
        session.painted.set(id, next);
        const node = rowsRef.current.get(id);
        if (node) {
          node.style.transform = `translate3d(0, ${next}px, 0) scale(${LIFT_SCALE})`;
        }
      }
    },
    [measure, replan],
  );

  const runLoop = useCallback(
    (session: Session) => {
      const step = (now: number) => {
        session.frame = null;
        if (sessionRef.current !== session || !session.started) return;
        runFrame(session, now);
        session.frame = requestAnimationFrame(step);
      };
      session.frame = requestAnimationFrame(step);
    },
    [runFrame],
  );

  /** A press that has travelled far enough becomes a drag, once. */
  const begin = useCallback(
    (session: Session) => {
      if (!measure(session)) return false;
      session.started = true;
      session.order = session.rects.map((rect) => rect.id);
      /*
       * The block, in the list's own order and holding only rows the list
       * still has. A selection is a set the operator built over time and the
       * queue has moved on since — a job that started encoding while the boxes
       * were being ticked is no longer something a drag can carry.
       */
      const held = new Set(session.members);
      session.members = session.order.filter((id) => held.has(id));
      if (!session.members.includes(session.activeId)) {
        session.members = [session.activeId];
      }
      session.index = session.order.indexOf(session.members[0]!);
      session.painted = new Map(session.members.map((id) => [id, 0]));
      session.lastFrame = performance.now();
      session.reduceMotion = prefersReducedMotion();
      document.body.style.userSelect = "none";
      document.body.style.cursor = "grabbing";
      for (const id of session.members) {
        const node = rowsRef.current.get(id);
        if (!node) continue;
        node.style.willChange = "transform";
        /*
         * No transition, deliberately. The cards' positions are written afresh
         * every frame by the pursuit above, and a transition on top of that is
         * an animation towards a target that has already moved — which is what
         * made the card lag the hand and then lurch when it caught up.
         */
        node.style.transition = "none";
      }
      handlersRef.current.onDragStart?.([...session.order]);
      setDrag({
        activeId: session.activeId,
        members: new Set(session.members),
        order: [...session.order],
        shifts: new Map(),
      });
      return true;
    },
    [measure],
  );

  const startDrag = useCallback(
    (
      event: ReactPointerEvent<HTMLElement>,
      id: string,
      block?: readonly string[],
    ) => {
      if (disabled || event.button !== 0 || sessionRef.current) return;
      if (!idsRef.current.includes(id)) return;
      // Keeps the press from selecting the text of the card underneath it.
      event.preventDefault();
      // ...but the handle still has to take focus, or a press would cost the
      // keyboard user the arrow keys that move the row without a mouse.
      event.currentTarget.focus?.();
      /*
       * A card grabbed while the last one is still landing: the animation owns
       * the transform property until it is stopped, and a gesture painting
       * underneath it would move nothing at all.
       */
      stopLandings();
      setSettling(null);
      const carried = block && block.includes(id) ? [...new Set(block)] : [id];
      const session: Session = {
        activeId: id,
        members: carried,
        pointerId: event.pointerId,
        rects: [],
        startPageY: event.clientY + window.scrollY,
        lastClientY: event.clientY,
        offsetY: 0,
        started: false,
        index: -1,
        order: [],
        plan: null,
        painted: new Map(),
        lastFrame: 0,
        remeasure: false,
        reduceMotion: false,
        frame: null,
      };
      sessionRef.current = session;
    },
    [disabled, stopLandings],
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
        runLoop(session);
      }
      event.preventDefault();
      /*
       * Planned here rather than on the next frame: the slot a release would
       * use is the one thing on screen that must never lag the pointer, and it
       * is only ever a few comparisons. The drawing of it waits for the frame.
       */
      replan(session);
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
       * the same render as the landing's captured positions is what makes the
       * drop read as the card landing rather than as the list blinking.
       */
      if (!unchanged) handlersRef.current.onCommit([...order]);
      finish(session);
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
  }, [begin, cancelDrag, finish, replan, runLoop, teardown]);

  /* A page that unmounts mid-drag must not leave the body unselectable. */
  useEffect(
    () => () => {
      const session = sessionRef.current;
      if (session) {
        stopFrame(session);
        document.body.style.userSelect = "";
        document.body.style.cursor = "";
        sessionRef.current = null;
      }
      stopLandings();
    },
    [stopFrame, stopLandings],
  );

  const rowStyle = useCallback(
    (id: string): CSSProperties | undefined => {
      if (drag) {
        if (drag.members.has(id)) {
          /*
           * The transform is written straight to the node while dragging, so
           * it is deliberately absent here: naming it would hand the card back
           * to React and cost a render of the whole page on every frame.
           */
          return {
            position: "relative",
            // The row the hand is on rides above the rest of its own block.
            zIndex: id === drag.activeId ? 30 : 29,
          };
        }
        const shift = drag.shifts.get(id);
        return {
          transform: shift ? `translate3d(0, ${shift}px, 0)` : undefined,
          transition: reflowTransition(),
        };
      }
      /*
       * Nothing is named during a landing either. The rows are being animated
       * off their own positions by the effect above, and an inline transform
       * or transition alongside that is a second opinion the browser has to
       * resolve mid-flight.
       */
      if (settling?.has(id)) return { position: "relative", zIndex: 20 };
      return undefined;
    },
    [drag, settling],
  );

  return {
    previewOrder: drag?.order ?? null,
    registerRow,
    startDrag,
    rowStyle,
    isActive: useCallback(
      (id: string) => drag?.members.has(id) ?? false,
      [drag],
    ),
    isSettling: useCallback(
      (id: string) => settling?.has(id) ?? false,
      [settling],
    ),
    cancel: cancelDrag,
  };
}
