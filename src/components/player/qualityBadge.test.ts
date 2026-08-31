import { describe, expect, it } from "vitest";
import { qualityBadgeForHeight, qualityBadgeForLabel } from "./qualityBadge";

/**
 * Which renditions are worth tagging, and which are not.
 *
 * The tag says what tier a rendition belongs to, which the number beside it
 * does not. Everything ordinary is left untagged so the list stays readable.
 */

describe("tagging a rendition by height", () => {
  it("calls 2160p and above 4K", () => {
    expect(qualityBadgeForHeight(2160)).toBe("4K");
    expect(qualityBadgeForHeight(4320)).toBe("4K");
  });

  it("calls 1080p and 1440p HD", () => {
    expect(qualityBadgeForHeight(1440)).toBe("HD");
    expect(qualityBadgeForHeight(1080)).toBe("HD");
  });

  it("leaves everything below 1080p untagged", () => {
    for (const height of [720, 480, 360, 240, 144]) {
      expect(qualityBadgeForHeight(height)).toBeUndefined();
    }
  });

  it("says nothing when the height is unknown or nonsense", () => {
    expect(qualityBadgeForHeight(undefined)).toBeUndefined();
    expect(qualityBadgeForHeight(Number.NaN)).toBeUndefined();
    expect(qualityBadgeForHeight(Number.POSITIVE_INFINITY)).toBeUndefined();
  });
});

describe("tagging a rendition that only has a label", () => {
  /** The complete-file path names its renditions rather than measuring them. */
  it("reads the height out of the label when none was supplied", () => {
    expect(qualityBadgeForLabel("Original (2160p)")).toBe("4K");
    expect(qualityBadgeForLabel("1440p60 HDR")).toBe("HD");
    expect(qualityBadgeForLabel("720p60 HDR")).toBeUndefined();
  });

  /** A supplied height is the better evidence and wins over the text. */
  it("prefers the height it was given", () => {
    expect(qualityBadgeForLabel("Original", 2160)).toBe("4K");
    // The label mentions a rung the height contradicts; the height decides.
    expect(qualityBadgeForLabel("2160p source, downscaled", 720)).toBe("4K");
  });

  it("takes the last rung named in a label", () => {
    // "Original (2160p)" ends with the rung that describes it.
    expect(qualityBadgeForLabel("480p from 2160p master")).toBe("4K");
    expect(qualityBadgeForLabel("2160p master at 480p")).toBeUndefined();
  });

  it("says nothing for a label carrying no rung at all", () => {
    expect(qualityBadgeForLabel("Auto")).toBeUndefined();
    expect(qualityBadgeForLabel("")).toBeUndefined();
  });
});
