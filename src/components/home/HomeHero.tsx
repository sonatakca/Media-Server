import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import {
  AnimatePresence,
  animate,
  motion,
  useMotionValue,
  useReducedMotion,
  type AnimationPlaybackControls,
} from "framer-motion";
import { useNavigate } from "react-router-dom";
import {
  ChevronLeft,
  ChevronRight,
  Info,
  Pause,
  Play,
  RotateCcw,
  Video,
  VideoOff,
  Volume2,
  VolumeX,
} from "lucide-react";
import { useLanguage } from "../../i18n/LanguageContext";
import { formatRuntime } from "../../lib/format";
import { getItemDisplayMetadata } from "../../lib/itemMetadataPreferences";
import {
  claimBottomChrome,
  releaseBottomChrome,
} from "../../lib/layout/bottomChrome";
import { getHeroPreviewUrl } from "../../lib/mediaApi";
import { getPlayTargetForItem } from "../../lib/playTarget";
import { getRouteForItem } from "../../lib/routes";
import { getSmartContinueWatchingItems } from "../../lib/smartContinueWatching";
import type { MediaItem } from "../../lib/types";
import { WATCH_STATUS_CHANGED_EVENT } from "../../lib/watchedStatusActions";
import { ButtonLink } from "../Button";
import { FavouriteButton } from "../FavouriteButton";
import { canStartOverFromHero } from "../HeroSection";
import {
  readHeroTrailersEnabledPreference,
  saveHeroTrailersEnabledPreference,
} from "../hero/heroModel";
import { Tooltip } from "../ui/Tooltip";
import {
  HeroComposition,
  TITLE_BOX,
  createCompositionMotion,
  type CompositionMotion,
} from "./HeroComposition";
import {
  HERO_DWELL_MS,
  HERO_MOTION,
  HERO_TRAILER_DELAY_MS,
  droppedPlacement,
  offstagePlacement,
  previousIndex,
  pushedBackPlacement,
  queueIndices,
  queueSlots,
  slotPlacement,
  stagePlacement,
  travelDurationS,
  type Placement,
  type StageSize,
} from "./homeHeroModel";

/**
 * The home page's hero: a stage with its queue in view.
 *
 * The title on stage fills the frame; the next three wait bottom-right as the
 * same compositions, scaled down. When a title's time is up the first of them
 * lifts out of the queue and grows over the stage while the one it replaces
 * recedes beneath it, and the queue closes up behind, a newcomer sliding in
 * from beyond the frame's edge. Going back is the same move reversed: the
 * title on stage shrinks back into the head of the queue, uncovering the one
 * before it. Nothing is swapped in place; every change is something moving
 * from where it was to where it goes.
 */

type Role = "stage" | "under" | "rising" | "queue" | "leaving";

interface Layer {
  id: string;
  role: Role;
}

const Z: Record<Role, number> = {
  under: 1,
  stage: 2,
  rising: 3,
  queue: 4,
  leaving: 4,
};

/** The queue's resting shade; a hovered miniature lifts it. */
const QUEUE_DIM = 0.22;

/** Space kept above the controls for the notification pile. */
const CHROME_CLEARANCE_PX = 14;

interface HomeHeroProps {
  items: MediaItem[];
  onReady?: () => void;
}

function uniqueById(items: MediaItem[]): MediaItem[] {
  const seen = new Set<string>();
  return items.filter((item) =>
    seen.has(item.Id) ? false : (seen.add(item.Id), true),
  );
}

function wait(ms: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, ms));
}

function run(controls: AnimationPlaybackControls): Promise<void> {
  return controls.finished.then(
    () => undefined,
    () => undefined,
  );
}

function useSmartContinueItems(): MediaItem[] {
  const [items, setItems] = useState<MediaItem[]>([]);
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      void getSmartContinueWatchingItems()
        .then((next) => {
          if (!cancelled) setItems(next);
        })
        .catch(() => undefined);
    load();
    window.addEventListener(WATCH_STATUS_CHANGED_EVENT, load);
    return () => {
      cancelled = true;
      window.removeEventListener(WATCH_STATUS_CHANGED_EVENT, load);
    };
  }, []);
  return items;
}

