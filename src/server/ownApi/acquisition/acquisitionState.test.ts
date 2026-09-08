// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  ACQUISITION_STATES,
  AcquisitionTransitionError,
  assertTransition,
  canTransition,
  dispositionFor,
  expectsExternalJob,
  isActive,
  isTerminal,
  MAX_ATTEMPTS_PER_RELEASE,
  planRetry,
  TERMINAL_STATES,
  type AcquisitionState,
  type FailureClass,
} from "./acquisitionState";

describe("the shape of the state machine", () => {
  it("lets a normal acquisition run to completion", () => {
    const path: AcquisitionState[] = [
      "planned",
      "resolving",
      "submitting",
      "queued",
      "downloading",
      "processing",
      "downloaded",
    ];
    for (let index = 0; index < path.length - 1; index += 1) {
      expect(canTransition(path[index]!, path[index + 1]!)).toBe(true);
    }
  });

  it("allows a forward skip, because SABnzbd is polled and not subscribed", () => {
    /*
     * Between two reads a job can move several steps. Insisting on passing
     * through every one would mean either inventing a state that never
     * happened or refusing the truth.
     */
    expect(canTransition("queued", "downloaded")).toBe(true);
    expect(canTransition("submitting", "downloaded")).toBe(true);
    expect(canTransition("downloading", "downloaded")).toBe(true);
  });

  it("can adopt a job found in any state before submitting", () => {
    /*
     * Crash recovery: an earlier attempt may have left a job that is already
     * downloading, or even finished. Refusing to adopt it would mean sending
     * the NZB again.
     */
    for (const found of [
      "queued",
      "downloading",
      "processing",
      "downloaded",
      "failed",
    ] as const) {
      expect(canTransition("resolving", found)).toBe(true);
    }
  });

  it("never allows a backward move", () => {
    expect(canTransition("downloading", "queued")).toBe(false);
    expect(canTransition("processing", "downloading")).toBe(false);
    expect(canTransition("queued", "submitting")).toBe(false);
    expect(canTransition("submitting", "resolving")).toBe(false);
  });

  it("treats re-observing the same state as legal", () => {
    // A poll that finds nothing changed must not be an error.
    for (const state of ACQUISITION_STATES) {
      expect(canTransition(state, state)).toBe(true);
    }
  });

  it.each(TERMINAL_STATES)("lets nothing leave %s", (state) => {
    for (const other of ACQUISITION_STATES) {
      if (other === state) continue;
      expect(canTransition(state, other)).toBe(false);
    }
    expect(isTerminal(state)).toBe(true);
  });

  it("does not treat failed as terminal, because a person may retry it", () => {
    expect(isTerminal("failed")).toBe(false);
    expect(canTransition("failed", "awaiting_retry")).toBe(true);
    expect(canTransition("failed", "superseded")).toBe(true);
    // But it is not active either: nothing happens without an operator.
    expect(isActive("failed")).toBe(false);
  });

  it("can be cancelled from anywhere that is still running", () => {
    for (const state of ACQUISITION_STATES) {
      if (isTerminal(state)) continue;
      expect(canTransition(state, "cancelled")).toBe(true);
    }
  });

  it("cannot pretend a finished download never happened", () => {
    expect(canTransition("downloaded", "cancelled")).toBe(false);
    expect(canTransition("downloaded", "failed")).toBe(false);
  });

  it("throws with both states named when a transition is illegal", () => {
    expect(() => assertTransition("downloaded", "downloading")).toThrow(
      AcquisitionTransitionError,
    );
    expect(() => assertTransition("downloaded", "downloading")).toThrow(
      /downloaded to downloading/,
    );
    expect(() => assertTransition("planned", "resolving")).not.toThrow();
  });

  it("knows which states imply SABnzbd should know about the job", () => {
    expect(expectsExternalJob("submitting")).toBe(true);
    expect(expectsExternalJob("downloading")).toBe(true);
    expect(expectsExternalJob("planned")).toBe(false);
    expect(expectsExternalJob("downloaded")).toBe(false);
  });

  it("has no state that can reach nothing and is not terminal", () => {
    for (const state of ACQUISITION_STATES) {
      if (isTerminal(state)) continue;
      const reachable = ACQUISITION_STATES.filter(
        (other) => other !== state && canTransition(state, other),
      );
      expect(reachable.length).toBeGreaterThan(0);
    }
  });
});

describe("what a failure means", () => {
  it.each([
    ["indexer-unavailable", "retry"],
    ["sab-unavailable", "retry"],
    ["submission-timeout", "retry"],
    ["disk-full", "retry"],
    ["nzb-unavailable", "try-another-release"],
    ["missing-articles", "try-another-release"],
    ["repair-failed", "try-another-release"],
    ["unpack-failed", "try-another-release"],
    ["password-required", "try-another-release"],
    ["indexer-auth", "terminal"],
    ["sab-auth", "terminal"],
    ["removed-externally", "terminal"],
    ["cancelled", "terminal"],
    ["unknown", "terminal"],
  ] as const)("treats %s as %s", (failure, disposition) => {
    expect(dispositionFor(failure)).toBe(disposition);
  });

  it("never retries a release that will fail the same way again", () => {
    // A password will still be required next time, and next week.
    for (const failure of [
      "password-required",
      "missing-articles",
      "repair-failed",
    ] as const) {
      expect(planRetry(failure, 1).action).toBe("try-another-release");
      expect(planRetry(failure, 1).delayMs).toBe(0);
    }
  });

  it("retries a transient failure, with a growing gap", () => {
    const first = planRetry("sab-unavailable", 1, 1_000);
    const second = planRetry("sab-unavailable", 2, 1_000);
    expect(first.action).toBe("retry");
    expect(second.action).toBe("retry");
    expect(second.delayMs).toBeGreaterThan(first.delayMs);
  });

  it("stops retrying the same release and asks for another one", () => {
    const exhausted = planRetry(
      "sab-unavailable",
      MAX_ATTEMPTS_PER_RELEASE,
      1_000,
    );
    expect(exhausted.action).toBe("try-another-release");
    expect(exhausted.detail).toContain(String(MAX_ATTEMPTS_PER_RELEASE));
  });

  it("cannot loop, whatever the failure or the attempt count", () => {
    const classes: FailureClass[] = [
      "indexer-unavailable",
      "sab-unavailable",
      "submission-timeout",
      "disk-full",
      "nzb-unavailable",
      "missing-articles",
      "repair-failed",
      "unpack-failed",
      "password-required",
      "indexer-auth",
      "sab-auth",
      "removed-externally",
      "cancelled",
      "unknown",
    ];
    for (const failure of classes) {
      for (let attempt = 1; attempt <= 20; attempt += 1) {
        const plan = planRetry(failure, attempt);
        expect(["retry", "try-another-release", "terminal"]).toContain(
          plan.action,
        );
        // Past the cap, no class may still be asking for the same release.
        if (attempt > MAX_ATTEMPTS_PER_RELEASE) {
          expect(plan.action).not.toBe("retry");
        }
      }
    }
  });

  it("gives an authentication failure no retry at all", () => {
    for (const failure of ["indexer-auth", "sab-auth"] as const) {
      expect(planRetry(failure, 1).action).toBe("terminal");
    }
  });
});
