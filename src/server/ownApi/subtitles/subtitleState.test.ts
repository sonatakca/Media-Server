import { describe, expect, it } from "vitest";
import {
  assertTransition,
  canTransition,
  dispositionFor,
  DOWNLOADABLE_SUBTITLE_FORMATS,
  formatFromExtension,
  isAcceptable,
  isDownloadableFormat,
  isTerminal,
  MAX_SUBTITLE_ATTEMPTS,
  needsReconciliation,
  normalizeWant,
  planSubtitleRetry,
  satisfiesSameWant,
  SCORE_DIMENSIONS,
  scoreOf,
  SUBTITLE_STATES,
  SubtitleTransitionError,
  wantIsSatisfiedBy,
  type ScoreComponent,
  type SubtitleFailureClass,
} from "./subtitleState";

/**
 * The subtitle domain, pinned at the decisions that are easy to undo by
 * accident. Nothing here touches a filesystem, a provider or a database.
 */

describe("what a subtitle is", () => {
  it("reads a format from an extension, in either case", () => {
    expect(formatFromExtension(".srt")).toBe("srt");
    expect(formatFromExtension(".ASS")).toBe("ass");
    expect(formatFromExtension(".mkv")).toBeNull();
  });

  /*
   * `.sub` is read where it already exists and is never downloaded: it is
   * usually VobSub, which is images, and an image track cannot be converted to
   * WebVTT without OCR. A search that returned one would install a track the
   * player cannot show.
   */
  it("will not download the one format it can only read", () => {
    expect(isDownloadableFormat("srt")).toBe(true);
    expect(isDownloadableFormat("sub")).toBe(false);
    expect(DOWNLOADABLE_SUBTITLE_FORMATS).not.toContain("sub");
  });

  it("treats two tracks as the same answer regardless of format", () => {
    const srt = { language: "tur", forced: false, hearingImpaired: false };
    const ass = { language: "tur", forced: false, hearingImpaired: false };
    expect(satisfiesSameWant(srt, ass)).toBe(true);
  });

  it("does not confuse a forced track with a full one", () => {
    expect(
      satisfiesSameWant(
        { language: "tur", forced: true, hearingImpaired: false },
        { language: "tur", forced: false, hearingImpaired: false },
      ),
    ).toBe(false);
  });
});

describe("what somebody wants", () => {
  it("normalises the language and fills the defaults", () => {
    expect(normalizeWant({ language: "TR" })).toEqual({
      language: "tur",
      forced: false,
      hearingImpaired: "indifferent",
    });
  });

  /*
   * The preference scores, it does not filter. Refusing to call a want
   * satisfied because the only Turkish subtitle on disk is not the SDH one
   * would keep searching for ever over a file that is already watchable, and
   * would hammer a provider for it.
   */
  it("is satisfied by a track that ignores the hearing-impaired preference", () => {
    const want = normalizeWant({ language: "tur", hearingImpaired: "prefer" });
    expect(wantIsSatisfiedBy(want, { language: "tur", forced: false })).toBe(
      true,
    );
  });

  it("is not satisfied by the wrong forced status or the wrong language", () => {
    const want = normalizeWant({ language: "tur" });
    expect(wantIsSatisfiedBy(want, { language: "tur", forced: true })).toBe(
      false,
    );
    expect(wantIsSatisfiedBy(want, { language: "eng", forced: false })).toBe(
      false,
    );
  });

  /* Nothing can satisfy a want for a language nobody named. */
  it("cannot be satisfied when the language is unknown", () => {
    const want = normalizeWant({ language: "" });
    expect(want.language).toBe("und");
    expect(wantIsSatisfiedBy(want, { language: "und", forced: false })).toBe(
      false,
    );
  });
});

describe("the states an attempt moves through", () => {
  it("allows only the transitions the workflow has", () => {
    expect(canTransition("wanted", "searching")).toBe(true);
    expect(canTransition("searching", "selected")).toBe(true);
    expect(canTransition("selected", "downloading")).toBe(true);
    expect(canTransition("downloading", "validating")).toBe(true);
    expect(canTransition("validating", "installed")).toBe(true);

    expect(canTransition("wanted", "installed")).toBe(false);
    expect(canTransition("searching", "downloading")).toBe(false);
    expect(canTransition("installed", "wanted")).toBe(false);
  });

  it("throws with both ends named", () => {
    expect(() => assertTransition("wanted", "installed")).toThrow(
      SubtitleTransitionError,
    );
    expect(() => assertTransition("wanted", "installed")).toThrow(
      /cannot go from wanted to installed/,
    );
  });

  /*
   * The property that makes authentication a pause. Every step that can talk to
   * a provider can leave for `needs-authentication`, and it can come back to
   * whichever step asked — otherwise a session expiring during a download would
   * mean searching again from nothing.
   */
  it("lets any provider step pause for authentication and resume where it was", () => {
    for (const step of ["searching", "selected", "downloading"] as const) {
      expect(canTransition(step, "needs-authentication")).toBe(true);
      expect(canTransition("needs-authentication", step)).toBe(true);
    }
  });

  it("does not let validation pause: there is no provider left to ask", () => {
    expect(canTransition("validating", "needs-authentication")).toBe(false);
  });

  it("lets a want be raised again after it failed or came back empty", () => {
    expect(canTransition("failed", "wanted")).toBe(true);
    expect(canTransition("unavailable", "wanted")).toBe(true);
  });

  it("has exactly one success and no way out of superseded", () => {
    const successors = SUBTITLE_STATES.filter((s) =>
      canTransition("validating", s),
    );
    expect(successors).toContain("installed");
    expect(
      SUBTITLE_STATES.filter((s) => canTransition("superseded", s)),
    ).toEqual([]);
  });

  it("knows which states end an attempt and which need reality read", () => {
    expect(isTerminal("installed")).toBe(true);
    expect(isTerminal("failed")).toBe(true);
    expect(isTerminal("needs-authentication")).toBe(false);
    expect(needsReconciliation("downloading")).toBe(true);
    expect(needsReconciliation("validating")).toBe(true);
    expect(needsReconciliation("searching")).toBe(false);
  });

  it("gives every state a transition entry", () => {
    for (const state of SUBTITLE_STATES) {
      expect(() => canTransition(state, "superseded")).not.toThrow();
    }
  });
});

