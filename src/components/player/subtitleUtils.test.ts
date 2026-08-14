// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  getActiveSubtitleTextForTime,
  parseSubtitleCues,
} from "./subtitleUtils";

const OPPENHEIMER_REFERENCE_SAMPLE = `WEBVTT

00:29.064 --> 00:32.801
- (gerilimli müzik çalıyor)
- (yağmur pıtırtısı)

00:44.179 --> 00:46.347
(şiddetli bir uğultu)

00:52.154 --> 00:54.589
(patlıyor)
`;

describe("subtitleUtils", () => {
  it("parses the converted Oppenheimer Turkish subtitle format", () => {
    expect(parseSubtitleCues(OPPENHEIMER_REFERENCE_SAMPLE)).toEqual([
      {
        start: 29.064,
        end: 32.801,
        text: "- (gerilimli müzik çalıyor)\n- (yağmur pıtırtısı)",
      },
      {
        start: 44.179,
        end: 46.347,
        text: "(şiddetli bir uğultu)",
      },
      { start: 52.154, end: 54.589, text: "(patlıyor)" },
    ]);
  });

  it("shows every active line at its exact cue time", () => {
    const cues = parseSubtitleCues(OPPENHEIMER_REFERENCE_SAMPLE);

    expect(getActiveSubtitleTextForTime(cues, 30)).toBe(
      "- (gerilimli müzik çalıyor)\n- (yağmur pıtırtısı)",
    );
    expect(getActiveSubtitleTextForTime(cues, 45)).toBe(
      "(şiddetli bir uğultu)",
    );
    expect(getActiveSubtitleTextForTime(cues, 53)).toBe("(patlıyor)");
  });
});
