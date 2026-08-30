import { describe, expect, it } from "vitest";
import { titlePackageCoversVideoLadder } from "./packager";

describe("adaptive package completeness", () => {
  it("does not skip a matching package when the current ladder gained 1440p", () => {
    const existing = {
      video: [2160, 1080, 720, 480, 360, 240, 144].map((qualityHeight) => ({
        qualityHeight,
      })),
    };
    const required = [2160, 1440, 1080, 720, 480, 360, 240, 144].map(
      (qualityHeight) => ({ qualityHeight }),
    );

    expect(titlePackageCoversVideoLadder(existing, required)).toBe(false);
  });

  it("skips when every required rung is already present", () => {
    const required = [2160, 1440, 1080].map((qualityHeight) => ({
      qualityHeight,
    }));

    expect(titlePackageCoversVideoLadder({ video: required }, required)).toBe(
      true,
    );
  });
});
