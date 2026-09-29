/**
 * The home hero's geometry and timing, kept pure so the choreography's rules
 * can be tested without a browser.
 *
 * The hero is a stage with its queue in view. Every featured title is drawn as
 * one composition — backdrop, scrim, logo — at the stage's full size. On stage
 * it sits at scale 1; waiting in the queue it is the same composition scaled
 * down into a slot whose aspect ratio is the stage's own. That is what lets a
 * title travel between the two as a single transform: the miniature is not a
 * thumbnail of the title, it is the title, smaller.
 */

export interface StageSize {
  width: number;
  height: number;
}

export interface Placement {
  x: number;
  y: number;
  scale: number;
}

export interface SlotRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** How many upcoming titles wait in view. */
export const QUEUE_LENGTH = 3;

/**
 * Timing, in one place. Every trip of one kind takes the same time wherever it
 * starts, so lifting the third miniature feels like lifting the first.
 */
export const HERO_MOTION = {
  /**
   * A title lifting from the queue to the stage, or back. Sine in-out: of the
   * smooth curves it has the lowest peak speed (π/2 × the average), and on
   * the longest trip the peak is what sets how short the trip can be.
   */
  travelS: 0.72,
  travelEase: [0.37, 0, 0.63, 1] as [number, number, number, number],
  /**
   * The queue sliding along: every miniature in it, the ones closing up and
   * the ones arriving from beyond the edge, on one shared clock.
   */
  slideS: 0.62,
  slideDelayS: 0.06,
  slideEase: [0.35, 0, 0.25, 1] as [number, number, number, number],
  /** A title skipped over in the queue, sinking out of it. */
  dropS: 0.34,
  settleEase: [0.61, 1, 0.88, 1] as [number, number, number, number],
  /** What the outgoing title does under the incoming one: it recedes. */
  pushBackScale: 0.95,
  pushBackDim: 0.5,
  /** The first arrival: the frame opens like a projector gate. */
  gateOpenS: 0.95,
  /** Copy leaving and arriving, a line at a time. */
  copyExitS: 0.18,
  copyExitStaggerS: 0.025,
  copyEnterS: 0.46,
  copyEnterStaggerS: 0.05,
  /** Share of the lift after which the new title's copy starts rising. */
  copyLeadIn: 0.72,
} as const;

/** Time on stage before the next title lifts off. */
export const HERO_DWELL_MS = 11_000;
/** With a trailer: how long the artwork and copy hold before it starts. */
export const HERO_TRAILER_DELAY_MS = 6_000;

/**
 * The fastest any edge may move, in px per frame at 60 fps on a 1080-tall
 * canvas, scaled with the canvas. A lift from the far end of the queue to the
 * full frame is the longest trip; this keeps it under a second on any desktop
 * without its fastest frames reading as a jump.
 */
export const MAX_TRAVEL_PX_PER_FRAME_AT_1080 = 52;

