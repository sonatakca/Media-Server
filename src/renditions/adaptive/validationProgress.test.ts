/**
 * Progress *inside* one verification check.
 *
 * The counter the page prints — "10 / 36" — is a count of checks that have
 * genuinely finished, and it must stay that way. But one of those checks walks
 * an eleven-gigabyte rendition looking for keyframes, and while it ran the
 * whole page stood still: the counter could not move, the phase's weighted bar
 * could not move, and an operator watching a healthy four-minute scan had no
 * way to tell it from a hang.
 *
 * `ffprobe -skip_frame nokey` was printing a presentation time per keyframe the
 * entire time. Nothing was reading them. These cases hold the rules for what
 * happens now that something does: the position is real, it never goes
 * backwards, it never exceeds the whole, and the rate and estimate derived from
 * it disappear when it stops arriving rather than counting down from a
 * measurement that has stopped being true.
 */

import { describe, expect, it } from "vitest";
import { createVerificationReporter, type PlannedCheck } from "./validation";
import { VERIFICATION_STALE_MS } from "./phaseProgress";
import type { VerificationPhaseProgress } from "./phaseProgress";

const PLAN: PlannedCheck[] = [
  { kind: "master-playlist", rendition: "package", weight: 1 },
  { kind: "video-probe", rendition: "2160p", weight: 1_000 },
  { kind: "video-probe", rendition: "1440p", weight: 500 },
];

function harness(startAt = 0) {
  const seen: VerificationPhaseProgress[] = [];
  let clock = startAt;
  const reporter = createVerificationReporter(
    PLAN,
    undefined,
    (progress) => seen.push(progress),
    () => clock,
  );
  return {
    reporter,
    seen,
    tick: (ms: number) => {
      clock += ms;
    },
    latest: () => seen[seen.length - 1]!,
    current: () => seen[seen.length - 1]!.current,
  };
}

describe("progress inside a media scan", () => {
  it("reports the fraction of the timeline the scan has reached", () => {
    const h = harness();
    h.reporter.begin("video-probe", "2160p", 300);
    for (const [index, pts] of [0, 60, 120, 180].entries()) {
      h.tick(1_000);
      h.reporter.advance(pts);
      expect(h.current()?.fraction).toBeCloseTo(index * 0.2, 5);
    }
    expect(h.current()?.currentMediaSeconds).toBe(180);
    expect(h.current()?.totalMediaSeconds).toBe(300);
  });

  /*
   * A container's timestamps are not promised to be sorted, and a scan that
   * repeats one is saying nothing new. Neither may move the bar backwards.
   */
  it("never goes backwards on a repeated or out-of-order timestamp", () => {
    const h = harness();
    h.reporter.begin("video-probe", "2160p", 300);
    h.tick(1_000);
    h.reporter.advance(150);
    const high = h.current()!.fraction!;
    h.tick(1_000);
    h.reporter.advance(90);
    h.tick(1_000);
    h.reporter.advance(150);
    expect(h.current()!.fraction).toBe(high);
  });

  it("clamps to the whole even if a timestamp runs past the declared length", () => {
    const h = harness();
    h.reporter.begin("video-probe", "2160p", 300);
    h.tick(1_000);
    h.reporter.advance(0);
    h.tick(1_000);
    h.reporter.advance(400);
    expect(h.current()!.fraction).toBe(1);
  });

  /*
   * A scan that begins at a non-zero presentation time has not already done
   * part of the work. Measuring from where it actually started is what keeps a
   * rendition with an offset timeline from opening at 40%.
   */
  it("measures from the first timestamp rather than from zero", () => {
    const h = harness();
    h.reporter.begin("video-probe", "2160p", 100);
    h.tick(1_000);
    h.reporter.advance(600);
    expect(h.current()!.fraction).toBe(0);
    h.tick(1_000);
    h.reporter.advance(650);
    expect(h.current()!.fraction).toBeCloseTo(0.5, 5);
  });

  it("still reports usefully when keyframes are sparse", () => {
    const h = harness();
    h.reporter.begin("video-probe", "2160p", 600);
    h.reporter.advance(0);
    h.tick(30_000);
    h.reporter.advance(300);
    expect(h.current()!.fraction).toBeCloseTo(0.5, 5);
  });

  it("gives no fraction for a check that reads no timeline", () => {
    const h = harness();
    h.reporter.begin("master-playlist", "package");
    expect(h.current()!.fraction).toBeUndefined();
    expect(h.current()!.kind).toBe("master-playlist");
  });
});

