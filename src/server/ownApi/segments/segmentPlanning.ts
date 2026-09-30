import { FINGERPRINT_SECONDS_PER_WORD } from "./audioFingerprint";
import {
  findSharedRegion,
  type SharedRegion,
  type SharedRegionOptions,
} from "./sharedRegion";

export type PlannedSegmentType = "intro" | "outro" | "recap" | "preview";

export interface PlannedSegment {
  itemId: string;
  type: PlannedSegmentType;
  startMs: number;
  endMs: number;
  source: "detected" | "chapter";
}

export interface ChapterMark {
  startMs: number;
  name: string | null;
}

/** A fingerprinted stretch of one episode, and where in the episode it starts. */
export interface AudioWindow {
  startSeconds: number;
  words: Uint32Array;
}

export interface EpisodeAudio {
  itemId: string;
  durationSeconds: number;
  chapters: ChapterMark[];
  /** The opening stretch the intro is looked for in; null when not decoded. */
  opening: AudioWindow | null;
  /** The closing stretch the credits are looked for in. */
  closing: AudioWindow | null;
}

/** Where intros and credits are looked for, and how long each may be. */
export const INTRO_WINDOW_SECONDS = 600;
/** An intro in the second half of an episode is not an intro. */
export const INTRO_WINDOW_SHARE = 0.4;
export const CLOSING_WINDOW_SECONDS = 360;
const INTRO_LIMITS: SharedRegionOptions = {
  minimumSeconds: 15,
  maximumSeconds: 180,
};
const CLOSING_LIMITS: SharedRegionOptions = {
  minimumSeconds: 15,
  maximumSeconds: CLOSING_WINDOW_SECONDS,
};
/** Credits that stop this close to the end run to the end. */
const CREDITS_TAIL_SECONDS = 20;

/**
 * A whole-word match that knows Turkish letters are letters.
 *
 * `\b` does not: it counts "ö" as punctuation, so "önceki bölüm" could never
 * match at the start of a name.
 */
function words(...phrases: string[]): RegExp {
  return new RegExp(`(?<!\\p{L})(?:${phrases.join("|")})(?!\\p{L})`, "iu");
}

/**
 * Checked in order. Intro comes before credits so "Opening Credits" is the
 * intro; neither list holds a bare "credits" that could claim the other.
 */
const CHAPTER_TYPES: Array<[RegExp, PlannedSegmentType]> = [
  [words("recap", "previously", "önceki bölüm(?:lerde)?"), "recap"],
  [
    words("preview", "next time", "next episode", "gelecek bölüm", "fragman"),
    "preview",
  ],
  [
    words(
      "intro",
      "opening",
      "opening credits",
      "opening theme",
      "title sequence",
      "açılış",
      "açılış jeneriği",
    ),
    "intro",
  ],
  [
    words(
      "credits",
      "end credits",
      "ending",
      "ending credits",
      "outro",
      "closing",
      "kapanış",
      "kapanış jeneriği",
      "bitiş jeneriği",
    ),
    "outro",
  ],
];

/** What a chapter's name says it is, if it says anything. */
export function chapterSegmentType(
  name: string | null,
): PlannedSegmentType | null {
  const trimmed = name?.trim();
  if (!trimmed) return null;
  for (const [pattern, type] of CHAPTER_TYPES) {
    if (pattern.test(trimmed)) return type;
  }
  return null;
}

/**
 * Segments a title's own chapter names already declare.
 *
 * Authored by whoever made the release and always preferred to a guess: a
 * chapter called "Opening Credits" is the intro, exactly, with no audio
 * needed. A chapter runs to the next one, or to the end.
 */
export function segmentsFromChapters(
  itemId: string,
  chapters: readonly ChapterMark[],
  durationSeconds: number,
): PlannedSegment[] {
  const ordered = [...chapters].sort((a, b) => a.startMs - b.startMs);
  const durationMs = Math.round(durationSeconds * 1_000);
  const segments: PlannedSegment[] = [];
  for (const [index, chapter] of ordered.entries()) {
    const type = chapterSegmentType(chapter.name);
    if (!type) continue;
    const endMs = ordered[index + 1]?.startMs ?? durationMs;
    if (endMs - chapter.startMs < 1_000) continue;
    if (segments.some((segment) => segment.type === type)) continue;
    segments.push({
      itemId,
      type,
      startMs: Math.max(0, chapter.startMs),
      endMs,
      source: "chapter",
    });
  }
  return segments;
}

