/**
 * What the bottom-right corner reservation promises.
 *
 * The pile reads one number, so the claims behind it have to collapse to one
 * without either claimant being able to cut the other short: the tallest wins
 * while it stands, and the property disappears entirely once nobody is there.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  claimBottomChrome,
  getBottomChrome,
  releaseBottomChrome,
  subscribeToBottomChrome,
} from "./bottomChrome";

const read = () =>
  document.documentElement.style.getPropertyValue("--seyirlik-bottom-chrome");

afterEach(() => {
  releaseBottomChrome("a");
  releaseBottomChrome("b");
});

describe("bottom chrome claims", () => {
  it("publishes a claim as a length", () => {
    claimBottomChrome("a", 162);

    expect(read()).toBe("162px");
  });

  it("clears the property when the last claim goes", () => {
    claimBottomChrome("a", 162);
    releaseBottomChrome("a");

    expect(read()).toBe("");
  });

  it("keeps the tallest claim while two overlap", () => {
    claimBottomChrome("a", 162);
    claimBottomChrome("b", 96);

    expect(read()).toBe("162px");
  });

  it("does not let a shorter claimant leaving cut the taller one short", () => {
    claimBottomChrome("a", 162);
    claimBottomChrome("b", 96);
    releaseBottomChrome("b");

    expect(read()).toBe("162px");
  });

  it("falls back to the remaining claim when the tallest leaves", () => {
    claimBottomChrome("a", 162);
    claimBottomChrome("b", 96);
    releaseBottomChrome("a");

    expect(read()).toBe("96px");
  });

  it("follows a claimant that reports a new height", () => {
    claimBottomChrome("a", 162);
    claimBottomChrome("a", 130);

    expect(read()).toBe("130px");
  });
});

/*
 * The pile has to travel the distance rather than teleport it, which means
 * knowing the reservation moved — and only when it actually did, since every
 * announcement costs the pile an animation.
 */
describe("bottom chrome subscriptions", () => {
  it("announces a claim arriving, changing, and leaving", () => {
    const seen: number[] = [];
    const stop = subscribeToBottomChrome(() => seen.push(getBottomChrome()));

    claimBottomChrome("a", 162);
    claimBottomChrome("a", 130);
    releaseBottomChrome("a");
    stop();

    expect(seen).toEqual([162, 130, 0]);
  });

  it("stays quiet when nothing about the reservation moved", () => {
    claimBottomChrome("a", 162);
    let announcements = 0;
    const stop = subscribeToBottomChrome(() => (announcements += 1));

    claimBottomChrome("a", 162);
    releaseBottomChrome("b");
    stop();

    expect(announcements).toBe(0);
  });

  it("stops announcing to a listener that has unsubscribed", () => {
    let announcements = 0;
    subscribeToBottomChrome(() => (announcements += 1))();

    claimBottomChrome("a", 162);

    expect(announcements).toBe(0);
  });
});