export function HomeHero({ items: rawItems, onReady }: HomeHeroProps) {
  const { language, t } = useLanguage();
  const reduceMotion = Boolean(useReducedMotion());
  // The page recomputes its pool as the catalogue arrives, often to the same
  // titles in the same order. The hero keys on which titles, not on which
  // array, or every recomputation would restart it.
  const itemsKey = rawItems.map((item) => item.Id).join("|");
  const itemsRef = useRef<MediaItem[]>([]);
  const items = useMemo(() => {
    itemsRef.current = uniqueById(rawItems);
    return itemsRef.current;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemsKey]);
  const total = items.length;
  const itemsById = useMemo(
    () => new Map(items.map((item) => [item.Id, item])),
    [items],
  );

  const sectionRef = useRef<HTMLElement>(null);
  const [stage, setStage] = useState<StageSize | null>(null);
  const stageRef = useRef<StageSize | null>(null);
  const [stageIndex, setStageIndex] = useState(0);
  const stageIndexRef = useRef(0);
  const [layers, setLayers] = useState<Layer[]>([]);
  const motions = useRef(new Map<string, CompositionMotion>());
  const busyRef = useRef(false);
  const [copyItemId, setCopyItemId] = useState<string | null>(null);
  const [hasOpened, setHasOpened] = useState(false);
  const [isTravelling, setIsTravelling] = useState(false);
  const readyRef = useRef(false);

  const [isPaused, setIsPaused] = useState(false);
  const [isInView, setIsInView] = useState(true);
  const [isDocumentVisible, setIsDocumentVisible] = useState(
    typeof document === "undefined" ? true : !document.hidden,
  );
  const progress = useMotionValue(0);
  const gate = useMotionValue(
    reduceMotion ? "inset(0% 0% 0% 0%)" : "inset(50% 0% 50% 0%)",
  );

  const [areTrailersEnabled, setAreTrailersEnabled] = useState(
    readHeroTrailersEnabledPreference,
  );
  const [trailerUrl, setTrailerUrl] = useState<string | null>(null);
  const [isTrailerPlaying, setIsTrailerPlaying] = useState(false);
  const [isTrailerMuted, setIsTrailerMuted] = useState(true);
  const trailerDoneRef = useRef(false);
  /** Titles whose trailer has already played on this visit to the page. */
  const trailersSeen = useRef(new Set<string>());

  const stageItem = items[stageIndex];
  // Once for the hero, not once per title: each title's copy asking again put
  // a page-loading bar on screen at every change.
  const smartContinueItems = useSmartContinueItems();

  // ---------------------------------------------------------------- measure
  useLayoutEffect(() => {
    const section = sectionRef.current;
    if (!section) return undefined;
    const measure = () => {
      const next = { width: section.clientWidth, height: section.clientHeight };
      stageRef.current = next;
      setStage((current) =>
        current &&
        current.width === next.width &&
        current.height === next.height
          ? current
          : next,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(section);
    return () => observer.disconnect();
  }, []);

  const motionFor = useCallback((id: string, placement: Placement, dim = 0) => {
    let entry = motions.current.get(id);
    if (!entry) {
      entry = createCompositionMotion(placement, dim);
      motions.current.set(id, entry);
    }
    return entry;
  }, []);

  const place = (entry: CompositionMotion, placement: Placement) => {
    entry.x.set(placement.x);
    entry.y.set(placement.y);
    entry.scale.set(placement.scale);
  };

  // ------------------------------------------------- a new pool, or first run
  const stageReady = stage !== null;
  useEffect(() => {
    const size = stageRef.current;
    if (!size || total === 0) return;
    const slots = queueSlots(size);

    // Once the hero has opened, a new pool never restarts it: the pool grows
    // as the catalogue arrives, usually a few seconds in, and whatever is on
    // stage stays there while the queue re-forms around it.
    if (readyRef.current) {
      const currentId = layers.find((layer) => layer.role === "stage")?.id;
      const kept = currentId
        ? items.findIndex((item) => item.Id === currentId)
        : -1;
      const index = kept >= 0 ? kept : 0;
      const queueIds = queueIndices(index, total).map((i) => items[i]!.Id);
      const stageId = items[index]!.Id;
      for (const id of [...motions.current.keys()]) {
        if (id !== stageId && !queueIds.includes(id))
          motions.current.delete(id);
      }
      motionFor(stageId, stagePlacement());
      queueIds.forEach((id, position) => {
        const target = slotPlacement(size, slots[position]!);
        const existing = motions.current.get(id);
        if (existing) {
          const options = {
            duration: reduceMotion ? 0 : HERO_MOTION.shiftS,
            ease: HERO_MOTION.settleEase,
          };
          void animate(existing.x, target.x, options);
          void animate(existing.y, target.y, options);
          void animate(existing.scale, target.scale, options);
        } else {
          const entry = motionFor(id, target, 1);
          void animate(entry.dim, QUEUE_DIM, {
            duration: reduceMotion ? 0 : 0.6,
            ease: "linear",
          });
        }
      });
      stageIndexRef.current = index;
      setStageIndex(index);
      setLayers([
        { id: stageId, role: "stage" },
        ...queueIds.map((id) => ({ id, role: "queue" as Role })),
      ]);
      return;
    }

    busyRef.current = false;
    motions.current.clear();
    stageIndexRef.current = 0;
    setStageIndex(0);
    const queue = queueIndices(0, total);
    const first = items[0]!;
    motionFor(first.Id, stagePlacement());
    queue.forEach((index, position) => {
      motionFor(items[index]!.Id, droppedPlacement(size, slots[position]!), 1);
    });
    setLayers([
      { id: first.Id, role: "stage" },
      ...queue.map((index) => ({
        id: items[index]!.Id,
        role: "queue" as Role,
      })),
    ]);
    setCopyItemId(null);
    progress.set(0);
    // Only a different pool (or the first measurement) re-forms the hero;
    // `layers` is read, not followed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, stageReady]);

  // A resize moves everything to where it now belongs, without animating.
  useEffect(() => {
    if (!stage || busyRef.current) return;
    const slots = queueSlots(stage);
    const queue = queueIndices(stageIndexRef.current, total);
    const stageId = items[stageIndexRef.current]?.Id;
    if (stageId) {
      const entry = motions.current.get(stageId);
      if (entry) place(entry, stagePlacement());
    }
    if (!hasOpened) return;
    queue.forEach((index, position) => {
      const entry = motions.current.get(items[index]!.Id);
      if (entry) place(entry, slotPlacement(stage, slots[position]!));
    });
  }, [hasOpened, items, stage, total]);

  // ------------------------------------------------------------ the opening
  const open = useCallback(async () => {
    const size = stageRef.current;
    if (!size || hasOpened || busyRef.current) return;
    busyRef.current = true;
    const slots = queueSlots(size);
    const queue = queueIndices(0, total);
    const first = items[0];
    if (first && !reduceMotion) {
      const entry = motions.current.get(first.Id);
      entry?.drift.set(1.04);
      if (entry) {
        void animate(entry.drift, 1, {
          duration: HERO_MOTION.gateOpenS * 1.6,
          ease: HERO_MOTION.settleEase,
        });
      }
    }
    const gateOpening = animate(gate, "inset(0% 0% 0% 0%)", {
      duration: reduceMotion ? 0 : HERO_MOTION.gateOpenS,
      ease: HERO_MOTION.travelEase,
    });
    window.setTimeout(
      () => setCopyItemId(first?.Id ?? null),
      reduceMotion ? 0 : HERO_MOTION.gateOpenS * 650,
    );
    queue.forEach((index, position) => {
      const entry = motions.current.get(items[index]!.Id);
      if (!entry) return;
      const target = slotPlacement(size, slots[position]!);
      const delay = reduceMotion
        ? 0
        : HERO_MOTION.gateOpenS * 0.7 + position * 0.09;
      void animate(entry.y, target.y, {
        duration: reduceMotion ? 0 : 0.9,
        delay,
        ease: HERO_MOTION.settleEase,
      });
      entry.x.set(target.x);
      entry.scale.set(target.scale);
      void animate(entry.dim, QUEUE_DIM, {
        duration: reduceMotion ? 0 : 0.7,
        delay,
        ease: "linear",
      });
    });
    await run(gateOpening);
    await wait(reduceMotion ? 0 : 700);
    setHasOpened(true);
    busyRef.current = false;
  }, [gate, hasOpened, items, reduceMotion, total]);

  const handleArtworkReady = useCallback(
    (id: string) => {
      if (id !== items[0]?.Id || readyRef.current) return;
      readyRef.current = true;
      onReady?.();
      void open();
    },
    [items, onReady, open],
  );

  // ------------------------------------------------------------ travelling
  const travel = useCallback(
    async (direction: "forward" | "backward", queuePosition = 0) => {
      const size = stageRef.current;
      if (!size || busyRef.current || total < 2 || !hasOpened) return;
      busyRef.current = true;
      setIsTravelling(true);
      setIsTrailerPlaying(false);
      progress.set(0);

      const fromIndex = stageIndexRef.current;
      const oldQueue = queueIndices(fromIndex, total);
      const toIndex =
        direction === "forward"
          ? oldQueue[Math.min(queuePosition, oldQueue.length - 1)]!
          : previousIndex(fromIndex, total);
      const newQueue = queueIndices(toIndex, total);
      const slots = queueSlots(size);
      const outgoing = items[fromIndex]!;
      const incoming = items[toIndex]!;
      const newQueueIds = newQueue.map((index) => items[index]!.Id);
      const oldQueueIds = oldQueue.map((index) => items[index]!.Id);

      // Copy leaves first, a line at a time, so the frame is clear to move.
      setCopyItemId(null);
      await wait(reduceMotion ? 0 : 140);

      const animations: Array<Promise<void>> = [];
      const shift = (id: string, position: number) => {
        const entry = motions.current.get(id);
        if (!entry) return;
        const target = slotPlacement(size, slots[position]!);
        const from = {
          x: entry.x.get(),
          y: entry.y.get(),
          scale: entry.scale.get(),
        };
        const duration = reduceMotion
          ? 0
          : travelDurationS(size, from, target, HERO_MOTION.shiftS);
        const options = {
          duration,
          delay: reduceMotion ? 0 : HERO_MOTION.shiftDelayS,
          ease: HERO_MOTION.settleEase,
        };
        animations.push(run(animate(entry.x, target.x, options)));
        void animate(entry.y, target.y, options);
        void animate(entry.scale, target.scale, options);
        void animate(entry.dim, QUEUE_DIM, options);
      };
      const enterFromEdge = (id: string, position: number) => {
        const entry = motionFor(id, offstagePlacement(size), QUEUE_DIM);
        place(entry, offstagePlacement(size));
        entry.dim.set(QUEUE_DIM);
        entry.drift.set(1);
        entry.titleScale.set(1);
        const target = slotPlacement(size, slots[position]!);
        const duration = reduceMotion
          ? 0
          : travelDurationS(
              size,
              offstagePlacement(size),
              target,
              HERO_MOTION.shiftS,
            );
        const options = {
          duration,
          delay: reduceMotion ? 0 : HERO_MOTION.enterDelayS,
          ease: HERO_MOTION.settleEase,
        };
        animations.push(run(animate(entry.x, target.x, options)));
        void animate(entry.y, target.y, options);
        void animate(entry.scale, target.scale, options);
      };

      if (direction === "forward") {
        const skipped = oldQueueIds.slice(
          0,
          Math.min(queuePosition, oldQueueIds.length),
        );
        const leaving = oldQueueIds.filter(
          (id) => id !== incoming.Id && !newQueueIds.includes(id),
        );
        setLayers([
          { id: outgoing.Id, role: "under" },
          { id: incoming.Id, role: "rising" },
          ...newQueueIds
            .filter((id) => id !== outgoing.Id)
            .map((id) => ({ id, role: "queue" as Role })),
          ...leaving.map((id) => ({ id, role: "leaving" as Role })),
        ]);

        // The incoming title grows out of its slot over the stage.
        const rising = motions.current.get(incoming.Id)!;
        const from = {
          x: rising.x.get(),
          y: rising.y.get(),
          scale: rising.scale.get(),
        };
        const duration = reduceMotion
          ? 0
          : travelDurationS(size, from, stagePlacement());
        const travelOptions = { duration, ease: HERO_MOTION.travelEase };
        rising.drift.set(1);
        animations.push(run(animate(rising.x, 0, travelOptions)));
        void animate(rising.y, 0, travelOptions);
        void animate(rising.scale, 1, travelOptions);
        void animate(rising.dim, 0, {
          duration: duration * 0.6,
          ease: "linear",
        });

        // The outgoing one recedes beneath it.
        const under = motions.current.get(outgoing.Id)!;
        const back = pushedBackPlacement(size);
        void animate(under.x, back.x, travelOptions);
        void animate(under.y, back.y, travelOptions);
        void animate(under.scale, back.scale, travelOptions);
        void animate(under.dim, HERO_MOTION.pushBackDim, travelOptions);

        // Titles jumped over drop out of the queue; the rest close up.
        for (const id of leaving) {
          const entry = motions.current.get(id);
          const position = oldQueueIds.indexOf(id);
          if (!entry || position < 0) continue;
          const target = droppedPlacement(size, slots[position]!);
          const options = {
            duration: reduceMotion ? 0 : 0.6,
            ease: HERO_MOTION.travelEase,
          };
          void animate(entry.y, target.y, options);
          void animate(entry.dim, 1, options);
        }
        newQueueIds.forEach((id, position) => {
          if (id === outgoing.Id) return;
          if (oldQueueIds.includes(id)) shift(id, position);
          else enterFromEdge(id, position);
        });
        void skipped;

        await Promise.all(animations);

        // The outgoing title, if it is due again soon, joins the queue's end.
        const outgoingPosition = newQueueIds.indexOf(outgoing.Id);
        if (outgoingPosition >= 0) {
          setLayers((current) => [
            ...current.filter((layer) => layer.id !== outgoing.Id),
            { id: outgoing.Id, role: "queue" },
          ]);
          enterFromEdge(outgoing.Id, outgoingPosition);
          await Promise.all(animations);
        }
      } else {
        // Backward: the title on stage shrinks back into the head of the
        // queue, uncovering the one before it, which comes forward.
        const previous = motionFor(
          incoming.Id,
          pushedBackPlacement(size),
          HERO_MOTION.pushBackDim,
        );
        place(previous, pushedBackPlacement(size));
        previous.dim.set(HERO_MOTION.pushBackDim);
        previous.drift.set(1);
        previous.titleScale.set(1);
        const leavingId = oldQueueIds.find((id) => !newQueueIds.includes(id));
        setLayers([
          { id: incoming.Id, role: "stage" },
          { id: outgoing.Id, role: "rising" },
          ...oldQueueIds
            .filter((id) => id !== leavingId && id !== incoming.Id)
            .map((id) => ({ id, role: "queue" as Role })),
          ...(leavingId ? [{ id: leavingId, role: "leaving" as Role }] : []),
        ]);
        const shrinking = motions.current.get(outgoing.Id)!;
        const target = slotPlacement(size, slots[0]!);
        const duration = reduceMotion
          ? 0
          : travelDurationS(size, stagePlacement(), target);
        const travelOptions = { duration, ease: HERO_MOTION.travelEase };
        animations.push(run(animate(shrinking.x, target.x, travelOptions)));
        void animate(shrinking.y, target.y, travelOptions);
        void animate(shrinking.scale, target.scale, travelOptions);
        void animate(shrinking.dim, QUEUE_DIM, travelOptions);
        void animate(shrinking.drift, 1, travelOptions);
        void animate(shrinking.titleScale, 1, travelOptions);
        void animate(previous.x, 0, travelOptions);
        void animate(previous.y, 0, travelOptions);
        void animate(previous.scale, 1, travelOptions);
        void animate(previous.dim, 0, travelOptions);
        oldQueueIds.forEach((id, position) => {
          if (id === leavingId || id === incoming.Id) return;
          shift(id, position + 1);
        });
        if (leavingId) {
          const entry = motions.current.get(leavingId);
          if (entry) {
            const edge = offstagePlacement(size);
            const options = {
              duration: reduceMotion ? 0 : HERO_MOTION.shiftS,
              delay: reduceMotion ? 0 : HERO_MOTION.shiftDelayS,
              ease: HERO_MOTION.settleEase,
            };
            animations.push(run(animate(entry.x, edge.x, options)));
          }
        }
        await Promise.all(animations);
      }

      // Settle: the incoming title owns the stage; everything else is queue.
      for (const [id] of motions.current) {
        if (id !== incoming.Id && !newQueueIds.includes(id))
          motions.current.delete(id);
      }
      setLayers([
        { id: incoming.Id, role: "stage" },
        ...newQueueIds.map((id) => ({ id, role: "queue" as Role })),
      ]);
      stageIndexRef.current = toIndex;
      setStageIndex(toIndex);
      setCopyItemId(incoming.Id);
      setIsTravelling(false);
      busyRef.current = false;
    },
    [hasOpened, items, motionFor, progress, reduceMotion, total],
  );

  // ------------------------------------------------------------- the clock
  const isRunning =
    hasOpened &&
    !isPaused &&
    isInView &&
    isDocumentVisible &&
    !isTravelling &&
    !isTrailerPlaying &&
    total > 1;

  useEffect(() => {
    if (!isRunning) return undefined;
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const next = progress.get() + (now - last) / HERO_DWELL_MS;
      last = now;
      progress.set(Math.min(1, next));
      if (next >= 1) {
        void travel("forward");
        return;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [isRunning, progress, travel]);

  // The slow push-in, for as long as a title holds the stage.
  useEffect(() => {
    if (!stageItem || reduceMotion || !hasOpened) return undefined;
    const entry = motions.current.get(stageItem.Id);
    if (!entry) return undefined;
    const controls = animate(entry.drift, HERO_MOTION.drift, {
      duration: (HERO_DWELL_MS + 4_000) / 1_000,
      ease: "linear",
    });
    return () => controls.stop();
  }, [hasOpened, reduceMotion, stageItem]);

  useEffect(() => {
    const section = sectionRef.current;
    if (!section) return undefined;
    const observer = new IntersectionObserver(
      ([entry]) =>
        setIsInView(
          Boolean(entry?.isIntersecting && entry.intersectionRatio > 0.35),
        ),
      { threshold: [0, 0.35, 0.6] },
    );
    observer.observe(section);
    const onVisibility = () => setIsDocumentVisible(!document.hidden);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  // ----------------------------------------------------------- the trailer
  useEffect(() => {
    let cancelled = false;
    setTrailerUrl(null);
    setIsTrailerPlaying(false);
    trailerDoneRef.current = stageItem
      ? trailersSeen.current.has(stageItem.Id)
      : false;
    if (!stageItem) return undefined;
    void getHeroPreviewUrl(stageItem)
      .then((url) => {
        if (!cancelled) setTrailerUrl(url);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [stageItem]);

  // Artwork and copy first; then, if there is a trailer, the title steps back
  // and the picture starts moving.
  useEffect(() => {
    if (!trailerUrl || !areTrailersEnabled || trailerDoneRef.current)
      return undefined;
    const unsubscribe = progress.on("change", (value) => {
      if (
        value >= HERO_TRAILER_DELAY_MS / HERO_DWELL_MS &&
        !trailerDoneRef.current
      ) {
        trailerDoneRef.current = true;
        if (stageItem) trailersSeen.current.add(stageItem.Id);
        setIsTrailerPlaying(true);
      }
    });
    return unsubscribe;
  }, [areTrailersEnabled, progress, stageItem, trailerUrl]);

  useEffect(() => {
    if (!stageItem) return;
    const entry = motions.current.get(stageItem.Id);
    if (!entry) return;
    const options = {
      duration: reduceMotion ? 0 : 1.2,
      ease: HERO_MOTION.travelEase,
    };
    void animate(entry.trailer, isTrailerPlaying ? 1 : 0, options);
    void animate(entry.titleScale, isTrailerPlaying ? 0.58 : 1, options);
    if (isTrailerPlaying) setCopyItemId(null);
    else if (!busyRef.current && hasOpened) setCopyItemId(stageItem.Id);
  }, [hasOpened, isTrailerPlaying, reduceMotion, stageItem]);

  const endTrailer = useCallback(() => setIsTrailerPlaying(false), []);

  // ------------------------------------------ sharing the bottom-right corner
  const claimId = useId();
  const controlsTopRef = useRef(0);
  useEffect(() => {
    const update = () => {
      const section = sectionRef.current;
      if (!section || !hasOpened) {
        releaseBottomChrome(claimId);
        return;
      }
      const top = section.getBoundingClientRect().top + controlsTopRef.current;
      const occupied = window.innerHeight - top;
      if (occupied <= 0 || top < 0) releaseBottomChrome(claimId);
      else
        claimBottomChrome(claimId, Math.round(occupied + CHROME_CLEARANCE_PX));
    };
    update();
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      releaseBottomChrome(claimId);
    };
  }, [claimId, hasOpened, stage]);

  // --------------------------------------------------------------- render
  const slots = stage ? queueSlots(stage) : [];
  const slotScale = stage && slots[0] ? slots[0].width / stage.width : 0.12;
  const queueIds = queueIndices(stageIndex, total).map(
    (index) => items[index]!.Id,
  );
  const headSlot = slots[0];
  const controlsTop = headSlot ? headSlot.y - 54 : 0;
  controlsTopRef.current = controlsTop;
  const copyItem = copyItemId ? (itemsById.get(copyItemId) ?? null) : null;

  const hover = (id: string, active: boolean) => {
    if (busyRef.current) return;
    const entry = motions.current.get(id);
    if (!entry || !stage) return;
    const position = queueIds.indexOf(id);
    const slot = slots[position];
    if (!slot) return;
    const lift = active ? slot.height * 0.05 : 0;
    const options = {
      duration: reduceMotion ? 0 : 0.45,
      ease: HERO_MOTION.settleEase,
    };
    void animate(entry.dim, active ? 0 : QUEUE_DIM, options);
    void animate(entry.y, slot.y - lift, options);
  };

  if (total === 0) {
    return (
      <section
        ref={sectionRef}
        className="relative min-h-[100svh] w-full bg-[#050607]"
      />
    );
  }

  return (
    <section
      ref={sectionRef}
      className="seyirlik-home-hero relative h-[100svh] min-h-[38rem] w-full overflow-hidden bg-[#050607]"
      aria-roledescription="carousel"
      aria-label={t("hero.featured")}
      onKeyDown={(event) => {
        if (event.key === "ArrowRight") void travel("forward");
        if (event.key === "ArrowLeft") void travel("backward");
      }}
    >
      {stage
        ? layers.map((layer) => {
            const item = itemsById.get(layer.id);
            const entry = motions.current.get(layer.id);
            if (!item || !entry) return null;
            const isStage = layer.role === "stage";
            return (
              <HeroComposition
                key={layer.id}
                item={item}
                stage={stage}
                motion={entry}
                slotScale={slotScale}
                zIndex={Z[layer.role]}
                isStage={isStage}
                clipPath={isStage && !hasOpened ? gate : undefined}
                trailerUrl={isStage ? trailerUrl : null}
                isTrailerPlaying={
                  isStage && isTrailerPlaying && isInView && isDocumentVisible
                }
                isTrailerMuted={isTrailerMuted}
                onTrailerEnded={endTrailer}
                onArtworkReady={() => handleArtworkReady(layer.id)}
              />
            );
          })
        : null}

      {/* The copy, under the title, a line at a time. */}
      {stage ? (
        <div
          className="pointer-events-none absolute z-[6]"
          style={{
            left: stage.width * TITLE_BOX.left,
            top:
              stage.height * (1 - TITLE_BOX.bottom) +
              Math.max(14, stage.height * 0.022),
            width: Math.min(stage.width * 0.4, 600),
          }}
        >
          <AnimatePresence mode="wait">
            {copyItem ? (
              <HeroCopy
                key={copyItem.Id}
                item={copyItem}
                reduceMotion={reduceMotion}
                smartContinueItems={smartContinueItems}
              />
            ) : null}
          </AnimatePresence>
        </div>
      ) : null}

      {/* The queue: hit targets over the miniatures, and the head's clock. */}
      {stage && hasOpened
        ? queueIds.map((id, position) => {
            const slot = slots[position];
            const item = itemsById.get(id);
            if (!slot || !item) return null;
            const title =
              getItemDisplayMetadata(item, language).title ?? item.Name;
            return (
              <button
                key={id}
                type="button"
                className="absolute z-[5] rounded-[12px] outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-black disabled:cursor-default"
                style={{
                  left: slot.x,
                  top: slot.y,
                  width: slot.width,
                  height: slot.height,
                }}
                aria-label={title}
                disabled={isTravelling}
                onMouseEnter={() => hover(id, true)}
                onMouseLeave={() => hover(id, false)}
                onFocus={() => hover(id, true)}
                onBlur={() => hover(id, false)}
                onClick={(event) => {
                  hover(id, false);
                  // The card it was focused on is about to leave the queue.
                  event.currentTarget.blur();
                  void travel("forward", position);
                }}
              />
            );
          })
        : null}

      {stage && headSlot ? (
        <motion.div
          aria-hidden="true"
          className="pointer-events-none absolute z-[5] h-[2px] overflow-hidden rounded-full bg-white/15"
          style={{
            left: headSlot.x,
            top: headSlot.y + headSlot.height + 10,
            width: headSlot.width,
          }}
          initial={{ opacity: 0 }}
          animate={{
            opacity: hasOpened && !isTravelling && !isTrailerPlaying ? 1 : 0,
          }}
          transition={{ duration: reduceMotion ? 0 : 0.35 }}
        >
          <motion.div
            className="h-full origin-left bg-[var(--accent)]"
            style={{ scaleX: progress }}
          />
        </motion.div>
      ) : null}

      {stage && headSlot && total > 1 ? (
        <motion.div
          className="absolute z-[6] flex items-center gap-1 rounded-full border border-white/[0.14] bg-black/60 p-1 text-white shadow-[0_18px_60px_rgba(0,0,0,0.55),inset_0_1px_0_rgba(255,255,255,0.08)] backdrop-blur-2xl"
          style={{
            right:
              stage.width -
              (slots[slots.length - 1]!.x + slots[slots.length - 1]!.width),
            top: controlsTop,
          }}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: hasOpened ? 1 : 0, y: hasOpened ? 0 : 10 }}
          transition={{
            duration: reduceMotion ? 0 : 0.6,
            ease: HERO_MOTION.settleEase,
          }}
        >
          <HeroControlButton
            label={t("hero.previous")}
            onClick={() => void travel("backward")}
            disabled={isTravelling}
          >
            <ChevronLeft size={18} strokeWidth={2.4} />
          </HeroControlButton>
          <HeroControlButton
            label={isPaused ? t("hero.resume") : t("hero.pause")}
            onClick={() => setIsPaused((current) => !current)}
          >
            {isPaused ? (
              <Play size={15} fill="currentColor" />
            ) : (
              <Pause size={15} fill="currentColor" />
            )}
          </HeroControlButton>
          <HeroControlButton
            label={t("hero.next")}
            onClick={() => void travel("forward")}
            disabled={isTravelling}
          >
            <ChevronRight size={18} strokeWidth={2.4} />
          </HeroControlButton>
          <span
            className="px-2.5 text-xs font-black tabular-nums tracking-[0.08em] text-white/70"
            aria-live="polite"
          >
            {String(stageIndex + 1).padStart(2, "0")}
            <span className="text-white/35">
              {" "}
              / {String(total).padStart(2, "0")}
            </span>
          </span>
          {trailerUrl ? (
            <>
              <span
                className="mx-0.5 h-5 w-px bg-white/15"
                aria-hidden="true"
              />
              <HeroControlButton
                label={
                  areTrailersEnabled
                    ? t("hero.disableTrailers")
                    : t("hero.enableTrailers")
                }
                onClick={() => {
                  const next = !areTrailersEnabled;
                  saveHeroTrailersEnabledPreference(next);
                  setAreTrailersEnabled(next);
                  if (!next) setIsTrailerPlaying(false);
                }}
              >
                {areTrailersEnabled ? (
                  <Video size={16} />
                ) : (
                  <VideoOff size={16} />
                )}
              </HeroControlButton>
              {isTrailerPlaying ? (
                <HeroControlButton
                  label={isTrailerMuted ? t("player.unmute") : t("player.mute")}
                  onClick={() => setIsTrailerMuted((current) => !current)}
                >
                  {isTrailerMuted ? (
                    <VolumeX size={16} />
                  ) : (
                    <Volume2 size={16} />
                  )}
                </HeroControlButton>
              ) : null}
            </>
          ) : null}
        </motion.div>
      ) : null}

      {/* The page continues below; the hero hands over to it. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 bottom-0 z-[4] h-24 bg-gradient-to-b from-transparent to-[#050607]"
      />
    </section>
  );
}

function HeroControlButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Tooltip content={label} placement="top">
      <button
        type="button"
        aria-label={label}
        onClick={onClick}
        disabled={disabled}
        className="flex h-9 w-9 items-center justify-center rounded-full text-white/85 transition hover:bg-white/[0.12] hover:text-white active:scale-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-40"
      >
        {children}
      </button>
    </Tooltip>
  );
}

/** What to show under the title: facts, a few lines of story, and the ways in. */
function HeroCopy({
  item,
  reduceMotion,
  smartContinueItems,
}: {
  item: MediaItem;
  reduceMotion: boolean;
  smartContinueItems: MediaItem[];
}) {
  const { language, t } = useLanguage();
  const navigate = useNavigate();
  const labels = {
    season: t("media.seasonNumber"),
    hourShort: t("format.hourShort"),
    minuteShort: t("format.minuteShort"),
  };
  const metadata = getItemDisplayMetadata(item, language);
  const runtime = formatRuntime(item.RunTimeTicks, labels);
  const facts = [
    item.ProductionYear,
    runtime,
    item.Genres?.filter(Boolean).slice(0, 2).join(", "),
  ]
    .filter(Boolean)
    .join("  ·  ");

  const continueTarget = smartContinueItems.find((candidate) =>
    item.Type === "Series"
      ? candidate.Type === "Episode" && candidate.SeriesId === item.Id
      : candidate.Id === item.Id,
  );
  const playItem = continueTarget ?? item;
  const hasProgress =
    (continueTarget?.UserData?.PlaybackPositionTicks ?? 0) > 0;
  const episodeLabel =
    continueTarget?.Type === "Episode" &&
    typeof continueTarget.ParentIndexNumber === "number" &&
    typeof continueTarget.IndexNumber === "number"
      ? t("media.seasonEpisodeNumber")
          .replace("{seasonNumber}", String(continueTarget.ParentIndexNumber))
          .replace("{episodeNumber}", String(continueTarget.IndexNumber))
      : null;
  const playLabel = `${hasProgress ? t("details.continueWatching") : t("common.play")}${
    episodeLabel ? `: ${episodeLabel}` : ""
  }`;
  const playTo =
    playItem.Type === "Series"
      ? getRouteForItem(playItem)
      : `/watch/${playItem.Id}`;
  const canStartOver = canStartOverFromHero(playItem);

  const handlePlay = async (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    navigate(await getPlayTargetForItem(playItem));
  };

  const line = (index: number) => ({
    initial: { y: reduceMotion ? 0 : "105%", opacity: reduceMotion ? 0 : 1 },
    animate: {
      y: "0%",
      opacity: 1,
      transition: {
        duration: reduceMotion ? 0.2 : HERO_MOTION.copyEnterS,
        delay: reduceMotion ? 0 : index * HERO_MOTION.copyEnterStaggerS,
        ease: HERO_MOTION.settleEase,
      },
    },
    exit: {
      y: reduceMotion ? 0 : "105%",
      opacity: reduceMotion ? 0 : 1,
      transition: {
        duration: reduceMotion ? 0.15 : HERO_MOTION.copyExitS,
        delay: reduceMotion ? 0 : index * HERO_MOTION.copyExitStaggerS,
        ease: HERO_MOTION.travelEase,
      },
    },
  });

  return (
    <motion.div
      className="pointer-events-auto"
      initial="initial"
      animate="animate"
      exit="exit"
    >
      {facts ? (
        <div className="overflow-hidden pb-0.5">
          <motion.p
            variants={line(0)}
            className="text-[0.8125rem] font-bold tracking-[0.04em] text-white/70 drop-shadow-[0_2px_10px_rgba(0,0,0,0.8)]"
          >
            {facts}
          </motion.p>
        </div>
      ) : null}
      {metadata.overview ? (
        <div className="mt-3 overflow-hidden">
          <motion.p
            variants={line(1)}
            className="line-clamp-3 max-w-[46ch] text-sm font-semibold leading-[1.6] text-white/80 drop-shadow-[0_2px_12px_rgba(0,0,0,0.85)] xl:text-base"
          >
            {metadata.overview}
          </motion.p>
        </div>
      ) : null}
      <div className="-mx-2 mt-6 overflow-hidden px-2 pb-3 pt-1">
        <motion.div
          variants={line(2)}
          className="flex flex-wrap items-center gap-2.5"
        >
          <ButtonLink
            to={playTo}
            onClick={handlePlay}
            className="min-h-12 rounded-full bg-white px-7 text-base text-black shadow-button-glow hover:translate-y-0 hover:bg-white/85"
          >
            <Play size={20} fill="currentColor" />
            {playLabel}
          </ButtonLink>
          {canStartOver ? (
            <ButtonLink
              to={`${playTo}${playTo.includes("?") ? "&" : "?"}start=0`}
              variant="secondary"
              className="min-h-12 rounded-full px-5 hover:translate-y-0"
              tooltip={t("details.playFromBeginning")}
              aria-label={t("details.playFromBeginning")}
            >
              <RotateCcw size={18} />
            </ButtonLink>
          ) : null}
          <ButtonLink
            to={getRouteForItem(item)}
            variant="secondary"
            className="min-h-12 rounded-full border-white/[0.14] bg-black/35 px-6 backdrop-blur-xl hover:translate-y-0 hover:bg-white/[0.14]"
          >
            <Info size={19} />
            {t("common.details")}
          </ButtonLink>
          <FavouriteButton
            item={item}
            iconSize={20}
            className="inline-flex h-12 w-12 items-center justify-center rounded-full border border-white/[0.14] bg-black/35 text-white/85 backdrop-blur-xl transition hover:bg-white hover:text-zinc-950 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          />
        </motion.div>
      </div>
    </motion.div>
  );
}
