import { describe, expect, it } from "vitest";
import {
  decideNativeReplan,
  nativeQualityRequestKey,
} from "./nativeQualityRequest";

/**
 * Not starting a second re-plan on top of one that has not landed.
 *
 * The bug: choosing an exact rendition set the locked id, which re-ran the
 * effect that reapplies the saved preference, which asked for the same
 * rendition again — while the first request was still in flight. The guard
 * only compared against the *attached* URL, which had not changed yet, so it
 * said "not applied" and started another re-plan. Each replaced the source
 * again, so none ever attached: black picture, no decoded frame, clock stopped.
 */

const nothingAttached = { qualityHeight: null, maxHeight: null };

describe("deciding whether to start a native re-plan", () => {
  it("starts one for a genuinely new request", () => {
    expect(
      decideNativeReplan({ qualityHeight: 144 }, nothingAttached, null),
    ).toBe("start");
  });

  /** The exact sequence that stalled the player. */
  it("refuses to start a second re-plan for a request already in flight", () => {
    const desired = { qualityHeight: 144, maxHeight: null };
    const pending = nativeQualityRequestKey(desired);

    // The URL still describes the old source, because attaching takes time.
    expect(decideNativeReplan(desired, nothingAttached, pending)).toBe(
      "in-flight",
    );
  });

  it("reports nothing to do once the request has attached", () => {
    const desired = { qualityHeight: 144, maxHeight: null };
    expect(
      decideNativeReplan(desired, { qualityHeight: 144, maxHeight: null }, null),
    ).toBe("attached");
    // Even while still marked pending, an attached request is finished.
    expect(
      decideNativeReplan(
        desired,
        { qualityHeight: 144, maxHeight: null },
        nativeQualityRequestKey(desired),
      ),
    ).toBe("attached");
  });

  /** A newer choice must not be blocked by an older one still in flight. */
  it("starts a different request even while another is outstanding", () => {
    const inFlight = nativeQualityRequestKey({ qualityHeight: 144 });
    expect(
      decideNativeReplan({ qualityHeight: 1080 }, nothingAttached, inFlight),
    ).toBe("start");
  });

  /**
   * An exact lock and a ceiling of the same number are different requests: one
   * pins a rendition, the other leaves ABR free beneath it.
   */
  it("tells an exact lock apart from a ceiling at the same height", () => {
    expect(nativeQualityRequestKey({ qualityHeight: 1080 })).not.toBe(
      nativeQualityRequestKey({ maxHeight: 1080 }),
    );
    expect(
      decideNativeReplan(
        { maxHeight: 1080 },
        { qualityHeight: 1080, maxHeight: null },
        null,
      ),
    ).toBe("start");
  });

  /** Auto asks for neither, and matches a source carrying neither. */
  it("treats Auto's empty request as attached when nothing is pinned", () => {
    expect(decideNativeReplan({}, nothingAttached, null)).toBe("attached");
    expect(
      decideNativeReplan({}, { qualityHeight: 144, maxHeight: null }, null),
    ).toBe("start");
  });
});
