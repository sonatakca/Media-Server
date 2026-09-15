import { describe, expect, it } from "vitest";
import {
  buildAudioEnvelopeArgs,
  envelopeThreshold,
  parseAudioEnvelope,
  speechIntervalsFromEnvelope,
  type EnvelopeSample,
} from "./audioSpeech";

/** Exactly what FFmpeg's `ametadata` printer writes, two lines per window. */
const envelopeText = (levels: readonly (number | "-inf")[]): string =>
  levels
    .flatMap((level, index) => [
      `frame:${index}    pts:${index * 2000}       pts_time:${index * 0.25}`,
      `lavfi.astats.Overall.RMS_level=${level}`,
    ])
    .join("\n");

describe("buildAudioEnvelopeArgs", () => {
  const args = buildAudioEnvelopeArgs("/media/film.mkv", 2);

  it("reads the one audio stream it was asked for and no pictures", () => {
    expect(args).toContain("0:2");
    expect(args).toContain("-vn");
    expect(args).toContain("-sn");
  });

  it("keeps only the band speech lives in", () => {
    const filter = args[args.indexOf("-af") + 1] ?? "";
    expect(filter).toContain("highpass=f=250");
    expect(filter).toContain("lowpass=f=3000");
  });

  it("measures on a fixed quarter-second grid", () => {
    const filter = args[args.indexOf("-af") + 1] ?? "";
    // 8000 Hz × 0.25 s. The grid is what puts an onset on the timeline.
    expect(filter).toContain("asetnsamples=n=2000");
    expect(filter).toContain("astats=metadata=1:reset=1");
  });

  it("names a muxer that writes nothing, so stdout carries only the report", () => {
    expect(args.slice(-2)).toEqual(["null", "-"]);
  });
});

describe("parseAudioEnvelope", () => {
  it("pairs each level with the timestamp FFmpeg reported for it", () => {
    expect(parseAudioEnvelope(envelopeText([-30, -45]))).toEqual([
      { timeSeconds: 0, decibels: -30 },
      { timeSeconds: 0.25, decibels: -45 },
    ]);
  });

  it("reads digital silence as silence rather than as a number", () => {
    const [sample] = parseAudioEnvelope(envelopeText(["-inf"]));
    expect(sample?.decibels).toBe(Number.NEGATIVE_INFINITY);
  });

  it("ignores lines that are neither a frame nor a level", () => {
    const text = `Stream mapping:\n${envelopeText([-20])}\nfinished`;
    expect(parseAudioEnvelope(text)).toHaveLength(1);
  });

  it("returns nothing for output that holds no measurements", () => {
    expect(parseAudioEnvelope("")).toEqual([]);
  });
});

describe("envelopeThreshold", () => {
  const samples: EnvelopeSample[] = [-10, -20, -30, -40, "-inf" as const].map(
    (value, index) => ({
      timeSeconds: index * 0.25,
      decibels: value === "-inf" ? Number.NEGATIVE_INFINITY : value,
    }),
  );

  it("cuts at the requested share of the audible film", () => {
    // Four audible windows: half of them is the second loudest.
    expect(envelopeThreshold(samples, 0.5)).toBe(-30);
  });

  it("keeps silence out of the ranking", () => {
    // Were the silent window counted, a quarter of five windows would be -20.
    expect(envelopeThreshold(samples, 0.25)).toBe(-20);
  });
});

describe("speechIntervalsFromEnvelope", () => {
  /** Two clear bursts of speech with a long quiet stretch between them. */
  const bursts = parseAudioEnvelope(
    envelopeText([
      -60, -55, -58, -20, -18, -19, -21, -57, -59, -58, -56, -60, -58, -57, -19,
      -20, -18, -22, -59, -60,
    ]),
  );

  it("finds one interval per burst", () => {
    const intervals = speechIntervalsFromEnvelope(bursts, { dutyCycle: 0.4 });
    expect(intervals).toHaveLength(2);
    expect(intervals[0]?.startSeconds).toBeLessThanOrEqual(0.75);
    expect(intervals[1]?.startSeconds).toBeGreaterThanOrEqual(3);
  });

  it("does not join two bursts across a long silence", () => {
    const [first] = speechIntervalsFromEnvelope(bursts, { dutyCycle: 0.4 });
    expect(first?.endSeconds).toBeLessThan(2);
  });

  it("discards a single loud window that is not a line of dialogue", () => {
    const blip = parseAudioEnvelope(
      envelopeText([-60, -58, -10, -57, -59, -61, -62, -63]),
    );
    expect(speechIntervalsFromEnvelope(blip, { dutyCycle: 0.12 })).toEqual([]);
  });

  it("returns nothing when there is nothing to measure", () => {
    expect(speechIntervalsFromEnvelope([])).toEqual([]);
  });
});
