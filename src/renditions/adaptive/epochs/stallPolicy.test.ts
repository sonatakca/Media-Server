/**
 * The two thresholds, and the reason they are two.
 *
 * A single figure cannot answer both "should the page still claim a rate?" and
 * "is this process worth waiting for?". The first is short and reversible; the
 * second ends an attempt and, on the drive this was built for, has to fire well
 * inside the 35 seconds the kernel spends retrying one bad sector.
 */

import { describe, expect, it } from "vitest";
import {
  HARD_STALL_AFTER_MS,
  SOFT_STALL_AFTER_MS,
  SOURCE_PROBE_TIMEOUT_MS,
  STARTUP_STALL_AFTER_MS,
  stallThresholds,
} from "./stallPolicy";

describe("the shipped thresholds", () => {
  it("fires the watchdog before the disk finishes retrying one sector", () => {
    // Measured on the failing volume: 35-37s for a single application read to
    // return EIO. Terminating inside that window is what stops FFmpeg learning
    // of the first failure and moving on to the next bad block.
    expect(HARD_STALL_AFTER_MS).toBeLessThan(35_000);
  });

  it("leaves the soft state visibly distinct from the hard one", () => {
    expect(SOFT_STALL_AFTER_MS).toBeLessThan(HARD_STALL_AFTER_MS / 2);
  });

  it("gives a seek far more room than a stall", () => {
    // An accurate `-ss` reports nothing until the first frame it keeps, which
    // on a large source decoded in software is legitimately slow.
    expect(STARTUP_STALL_AFTER_MS).toBeGreaterThan(HARD_STALL_AFTER_MS * 2);
  });

  it("bounds the diagnosis more tightly than the thing it diagnoses", () => {
    expect(SOURCE_PROBE_TIMEOUT_MS).toBeLessThan(HARD_STALL_AFTER_MS);
  });
});

describe("stallThresholds", () => {
  it("uses the shipped figures when nothing is configured", () => {
    expect(stallThresholds({})).toEqual({
      softStallMs: SOFT_STALL_AFTER_MS,
      hardStallMs: HARD_STALL_AFTER_MS,
      startupStallMs: STARTUP_STALL_AFTER_MS,
      terminationGraceMs: 10_000,
      sourceProbeTimeoutMs: SOURCE_PROBE_TIMEOUT_MS,
    });
  });

  it("lets a deployment with slower storage be more patient", () => {
    const thresholds = stallThresholds({
      SEYIRLIK_HARD_STALL_MS: "90000",
      SEYIRLIK_SOFT_STALL_MS: "10000",
    });
    expect(thresholds.hardStallMs).toBe(90_000);
    expect(thresholds.softStallMs).toBe(10_000);
  });

  it("refuses a configuration that would kill healthy encodes", () => {
    // A typo must not produce a watchdog that fires during normal startup, and
    // the hard threshold can never fall to or below the soft one.
    expect(stallThresholds({ SEYIRLIK_HARD_STALL_MS: "10" }).hardStallMs).toBe(
      HARD_STALL_AFTER_MS,
    );
    expect(
      stallThresholds({ SEYIRLIK_SOFT_STALL_MS: "20000" }).hardStallMs,
    ).toBe(40_000);
    expect(
      stallThresholds({ SEYIRLIK_HARD_STALL_MS: "nonsense" }).hardStallMs,
    ).toBe(HARD_STALL_AFTER_MS);
  });
});
