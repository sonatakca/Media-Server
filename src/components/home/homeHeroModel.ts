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
 * Timing, in one place. Travel uses a sine curve on purpose: its peak speed is
 * π/2 × the average, where a cubic ease peaks near 3×, and the peak is what
 * decides whether a big move reads as motion or as a jump.
 */
export const HERO_MOTION = {
  /** A title lifting from the queue to the stage, or back. */
  travelS: 1.15,
  travelEase: [0.37, 0, 0.63, 1] as [number, number, number, number],
  /** The queue closing up behind a title that left it. */
  shiftS: 0.8,
  shiftDelayS: 0.18,
  /** A title joining the back of the queue from beyond the frame's edge. */
  enterDelayS: 0.45,
  settleEase: [0.61, 1, 0.88, 1] as [number, number, number, number],
  /** What the outgoing title does under the incoming one: it recedes. */
  pushBackScale: 0.94,
  pushBackDim: 0.55,
  /** The first arrival: the frame opens like a projector gate. */
  gateOpenS: 1.35,
  /** Copy leaving and arriving, a line at a time. */
  copyExitS: 0.3,
  copyExitStaggerS: 0.035,
  copyEnterS: 0.72,
  copyEnterStaggerS: 0.07,
  /** The slow push-in while a title holds the stage. */
  drift: 1.07,
} as const;

/** Time on stage before the next title lifts off. */
export const HERO_DWELL_MS = 11_000;
/** With a trailer: how long the artwork and copy hold before it starts. */
export const HERO_TRAILER_DELAY_MS = 6_000;

/**
 * 60 fps with no more than 32 px between neighbouring frames on a 1080-tall
 * canvas, scaled with the canvas: the limit is about how far the eye has to
 * jump, which is a share of the frame, not a count of pixels.
 */
export const MAX_TRAVEL_PX_PER_FRAME_AT_1080 = 32;

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

/** Just beyond the right edge, in line with the queue: where newcomers wait. */
export function offstagePlacement(stage: StageSize): Placement {
  const slots = queueSlots(stage);
  const last = slots[slots.length - 1] ?? slots[0]!;
  return {
    x: stage.width + (last?.width ?? 0) * 0.25,
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

/**
 * The fastest any edge of a composition moves on a trip between two
 * placements, in px per frame at 60 fps, for a sine in-out curve.
 */
export function peakTravelPxPerFrame(
  stage: StageSize,
  from: Placement,
  to: Placement,
  durationS: number,
): number {
  const edges = (p: Placement) => [
    p.x,
    p.y,
    p.x + stage.width * p.scale,
    p.y + stage.height * p.scale,
  ];
  const a = edges(from);
  const b = edges(to);
  const distance = Math.max(
    ...a.map((value, index) => Math.abs(value - b[index]!)),
  );
  const averagePerSecond = distance / durationS;
  return ((Math.PI / 2) * averagePerSecond) / 60;
}

/**
 * How long a trip takes: the choreography's own duration, lengthened only as
 * far as it must be for the fastest edge to stay inside the budget.
 */
export function travelDurationS(
  stage: StageSize,
  from: Placement,
  to: Placement,
  baseS: number = HERO_MOTION.travelS,
): number {
  const peakAtBase = peakTravelPxPerFrame(stage, from, to, baseS);
  const budget = travelBudgetPxPerFrame(stage);
  return peakAtBase <= budget ? baseS : (baseS * peakAtBase) / budget;
}
