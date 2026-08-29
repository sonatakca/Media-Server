import { describe, expect, it } from "vitest";
import { getDisplaySeekPoint } from "./SeekBar";

describe("getDisplaySeekPoint", () => {
  it("preserves arbitrary second targets instead of snapping to three-second boundaries", () => {
    expect(getDisplaySeekPoint(4, 300)).toBe(4);
    expect(getDisplaySeekPoint(5, 300)).toBe(5);
    expect(getDisplaySeekPoint(4.25, 300)).toBe(4.25);
  });

  it("clamps targets to the playable duration", () => {
    expect(getDisplaySeekPoint(-1, 300)).toBe(0);
    expect(getDisplaySeekPoint(301, 300)).toBe(300);
  });
});
