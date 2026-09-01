import { describe, expect, it } from "vitest";
import { resolvePlayerDuration } from "./usePlayerProgress";

describe("resolvePlayerDuration", () => {
  it("prefers the finite duration exposed by the media element", () => {
    expect(resolvePlayerDuration(120, 180)).toBe(120);
  });

  it("uses ffprobe duration while native HLS reports Infinity", () => {
    expect(resolvePlayerDuration(Number.POSITIVE_INFINITY, 9_039.2)).toBe(
      9_039.2,
    );
  });

  it("uses ffprobe duration while media metadata is still unknown", () => {
    expect(resolvePlayerDuration(Number.NaN, 9_039.2)).toBe(9_039.2);
  });

  it("never exposes an invalid fallback", () => {
    expect(resolvePlayerDuration(Number.NaN, Number.NaN)).toBe(0);
    expect(resolvePlayerDuration(0, -1)).toBe(0);
  });
});
