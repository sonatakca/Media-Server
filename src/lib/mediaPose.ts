import type { CSSProperties } from "react";

/**
 * How a media object sits on the page when a person, not a grid, put it there.
 *
 * Every poster, cover and shelf card gets a small resting tilt, a nudge off the
 * baseline, and a second angle it turns to when touched. The pose belongs to
 * the item, not to its slot: it is derived from the item's id, so Dune keeps
 * Dune's angle when the library is re-sorted, filtered, re-rendered or
 * revisited, and two neighbours never share a pattern because they happen to
 * be neighbours.
 *
 * The item decides the *character* of its pose — which way it leans, how far
 * relative to the others, which way it turns. The card class decides the
 * *amplitude*: an information-dense Continue Watching card has to stay
 * readable, a bare poster can lean further. The viewport scales the whole
 * thing once more in CSS (see `.media-pose` in MediaCard.css).
 */
export type MediaPoseKind = "poster" | "cover" | "landscape" | "dense";

export interface MediaPose {
  /** Resting rotation, degrees. */
  rotate: number;
  /** Rotation while hovered or keyboard-focused, degrees. */
  hoverRotate: number;
  /** Resting displacement off the shelf line, px. */
  x: number;
  y: number;
}

interface PoseRange {
  /** Largest resting tilt. Most items land well inside it. */
  rest: number;
  /**
   * The smallest tilt, as a share of `rest`. A wide card needs a higher floor:
   * the same angle moves its corners further, but a card that sits within a
   * pixel of level simply reads as level.
   */
  floor: number;
  /** How far a touched card turns, in degrees of change. */
  turnMin: number;
  turnMax: number;
  /** No hovered card leans further than this. */
  hoverLimit: number;
  y: number;
  x: number;
}

export const MEDIA_POSE_RANGES: Record<MediaPoseKind, PoseRange> = {
  poster: {
    rest: 1.75,
    floor: 0.12,
    turnMin: 1.3,
    turnMax: 2.4,
    hoverLimit: 2.7,
    y: 5,
    x: 1.5,
  },
  // A book cover is a smaller, thicker object than a film poster; it takes a
  // touch more lean before it starts to look dropped.
  cover: {
    rest: 1.95,
    floor: 0.12,
    turnMin: 1.35,
    turnMax: 2.5,
    hoverLimit: 2.9,
    y: 5,
    x: 1.5,
  },
  landscape: {
    rest: 1,
    floor: 0.2,
    turnMin: 0.8,
    turnMax: 1.5,
    hoverLimit: 1.7,
    y: 3,
    x: 1,
  },
  dense: {
    rest: 0.6,
    floor: 0.35,
    turnMin: 0.55,
    turnMax: 1.05,
    hoverLimit: 1.15,
    y: 2.5,
    x: 0,
  },
};

/** FNV-1a: a stable, well-spread 32-bit seed from any string. */
function hashString(value: string): number {
  let hash = 0x811c9dc5;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  return hash >>> 0;
}

/** mulberry32 — a small deterministic stream of uniforms in [0, 1). */
function createStream(seed: number): () => number {
  let state = seed;

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  // `+ 0` folds a rounded -0 into 0, so CSS never reads "-0deg".
  return Math.round(value * factor) / factor + 0;
}

export function getMediaPose(id: string, kind: MediaPoseKind): MediaPose {
  const range = MEDIA_POSE_RANGES[kind];
  const next = createStream(hashString(id));

  // Magnitude is skewed towards zero, so most items lean a little and only a
  // few lean noticeably — never a uniform spread, never a fixed alternation.
  // The floor keeps anything from sitting dead straight.
  const lean = range.floor + (1 - range.floor) * next() ** 1.5;
  const leanSign = next() < 0.5 ? -1 : 1;
  const rotate = leanSign * lean * range.rest;

  // Most touched cards turn back through or towards level, some lean further
  // the way they already were. Were they all to straighten, the eye would find
  // the rule at once.
  const turn = range.turnMin + (range.turnMax - range.turnMin) * next();
  const turnsBack = next() < 0.62;
  let hoverRotate = rotate + (turnsBack ? -leanSign : leanSign) * turn;

  if (Math.abs(hoverRotate) > range.hoverLimit) {
    hoverRotate = rotate - (turnsBack ? -leanSign : leanSign) * turn;
  }

  // Triangular, so the shelf line still reads as a line.
  const y = (next() + next() - 1) * range.y;
  const x = (next() * 2 - 1) * range.x;

  return {
    rotate: round(rotate, 2),
    hoverRotate: round(hoverRotate, 2),
    x: round(x, 1),
    y: round(y, 1),
  };
}

/** The custom properties `.media-pose` reads. */
export function getMediaPoseStyle(
  id: string,
  kind: MediaPoseKind,
): CSSProperties {
  const pose = getMediaPose(id, kind);

  return {
    "--media-rest-rotate": `${pose.rotate}deg`,
    "--media-hover-rotate": `${pose.hoverRotate}deg`,
    "--media-rest-x": `${pose.x}px`,
    "--media-rest-y": `${pose.y}px`,
  } as CSSProperties;
}
