import { useLayoutEffect, useRef, useState } from "react";
import {
  COPY_ROWS,
  TITLE_SCALE,
  heroLayout,
  queueSlots,
  type StageSize,
} from "./homeHeroModel";

/**
 * The home hero's loading state, placed from the same geometry as the hero
 * itself — every placeholder is the size of, and exactly where, the thing
 * that replaces it — so the hand-over from loading to content moves nothing.
 */

/** Sizes of the hero's own controls, as it renders them. */
const ACTIONS = {
  playPx: 114,
  detailsPx: 135,
  roundPx: 48,
  gapPx: 10,
} as const;
const CONTROLS = { widthPx: 197, heightPx: 46, abovePx: 54 } as const;
/** A logo is usually wide; the placeholder takes the typical share of its box. */
const LOGO_HEIGHT_SHARE = 0.62;

/** The skeleton's backdrop, the same veils the loading page has always had. */
export function HomeHeroSkeletonBackdrop() {
  return (
    <>
      <div className="absolute inset-0 bg-zinc-950" />
      <div className="absolute inset-0 bg-gradient-to-r from-black/90 via-black/[0.55] to-black/20" />
      <div className="absolute inset-0 bg-gradient-to-t from-[var(--background)] via-black/10 to-black/[0.24]" />
      <div className="absolute bottom-0 left-0 right-0 h-48 bg-gradient-to-t from-[var(--background)] to-transparent" />
    </>
  );
}

/** The placeholders alone, for a stage of a known size. */
export function HomeHeroSkeletonPieces({
  stage,
  withQueue = true,
}: {
  stage: StageSize;
  /** A title's own page has the same copy and no queue. */
  withQueue?: boolean;
}) {
  const layout = heroLayout(stage);
  const slots = queueSlots(stage);
  const head = slots[0]!;
  const last = slots[slots.length - 1]!;
  const copyTop = stage.height - layout.copy.bottom - layout.copy.height;
  const actionsTop = stage.height - layout.copy.bottom - COPY_ROWS.actionsPx;
  const logoWidth = layout.title.width * TITLE_SCALE.rest;
  const logoHeight = layout.title.height * TITLE_SCALE.rest * LOGO_HEIGHT_SHARE;

  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0">
      <div
        className="shimmer absolute rounded-lg"
        style={{
          left: layout.title.left,
          bottom: layout.title.bottom,
          width: logoWidth,
          height: logoHeight,
        }}
      />
      <div
        className="absolute flex items-center gap-1 text-sm font-semibold text-white/[0.84]"
        style={{
          left: layout.copy.left,
          top: copyTop,
          height: COPY_ROWS.factsPx,
        }}
      >
        <div className="shimmer h-5 w-10 rounded-md" />.
        <div className="shimmer h-5 w-16 rounded-md" />.
        <div className="shimmer h-5 w-14 rounded-md" />
      </div>
      <div
        className="absolute flex items-center"
        style={{
          left: layout.copy.left,
          top: actionsTop,
          gap: ACTIONS.gapPx,
        }}
      >
        <div
          className="shimmer rounded-full"
          style={{ width: ACTIONS.playPx, height: COPY_ROWS.actionsPx }}
        />
        <div
          className="shimmer rounded-full"
          style={{ width: ACTIONS.detailsPx, height: COPY_ROWS.actionsPx }}
        />
        <div
          className="shimmer rounded-full"
          style={{ width: ACTIONS.roundPx, height: ACTIONS.roundPx }}
        />
        <div
          className="shimmer rounded-full"
          style={{ width: ACTIONS.roundPx, height: ACTIONS.roundPx }}
        />
      </div>

      {withQueue ? (
        <>
          {slots.map((slot, index) => (
            <div
              key={index}
              className="shimmer absolute rounded-[12px]"
              style={{
                left: slot.x,
                top: slot.y,
                width: slot.width,
                height: slot.height,
              }}
            />
          ))}
          <div
            className="absolute h-[2px] rounded-full bg-white/15"
            style={{
              left: head.x,
              top: head.y + head.height + 10,
              width: head.width,
            }}
          />
          <div
            className="shimmer absolute rounded-full"
            style={{
              right: stage.width - (last.x + last.width),
              top: head.y - CONTROLS.abovePx,
              width: CONTROLS.widthPx,
              height: CONTROLS.heightPx,
            }}
          />
        </>
      ) : null}
    </div>
  );
}

/** The hero-sized loading section, used while the page has no data yet. */
export function HomeHeroSkeleton() {
  const ref = useRef<HTMLElement>(null);
  const [stage, setStage] = useState<StageSize | null>(null);
  useLayoutEffect(() => {
    const section = ref.current;
    if (!section) return undefined;
    const measure = () =>
      setStage({ width: section.clientWidth, height: section.clientHeight });
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(section);
    return () => observer.disconnect();
  }, []);

  return (
    <section
      ref={ref}
      className="relative h-[100svh] min-h-[38rem] w-full overflow-hidden"
    >
      <HomeHeroSkeletonBackdrop />
      {stage ? <HomeHeroSkeletonPieces stage={stage} /> : null}
    </section>
  );
}

/**
 * A title page's hero while it loads: the home hero's skeleton without the
 * queue, so each placeholder is where the title hero's own piece will be.
 */
export function TitleHeroSkeleton() {
  const ref = useRef<HTMLElement>(null);
  const [stage, setStage] = useState<StageSize | null>(null);
  useLayoutEffect(() => {
    const section = ref.current;
    if (!section) return undefined;
    const measure = () =>
      setStage({ width: section.clientWidth, height: section.clientHeight });
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(section);
    return () => observer.disconnect();
  }, []);

  return (
    <section
      ref={ref}
      className="relative h-[100svh] min-h-[38rem] w-full overflow-hidden"
    >
      <HomeHeroSkeletonBackdrop />
      {stage ? (
        <HomeHeroSkeletonPieces stage={stage} withQueue={false} />
      ) : null}
    </section>
  );
}