describe("the completed-check counter", () => {
  it("moves only when a check finishes, however far the scan has got", () => {
    const h = harness();
    h.reporter.begin("video-probe", "2160p", 300);
    h.tick(1_000);
    h.reporter.advance(290);
    expect(h.latest().completedChecks).toBe(0);
    h.reporter.complete("video-probe", "2160p");
    expect(h.latest().completedChecks).toBe(1);
  });

  /*
   * A scan's last keyframe is a keyframe, not the end of the file: there is
   * always a final segment after it. The check finishing is what completes it.
   */
  it("completes fully even though the last keyframe falls short of the end", () => {
    const h = harness();
    h.reporter.begin("video-probe", "2160p", 300);
    h.tick(1_000);
    h.reporter.advance(298);
    expect(h.latest().fraction).toBeLessThan(1);
    h.reporter.complete("video-probe", "2160p");
    expect(h.latest().completedWeight).toBe(1_000);
    expect(h.latest().current).toBeUndefined();
  });

  it("starts the next rendition from nothing", () => {
    const h = harness();
    h.reporter.begin("video-probe", "2160p", 300);
    h.tick(1_000);
    h.reporter.advance(300);
    h.reporter.complete("video-probe", "2160p");
    h.reporter.begin("video-probe", "1440p", 300);
    expect(h.current()!.rendition).toBe("1440p");
    // A check that has just begun is at nothing, not at the previous one's end.
    expect(h.current()!.fraction).toBe(0);
    expect(h.current()!.currentMediaSeconds).toBeUndefined();
    expect(h.current()!.rate).toBeUndefined();
  });
});

describe("the phase bar while one check runs", () => {
  it("advances as the running check advances", () => {
    const h = harness();
    h.reporter.begin("video-probe", "2160p", 300);
    h.tick(1_000);
    h.reporter.advance(0);
    const opening = h.latest().fraction;
    h.tick(1_000);
    h.reporter.advance(150);
    expect(h.latest().fraction).toBeGreaterThan(opening);
    // Half of the 1000-weight check, against a plan weighing 1501.
    expect(h.latest().fraction).toBeCloseTo(500 / 1501, 4);
  });

  it("never reaches the whole while a check is still running", () => {
    const h = harness();
    h.reporter.begin("video-probe", "2160p", 300);
    h.tick(1_000);
    h.reporter.advance(300);
    expect(h.latest().fraction).toBeLessThan(1);
  });
});

describe("the scanning rate and what is left", () => {
  it("appears once enough of the window has been seen", () => {
    const h = harness();
    h.reporter.begin("video-probe", "2160p", 3_000);
    h.tick(1_000);
    h.reporter.advance(0);
    expect(h.current()!.rate).toBeUndefined();
    h.tick(2_000);
    h.reporter.advance(60);
    // 60 media seconds in 2 wall seconds.
    expect(h.current()!.rate).toBeCloseTo(30, 1);
    expect(h.current()!.etaSeconds).toBe(Math.round((3_000 - 60) / 30));
  });

  /*
   * Withdrawn rather than left counting down. An estimate derived from a scan
   * that has stopped is the one number on the page guaranteed to be wrong.
   */
  it("is withdrawn once the scan stops reporting", () => {
    const h = harness();
    h.reporter.begin("video-probe", "2160p", 3_000);
    h.tick(1_000);
    h.reporter.advance(0);
    h.tick(2_000);
    h.reporter.advance(60);
    expect(h.current()!.rate).toBeDefined();

    // The scan goes quiet; the next thing it says repeats where it already was.
    h.tick(VERIFICATION_STALE_MS + 1_000);
    h.reporter.advance(60);
    const step = h.current()!;
    expect(step.rate).toBeUndefined();
    expect(step.etaSeconds).toBeUndefined();
  });

  it("marks a scan that has gone quiet, without losing which one it is", () => {
    const h = harness();
    h.reporter.begin("video-probe", "2160p", 3_000);
    h.tick(1_000);
    h.reporter.advance(0);
    h.tick(1_000);
    h.reporter.advance(10);
    h.tick(VERIFICATION_STALE_MS + 500);
    // A repeated timestamp is not progress, but it re-evaluates staleness.
    h.reporter.advance(10);
    const step = h.current()!;
    expect(step.stalled).toBe(true);
    expect(step.rendition).toBe("2160p");
    expect(step.currentMediaSeconds).toBeGreaterThan(0);
  });
});
