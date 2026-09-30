import { describe, expect, it } from "vitest";
import {
  FINGERPRINT_SAMPLE_RATE,
  FINGERPRINT_SECONDS_PER_WORD,
  bitErrors,
  fingerprintPcm,
} from "./audioFingerprint";
import { findSharedRegion } from "./sharedRegion";

/** A deterministic generator, so a failure reproduces. */
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
}

/**
 * Something with the statistics of programme audio rather than of a test
 * tone: a handful of partials whose pitch and level change at irregular
 * moments, over a bed of noise whose brightness drifts. Two seeds share
 * nothing but their general character, which is the point.
 */
function melody(seconds: number, seed: number): Float64Array {
  const next = random(seed);
  const samples = new Float64Array(
    Math.round(seconds * FINGERPRINT_SAMPLE_RATE),
  );
  const partials = Array.from({ length: 5 }, () => ({
    frequency: 200 + next() * 1_800,
    level: next(),
    phase: 0,
    until: 0,
  }));
  let noiseLevel = 0.1;
  let smoothed = 0;
  for (let index = 0; index < samples.length; index += 1) {
    let value = 0;
    for (const partial of partials) {
      if (index >= partial.until) {
        partial.frequency = 200 + next() * 1_800;
        partial.level = next();
        partial.until =
          index + Math.round((0.03 + next() * 0.3) * FINGERPRINT_SAMPLE_RATE);
      }
      partial.phase +=
        (2 * Math.PI * partial.frequency) / FINGERPRINT_SAMPLE_RATE;
      value += partial.level * Math.sin(partial.phase);
    }
    if (index % 400 === 0) noiseLevel = next() * 0.4;
    smoothed = 0.7 * smoothed + 0.3 * (next() - 0.5);
    samples[index] = value / 5 + smoothed * noiseLevel;
  }
  return samples;
}

/** Programme audio around a shared theme: `before` s, the theme, `after` s. */
function episode(
  theme: Float64Array,
  before: number,
  after: number,
  seed: number,
  gain: number,
): Int16Array {
  const lead = melody(before, seed);
  const tail = melody(after, seed + 1);
  const noise = random(seed + 2);
  const all = new Float64Array(lead.length + theme.length + tail.length);
  all.set(lead, 0);
  for (let index = 0; index < theme.length; index += 1) {
    all[lead.length + index] = theme[index]! * gain;
  }
  all.set(tail, lead.length + theme.length);
  const out = new Int16Array(all.length);
  for (let index = 0; index < all.length; index += 1) {
    const value = all[index]! * 0.6 + (noise() - 0.5) * 0.05;
    out[index] = Math.max(
      -32_768,
      Math.min(32_767, Math.round(value * 32_767)),
    );
  }
  return out;
}

const seconds = (words: number) => words * FINGERPRINT_SECONDS_PER_WORD;

describe("bitErrors", () => {
  it("counts differing bits", () => {
    expect(bitErrors(0, 0)).toBe(0);
    expect(bitErrors(0xffffffff, 0)).toBe(32);
    expect(bitErrors(0b1011, 0b0001)).toBe(2);
  });
});

// Each case fingerprints minutes of audio, which takes seconds on a busy machine.
describe("findSharedRegion", { timeout: 60_000 }, () => {
  const theme = melody(40, 7);

  it("finds a theme that sits at different times in two episodes", () => {
    const first = fingerprintPcm(episode(theme, 95, 60, 100, 1));
    const second = fingerprintPcm(episode(theme, 12, 90, 200, 0.7));

    const region = findSharedRegion(first, second, {
      minimumSeconds: 15,
      maximumSeconds: 180,
    });

    expect(region).not.toBeNull();
    expect(seconds(region!.leftStart)).toBeCloseTo(95, -0.5);
    expect(seconds(region!.leftEnd)).toBeCloseTo(135, -0.5);
    expect(seconds(region!.rightStart)).toBeCloseTo(12, -0.5);
    expect(seconds(region!.rightEnd)).toBeCloseTo(52, -0.5);
  });

  it("finds nothing between episodes that share no audio", () => {
    const first = fingerprintPcm(episode(melody(40, 11), 60, 60, 300, 1));
    const second = fingerprintPcm(episode(melody(40, 12), 60, 60, 400, 1));
    expect(
      findSharedRegion(first, second, {
        minimumSeconds: 15,
        maximumSeconds: 180,
      }),
    ).toBeNull();
  });

  it("ignores a shared stretch too short to be an intro", () => {
    const sting = melody(6, 21);
    const first = fingerprintPcm(episode(sting, 30, 30, 500, 1));
    const second = fingerprintPcm(episode(sting, 50, 30, 600, 1));
    expect(
      findSharedRegion(first, second, {
        minimumSeconds: 15,
        maximumSeconds: 180,
      }),
    ).toBeNull();
  });
});
