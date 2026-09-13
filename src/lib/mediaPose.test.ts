// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  getMediaPose,
  getMediaPoseStyle,
  MEDIA_POSE_RANGES,
  type MediaPoseKind,
} from "./mediaPose";

const ids = Array.from(
  { length: 400 },
  (_, index) => `item-${index.toString(36)}-${(index * 7919) % 1009}`,
);
const kinds = Object.keys(MEDIA_POSE_RANGES) as MediaPoseKind[];

describe("getMediaPose", () => {
  it("gives an item the same pose every time it is asked", () => {
    for (const kind of kinds) {
      for (const id of ids.slice(0, 20)) {
        expect(getMediaPose(id, kind)).toEqual(getMediaPose(id, kind));
      }
    }
  });

  it("keeps an item's pose when it moves to a different slot", () => {
    const sorted = [...ids].sort();
    const byName = new Map(ids.map((id) => [id, getMediaPose(id, "poster")]));

    for (const id of sorted) {
      expect(getMediaPose(id, "poster")).toEqual(byName.get(id));
    }
  });

  it("stays inside each card class's ranges and never sits dead level", () => {
    for (const kind of kinds) {
      const range = MEDIA_POSE_RANGES[kind];

      for (const id of ids) {
        const pose = getMediaPose(id, kind);
        const turn = Math.abs(pose.hoverRotate - pose.rotate);

        expect(Math.abs(pose.rotate)).toBeLessThanOrEqual(range.rest);
        expect(Math.abs(pose.rotate)).toBeGreaterThanOrEqual(
          range.rest * range.floor - 0.01,
        );
        expect(Math.abs(pose.hoverRotate)).toBeLessThanOrEqual(
          range.hoverLimit + 0.01,
        );
        expect(turn).toBeGreaterThanOrEqual(range.turnMin - 0.02);
        expect(turn).toBeLessThanOrEqual(range.turnMax + 0.02);
        expect(Math.abs(pose.y)).toBeLessThanOrEqual(range.y);
        expect(Math.abs(pose.x)).toBeLessThanOrEqual(range.x);
      }
    }
  });

  it("gives an information-dense card less lean than a bare poster", () => {
    const median = (kind: MediaPoseKind) => {
      const leans = ids
        .map((id) => Math.abs(getMediaPose(id, kind).rotate))
        .sort((a, b) => a - b);
      return leans[Math.floor(leans.length / 2)];
    };

    expect(median("dense")).toBeLessThan(median("landscape"));
    expect(median("landscape")).toBeLessThan(median("poster"));
  });

  it("leans both ways, turns both ways, and has no fixed alternation", () => {
    const poses = ids.map((id) => getMediaPose(id, "poster"));
    const leftShare =
      poses.filter((pose) => pose.rotate < 0).length / poses.length;
    const crossesLevel = poses.filter(
      (pose) => Math.sign(pose.rotate) !== Math.sign(pose.hoverRotate),
    ).length;
    const leansFurther = poses.filter(
      (pose) =>
        Math.sign(pose.rotate) === Math.sign(pose.hoverRotate) &&
        Math.abs(pose.hoverRotate) > Math.abs(pose.rotate),
    ).length;
    // Neighbours that alternate sign every time would be the grid showing
    // through; a random lean alternates about half the time.
    const alternations = poses
      .slice(1)
      .filter(
        (pose, index) =>
          Math.sign(pose.rotate) !== Math.sign(poses[index].rotate),
      ).length;

    expect(leftShare).toBeGreaterThan(0.35);
    expect(leftShare).toBeLessThan(0.65);
    expect(crossesLevel).toBeGreaterThan(0);
    expect(leansFurther).toBeGreaterThan(0);
    expect(alternations / (poses.length - 1)).toBeLessThan(0.7);
  });
});

describe("getMediaPoseStyle", () => {
  it("writes the custom properties the stylesheet reads", () => {
    const style = getMediaPoseStyle("dune", "poster") as Record<string, string>;
    const pose = getMediaPose("dune", "poster");

    expect(style["--media-rest-rotate"]).toBe(`${pose.rotate}deg`);
    expect(style["--media-hover-rotate"]).toBe(`${pose.hoverRotate}deg`);
    expect(style["--media-rest-x"]).toBe(`${pose.x}px`);
    expect(style["--media-rest-y"]).toBe(`${pose.y}px`);
  });
});