/**
 * Seconds to stored milliseconds, to the tenth of a second. A fingerprint word
 * is 23 ms long, so finer figures would claim a precision nothing measured.
 */
const toMs = (seconds: number) => Math.round(seconds * 10) * 100;

type Matcher = (
  left: Uint32Array,
  right: Uint32Array,
  options: SharedRegionOptions,
) => SharedRegion | null;

/** The other episodes worth comparing against, nearest first. */
function neighbours<T>(list: readonly T[], index: number): T[] {
  return [index + 1, index - 1, index + 2, index - 2]
    .filter((candidate) => candidate >= 0 && candidate < list.length)
    .map((candidate) => list[candidate]!);
}

/** The longest stretch this window shares with any neighbour's, in seconds. */
function bestSharedStretch(
  window: AudioWindow,
  others: readonly (AudioWindow | null)[],
  limits: SharedRegionOptions,
  match: Matcher,
): { startSeconds: number; endSeconds: number } | null {
  let best: { startSeconds: number; endSeconds: number } | null = null;
  for (const other of others) {
    if (!other) continue;
    const region = match(window.words, other.words, limits);
    if (!region) continue;
    const startSeconds =
      window.startSeconds + region.leftStart * FINGERPRINT_SECONDS_PER_WORD;
    const endSeconds =
      window.startSeconds + region.leftEnd * FINGERPRINT_SECONDS_PER_WORD;
    if (
      !best ||
      endSeconds - startSeconds > best.endSeconds - best.startSeconds
    ) {
      best = { startSeconds, endSeconds };
    }
  }
  return best;
}

/**
 * Intros and credits for every episode of one season.
 *
 * Episodes are given in broadcast order. Each is compared with its nearest
 * neighbours rather than with every other episode: the theme is the same
 * across a season, and a neighbour is the likeliest to share the same edit of
 * it. The longest shared stretch wins, so one neighbour with a cold open
 * running into the titles cannot shorten another's match.
 */
export function planSeasonSegments(
  episodes: readonly EpisodeAudio[],
  match: Matcher = findSharedRegion,
): PlannedSegment[] {
  const planned: PlannedSegment[] = [];
  for (const [index, episode] of episodes.entries()) {
    const fromChapters = segmentsFromChapters(
      episode.itemId,
      episode.chapters,
      episode.durationSeconds,
    );
    planned.push(...fromChapters);
    const has = (type: PlannedSegmentType) =>
      fromChapters.some((segment) => segment.type === type);
    const others = neighbours(episodes, index);

    if (!has("intro") && episode.opening) {
      const intro = bestSharedStretch(
        episode.opening,
        others.map((other) => other.opening),
        INTRO_LIMITS,
        match,
      );
      if (intro) {
        planned.push({
          itemId: episode.itemId,
          type: "intro",
          startMs: toMs(intro.startSeconds),
          endMs: toMs(intro.endSeconds),
          source: "detected",
        });
      }
    }

    if (!has("outro") && episode.closing) {
      const credits = bestSharedStretch(
        episode.closing,
        others.map((other) => other.closing),
        CLOSING_LIMITS,
        match,
      );
      if (credits) {
        const endSeconds =
          episode.durationSeconds - credits.endSeconds <= CREDITS_TAIL_SECONDS
            ? episode.durationSeconds
            : credits.endSeconds;
        planned.push({
          itemId: episode.itemId,
          type: "outro",
          startMs: toMs(credits.startSeconds),
          endMs: toMs(endSeconds),
          source: "detected",
        });
      }
    }
  }
  return planned;
}

/** The opening window to decode for an episode of this length, in seconds. */
export function openingWindowSeconds(durationSeconds: number): number {
  return Math.min(INTRO_WINDOW_SECONDS, durationSeconds * INTRO_WINDOW_SHARE);
}

/** Where the closing window starts, and how long it is. */
export function closingWindow(durationSeconds: number): {
  startSeconds: number;
  seconds: number;
} {
  const seconds = Math.min(CLOSING_WINDOW_SECONDS, durationSeconds * 0.3);
  return { startSeconds: Math.max(0, durationSeconds - seconds), seconds };
}
