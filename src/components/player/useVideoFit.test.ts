import { afterEach, describe, expect, it } from "vitest";

import {
  classifyPinch,
  readStoredVideoFit,
  storeVideoFit,
} from "./useVideoFit";

describe("classifyPinch", () => {
  it("fills when the fingers spread far enough", () => {
    expect(classifyPinch(100, 120)).toBe("fill");
  });

  it("returns to the original when they close far enough", () => {
    expect(classifyPinch(120, 100)).toBe("original");
  });

  it("ignores a hesitant pinch either way", () => {
    expect(classifyPinch(100, 115)).toBeNull();
    expect(classifyPinch(100, 87)).toBeNull();
  });

  it("ignores a gesture with no measured start", () => {
    expect(classifyPinch(0, 50)).toBeNull();
  });
});

describe("stored video fit", () => {
  afterEach(() => {
    window.localStorage.clear();
  });

  it("starts in the original so the picture stays inside the safe area", () => {
    expect(readStoredVideoFit()).toBe("original");
  });

  it("remembers fill once chosen", () => {
    storeVideoFit("fill");
    expect(readStoredVideoFit()).toBe("fill");
    storeVideoFit("original");
    expect(readStoredVideoFit()).toBe("original");
  });
});