describe("what a failure means", () => {
  it.each([
    ["provider-timeout", "retry"],
    ["provider-error", "retry"],
    ["provider-rate-limited", "retry"],
    ["destination-locked", "retry"],
    ["disk-full", "retry"],
    ["authentication-required", "paused"],
    ["commit-ambiguous", "reconcile"],
    ["media-missing", "attention"],
    ["no-provider", "attention"],
    ["payload-invalid", "terminal"],
    ["path-escape", "terminal"],
    ["unknown", "terminal"],
  ] as const)("reads %s as %s", (failure, disposition) => {
    expect(dispositionFor(failure)).toBe(disposition);
  });

  /*
   * The distinction this domain exists to make. A session that aged out is not
   * a fault of the media, the request or the software, and putting it in the
   * same queue as a corrupt payload would bury it.
   */
  it("separates waiting for a person from asking one to look", () => {
    expect(dispositionFor("authentication-required")).toBe("paused");
    expect(dispositionFor("media-missing")).toBe("attention");
  });
});

describe("planning the next attempt", () => {
  it("spends no attempt on waiting for a person", () => {
    const plan = planSubtitleRetry("authentication-required", 1);
    expect(plan.action).toBe("paused");
    expect(plan.delayMs).toBe(0);
  });

  it("backs off, doubling, and stops doubling at ten minutes", () => {
    const delays = [1, 2, 3, 4].map(
      (attempt) => planSubtitleRetry("provider-timeout", attempt).delayMs,
    );
    expect(delays).toEqual([10_000, 20_000, 40_000, 80_000]);
    expect(
      planSubtitleRetry("provider-timeout", 20).delayMs,
    ).toBeLessThanOrEqual(600_000);
  });

  it("asks a person once the attempts are spent", () => {
    const plan = planSubtitleRetry("provider-timeout", MAX_SUBTITLE_ATTEMPTS);
    expect(plan.action).toBe("attention");
    expect(plan.detail).toContain(String(MAX_SUBTITLE_ATTEMPTS));
  });

  it("does not retry what retrying cannot fix", () => {
    for (const failure of [
      "payload-invalid",
      "path-escape",
      "no-provider",
    ] as const satisfies readonly SubtitleFailureClass[]) {
      expect(planSubtitleRetry(failure, 1).delayMs).toBe(0);
      expect(planSubtitleRetry(failure, 1).action).not.toBe("retry");
    }
  });
});

describe("scoring a candidate", () => {
  const component = (
    dimension: keyof typeof SCORE_DIMENSIONS,
    matched: boolean,
  ): ScoreComponent => ({
    dimension,
    weight: SCORE_DIMENSIONS[dimension],
    matched,
    detail: `${dimension} ${matched ? "matched" : "did not match"}`,
  });

  it("adds only what matched, and says what the maximum was", () => {
    const score = scoreOf([
      component("identity", true),
      component("releaseGroup", true),
      component("resolution", false),
    ]);
    expect(score.total).toBe(
      SCORE_DIMENSIONS.identity + SCORE_DIMENSIONS.releaseGroup,
    );
    expect(score.maximum).toBe(
      SCORE_DIMENSIONS.identity +
        SCORE_DIMENSIONS.releaseGroup +
        SCORE_DIMENSIONS.resolution,
    );
  });

  /* A number nobody can argue with is the wrong property for a decision that
   * silently changes what somebody watches. */
  it("explains itself, heaviest reason first", () => {
    const score = scoreOf([
      component("resolution", true),
      component("identity", true),
      component("source", false),
    ]);
    expect(score.reasons).toEqual(["identity matched", "resolution matched"]);
  });

  it("refuses a candidate that is not the same episode, however well it scores", () => {
    const wrongEpisode = scoreOf([
      component("identity", false),
      component("hashMatch", true),
      component("releaseGroup", true),
      component("source", true),
      component("resolution", true),
    ]);
    expect(wrongEpisode.total).toBeGreaterThan(0);
    expect(isAcceptable(wrongEpisode)).toBe(false);

    expect(isAcceptable(scoreOf([component("identity", true)]))).toBe(true);
  });

  it("ranks a right-episode/wrong-release above a wrong-episode/right-release", () => {
    const rightEpisode = scoreOf([
      component("identity", true),
      component("releaseGroup", false),
      component("source", false),
      component("resolution", false),
    ]);
    const wrongEpisode = scoreOf([
      component("identity", false),
      component("releaseGroup", true),
      component("source", true),
      component("resolution", true),
    ]);
    expect(rightEpisode.total).toBeGreaterThan(wrongEpisode.total);
  });
});