export function travelBudgetPxPerFrame(stage: StageSize): number {
  return (MAX_TRAVEL_PX_PER_FRAME_AT_1080 * stage.height) / 1080;
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

/** The next `count` titles after `stageIndex`, wrapping, never the stage itself. */
export function queueIndices(
  stageIndex: number,
  total: number,
  count = QUEUE_LENGTH,
): number[] {
  if (total <= 1) return [];
  const length = Math.min(count, total - 1);
  return Array.from(
    { length },
    (_, offset) => (stageIndex + 1 + offset) % total,
  );
}

/** The title before `stageIndex`, wrapping. */
export function previousIndex(stageIndex: number, total: number): number {
  return (stageIndex - 1 + total) % total;
}

/**
 * Where the queue's slots sit, left to right, in stage coordinates. Their
 * aspect ratio is the stage's, so a slot holds a whole composition.
 */
export function queueSlots(stage: StageSize, count = QUEUE_LENGTH): SlotRect[] {
  const width = clamp(stage.width * 0.115, 148, 236);
  const height = (width * stage.height) / stage.width;
  const gap = clamp(stage.width * 0.009, 10, 18);
  const right = clamp(stage.width * 0.035, 24, 72);
  const bottom = clamp(stage.height * 0.075, 28, 76);
  const y = stage.height - bottom - height;
  return Array.from({ length: count }, (_, index) => ({
    x:
      stage.width - right - (count - index) * width - (count - 1 - index) * gap,
    y,
    width,
    height,
  }));
}

export function stagePlacement(): Placement {
  return { x: 0, y: 0, scale: 1 };
}

export function slotPlacement(stage: StageSize, slot: SlotRect): Placement {
  return { x: slot.x, y: slot.y, scale: slot.width / stage.width };
}

/** Distance between neighbouring slots' left edges. */
export function slotPitch(stage: StageSize): number {
  const [first, second] = queueSlots(stage, 2);
  return second!.x - first!.x;
}

/**
 * Where the `order`-th title joining the queue waits: beyond the right edge,
 * in line with the queue and spaced like its slots. Arrivals line up behind
 * one another, so as the row slides in on one clock nothing can overtake.
 */
export function arrivalPlacement(stage: StageSize, order = 0): Placement {
  const slots = queueSlots(stage);
  const last = slots[slots.length - 1]!;
  const gap = slotPitch(stage) - last.width;
  return {
    x: stage.width + gap + order * slotPitch(stage),
    y: last.y,
    scale: last.width / stage.width,
  };
}

/** Below the frame: where a title skipped over in the queue leaves to. */
export function droppedPlacement(stage: StageSize, slot: SlotRect): Placement {
  return { x: slot.x, y: stage.height + 24, scale: slot.width / stage.width };
}

/** The receding position of a title another one is covering. */
export function pushedBackPlacement(stage: StageSize): Placement {
  const scale = HERO_MOTION.pushBackScale;
  return {
    x: (stage.width * (1 - scale)) / 2,
    y: (stage.height * (1 - scale)) / 2,
    scale,
  };
}

/** The steepest slope of a CSS cubic-bézier easing, sampled. */
export function easePeakFactor(
  ease: readonly [number, number, number, number],
): number {
  const [x1, y1, x2, y2] = ease;
  const at = (t: number, a: number, b: number) =>
    3 * a * t * (1 - t) ** 2 + 3 * b * t ** 2 * (1 - t) + t ** 3;
  let peak = 0;
  let previous = { x: 0, y: 0 };
  for (let step = 1; step <= 2000; step += 1) {
    const t = step / 2000;
    const point = { x: at(t, x1, x2), y: at(t, y1, y2) };
    const dx = point.x - previous.x;
    if (dx > 1e-9) peak = Math.max(peak, (point.y - previous.y) / dx);
    previous = point;
  }
  return peak;
}

/** How far the farthest-moving edge of a composition goes between placements. */
export function edgeDistance(
  stage: StageSize,
  from: Placement,
  to: Placement,
): number {
  const edges = (p: Placement) => [
    p.x,
    p.y,
    p.x + stage.width * p.scale,
    p.y + stage.height * p.scale,
  ];
  const a = edges(from);
  const b = edges(to);
  return Math.max(...a.map((value, index) => Math.abs(value - b[index]!)));
}

/** The fastest any edge moves on a trip, in px per frame at 60 fps. */
export function peakTravelPxPerFrame(
  stage: StageSize,
  from: Placement,
  to: Placement,
  durationS: number,
  ease: readonly [number, number, number, number] = HERO_MOTION.travelEase,
): number {
  const averagePerFrame = edgeDistance(stage, from, to) / durationS / 60;
  return easePeakFactor(ease) * averagePerFrame;
}

/**
 * How long a set of moves that share one clock takes: the base time,
 * lengthened only as far as the fastest edge of the longest move needs.
 */
export function sharedDurationS(
  stage: StageSize,
  trips: Array<{ from: Placement; to: Placement }>,
  baseS: number,
  ease: readonly [number, number, number, number],
): number {
  const budget = travelBudgetPxPerFrame(stage);
  return trips.reduce((duration, { from, to }) => {
    const peak = peakTravelPxPerFrame(stage, from, to, baseS, ease);
    return Math.max(duration, peak <= budget ? baseS : (baseS * peak) / budget);
  }, baseS);
}

/**
 * How long a lift between the stage and the queue takes. It is the same for
 * every slot — the time the farthest one needs — so which miniature was
 * chosen never changes how fast the title arrives.
 */
export function liftDurationS(stage: StageSize): number {
  return sharedDurationS(
    stage,
    queueSlots(stage).map((slot) => ({
      from: slotPlacement(stage, slot),
      to: stagePlacement(),
    })),
    HERO_MOTION.travelS,
    HERO_MOTION.travelEase,
  );
}

/**
 * Where the copy block and the title above it sit: both anchored bottom-left,
 * the actions level with the bottom of the queue. At rest the copy is the
 * facts line and the actions; the overview opens between them only when
 * asked for, and the facts and the title rise by `overviewLift` to make room.
 */
export interface HeroLayout {
  copy: { left: number; bottom: number; width: number; height: number };
  title: { left: number; bottom: number; width: number; height: number };
  overviewFontPx: number;
  /** Height of the overview's three lines. */
  overviewHeight: number;
  /** How far the facts and the title rise while the overview is open. */
  overviewLift: number;
}

/**
 * The title's size within its box, grown from its bottom-left corner. It
 * rests small so the artwork leads, grows to full size as the overview opens
 * under it, and steps further back while a trailer plays.
 */
export const TITLE_SCALE = {
  rest: 0.6,
  open: 1,
  trailer: 0.46,
} as const;

/** Fixed rows, so the title's place never depends on a title's own copy. */
export const COPY_ROWS = {
  factsPx: 20,
  /** Between the facts and the overview. */
  factsGapPx: 12,
  overviewLines: 3,
  overviewLineHeight: 1.55,
  /** Above the actions, under whatever sits there. */
  actionsGapPx: 20,
  actionsPx: 48,
} as const;

export function heroLayout(stage: StageSize): HeroLayout {
  const slots = queueSlots(stage);
  const bottom = stage.height - (slots[0]!.y + slots[0]!.height);
  const left = clamp(stage.width * 0.045, 40, 88);
  const overviewFontPx = stage.width >= 1280 ? 16 : 14;
  const overviewHeight = Math.ceil(
    overviewFontPx * COPY_ROWS.overviewLineHeight * COPY_ROWS.overviewLines,
  );
  const height =
    COPY_ROWS.factsPx + COPY_ROWS.actionsGapPx + COPY_ROWS.actionsPx;
  const width = Math.min(stage.width * 0.4, 600, slots[0]!.x - left - 32);
  const titleGap = clamp(stage.height * 0.028, 18, 32);
  return {
    copy: { left, bottom, width, height },
    title: {
      left,
      bottom: bottom + height + titleGap,
      width: Math.min(stage.width * 0.34, 620),
      height: clamp(stage.height * 0.19, 110, 220),
    },
    overviewFontPx,
    overviewHeight,
    overviewLift: overviewHeight + COPY_ROWS.factsGapPx,
  };
}
