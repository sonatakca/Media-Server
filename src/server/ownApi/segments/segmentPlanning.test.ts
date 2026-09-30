import { describe, expect, it } from "vitest";
import { FINGERPRINT_SECONDS_PER_WORD } from "./audioFingerprint";
import {
  chapterSegmentType,
  planSeasonSegments,
  segmentsFromChapters,
  type EpisodeAudio,
} from "./segmentPlanning";
import type { SharedRegion } from "./sharedRegion";

const words = (seconds: number) =>
  Math.round(seconds / FINGERPRINT_SECONDS_PER_WORD);

/** A window whose first word names the episode, so a stub matcher can tell them apart. */
function window(tag: number, startSeconds = 0) {
  return { startSeconds, words: Uint32Array.of(tag) };
}

function episode(
  itemId: string,
  tag: number,
  overrides: Partial<EpisodeAudio> = {},
): EpisodeAudio {
  return {
    itemId,
    durationSeconds: 2_700,
    chapters: [],
    opening: window(tag),
    closing: window(tag + 100, 2_400),
    ...overrides,
  };
}

describe("chapterSegmentType", () => {
  it("reads English and Turkish chapter names", () => {
    expect(chapterSegmentType("Opening Credits")).toBe("intro");
    expect(chapterSegmentType("Intro")).toBe("intro");
    expect(chapterSegmentType("Açılış Jeneriği")).toBe("intro");
    expect(chapterSegmentType("End Credits")).toBe("outro");
    expect(chapterSegmentType("Kapanış")).toBe("outro");
    expect(chapterSegmentType("Previously on Ezel")).toBe("recap");
    expect(chapterSegmentType("Önceki Bölümlerde")).toBe("recap");
    expect(chapterSegmentType("Gelecek Bölüm")).toBe("preview");
  });

  it("leaves ordinary chapters alone", () => {
    expect(chapterSegmentType("Chapter 3")).toBeNull();
    expect(chapterSegmentType("The Opener's Gambit")).toBeNull();
    expect(chapterSegmentType(null)).toBeNull();
  });
});

describe("segmentsFromChapters", () => {
  it("runs a chapter to the next one, or to the end", () => {
    const segments = segmentsFromChapters(
      "film",
      [
        { startMs: 0, name: "Chapter 1" },
        { startMs: 60_000, name: "Opening Credits" },
        { startMs: 150_000, name: "Chapter 2" },
        { startMs: 6_900_000, name: "End Credits" },
      ],
      7_200,
    );
    expect(segments).toEqual([
      {
        itemId: "film",
        type: "intro",
        startMs: 60_000,
        endMs: 150_000,
        source: "chapter",
      },
      {
        itemId: "film",
        type: "outro",
        startMs: 6_900_000,
        endMs: 7_200_000,
        source: "chapter",
      },
    ]);
  });
});

describe("planSeasonSegments", () => {
  /**
   * Episodes 1 and 2 share a 60 s intro at 90 s and 30 s respectively;
   * episode 3's intro matches episode 2's but is shorter.
   */
  const intros: Record<string, SharedRegion> = {
    "1:2": {
      leftStart: words(90),
      leftEnd: words(150),
      rightStart: words(30),
      rightEnd: words(90),
    },
    "2:1": {
      leftStart: words(30),
      leftEnd: words(90),
      rightStart: words(90),
      rightEnd: words(150),
    },
    "2:3": {
      leftStart: words(30),
      leftEnd: words(80),
      rightStart: words(0),
      rightEnd: words(50),
    },
    "3:2": {
      leftStart: words(0),
      leftEnd: words(50),
      rightStart: words(30),
      rightEnd: words(80),
    },
    "101:102": {
      leftStart: words(200),
      leftEnd: words(290),
      rightStart: words(10),
      rightEnd: words(100),
    },
  };
  const match = (left: Uint32Array, right: Uint32Array) =>
    intros[`${left[0]}:${right[0]}`] ?? null;

  it("keeps each episode's longest match with a neighbour", () => {
    const plan = planSeasonSegments(
      [episode("e1", 1), episode("e2", 2), episode("e3", 3)],
      match,
    );
    const intro = (itemId: string) =>
      plan.find(
        (segment) => segment.itemId === itemId && segment.type === "intro",
      );

    expect(intro("e1")).toMatchObject({
      startMs: 90_000,
      endMs: 150_000,
      source: "detected",
    });
    // Episode 2 matches both neighbours; the longer, with episode 1, wins.
    expect(intro("e2")).toMatchObject({ startMs: 30_000, endMs: 90_000 });
    expect(intro("e3")).toMatchObject({ startMs: 0, endMs: 50_000 });
  });

  it("runs credits that end near the end of the episode to the end", () => {
    const plan = planSeasonSegments(
      [episode("e1", 1), episode("e2", 2)],
      match,
    );
    // Closing window starts at 2400 s; the match covers 2600–2690 s of a 2700 s episode.
    expect(plan.find((segment) => segment.type === "outro")).toEqual({
      itemId: "e1",
      type: "outro",
      startMs: 2_600_000,
      endMs: 2_700_000,
      source: "detected",
    });
  });

  it("prefers a chapter named for the intro over a detected one", () => {
    const plan = planSeasonSegments(
      [
        episode("e1", 1, {
          chapters: [
            { startMs: 0, name: "Cold Open" },
            { startMs: 100_000, name: "Opening" },
            { startMs: 140_000, name: "Act One" },
          ],
        }),
        episode("e2", 2),
      ],
      match,
    );
    const intros1 = plan.filter(
      (segment) => segment.itemId === "e1" && segment.type === "intro",
    );
    expect(intros1).toEqual([
      {
        itemId: "e1",
        type: "intro",
        startMs: 100_000,
        endMs: 140_000,
        source: "chapter",
      },
    ]);
  });

  it("finds nothing for a lone episode", () => {
    expect(planSeasonSegments([episode("e1", 1)], match)).toEqual([]);
  });
});
