// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  attentionCount,
  buildHealthSignals,
  needsOperator,
  overallVerdict,
  type HealthInput,
} from "./operationsHealth";

const healthy: HealthInput["health"] = {
  alive: true,
  ready: true,
  checks: {
    database: "available",
    jobs: "available",
    ffmpeg: "available",
    ffprobe: "available",
    mediaStorage: "available",
    generatedStorage: "writable",
  },
};

const verdictOf = (input: HealthInput) =>
  overallVerdict(buildHealthSignals(input));

const signal = (input: HealthInput, id: string) =>
  buildHealthSignals(input).find((entry) => entry.id === id);

describe("a server that is working", () => {
  it("is serving", () => {
    expect(verdictOf({ health: healthy })).toBe("serving");
  });

  it("reads every check the endpoint reports", () => {
    const ids = buildHealthSignals({ health: healthy }).map((s) => s.id);
    for (const check of Object.keys(healthy!.checks)) {
      expect(ids).toContain(check);
    }
  });

  it("counts a writable generated store as working", () => {
    // The endpoint says `writable` here and `available` elsewhere; both mean
    // the same thing to an operator.
    expect(signal({ health: healthy }, "generatedStorage")?.state).toBe("ok");
  });
});

describe("what an external service is allowed to imply", () => {
  it("does not let an unreachable download client look like a dead server", () => {
    /*
     * The whole reason the tiers exist. A media server whose downloader is off
     * still plays everything in the library, and reporting it as down sends an
     * operator looking for a fault in the wrong machine.
     */
    const verdict = verdictOf({
      health: healthy,
      downloadClient: {
        configured: true,
        reachable: false,
        reason: "connect ECONNREFUSED",
      },
    });
    expect(verdict).toBe("degraded");
    expect(needsOperator(verdict)).toBe(false);
  });

  it("treats a client that was never configured as off, not broken", () => {
    const input: HealthInput = {
      health: healthy,
      downloadClient: { configured: false, reachable: false },
    };
    expect(signal(input, "downloadClient")?.state).toBe("off");
    expect(verdictOf(input)).toBe("serving");
  });

  it("treats a disabled worker as off rather than as a failure", () => {
    // A server deliberately started without a worker is configured, not sick.
    const input: HealthInput = {
      health: { ...healthy!, checks: { ...healthy!.checks, jobs: "disabled" } },
    };
    expect(signal(input, "jobs")?.state).toBe("off");
    expect(verdictOf(input)).toBe("serving");
  });
});

describe("what does stop it serving", () => {
  it("reports a dead database as not serving", () => {
    const verdict = verdictOf({
      health: {
        ...healthy!,
        checks: { ...healthy!.checks, database: "unavailable" },
      },
    });
    expect(verdict).toBe("not-serving");
    expect(needsOperator(verdict)).toBe(true);
  });

  it("reports nothing answering at all as unreachable", () => {
    const verdict = verdictOf({ health: null });
    expect(verdict).toBe("unreachable");
    expect(needsOperator(verdict)).toBe(true);
  });

  it("separates still-starting from broken", () => {
    /*
     * `alive` without `ready` is a server that has not finished starting. It is
     * not a fault, and an operator restarting it would only start the wait
     * again.
     */
    const verdict = verdictOf({
      health: { ...healthy!, ready: false, startup: { state: "database" } },
    });
    expect(verdict).toBe("starting");
    expect(needsOperator(verdict)).toBe(false);
    expect(
      signal({ health: { ...healthy!, ready: false } }, "server")?.detail,
    ).toMatch(/still starting/);
  });

  it("treats a missing encoder as a lost capability, not a lost server", () => {
    // Playback of what is already prepared survives; new work does not.
    const verdict = verdictOf({
      health: {
        ...healthy!,
        checks: { ...healthy!.checks, ffmpeg: "unavailable" },
      },
    });
    expect(verdict).toBe("degraded");
  });
});

describe("work waiting for a person", () => {
  it("is never counted as the server being unwell", () => {
    const verdict = verdictOf({
      health: healthy,
      attention: {
        imports: 3,
        subtitlesNeedingAuthentication: 2,
        failedJobs: 7,
      },
    });
    expect(verdict).toBe("degraded");
    expect(needsOperator(verdict)).toBe(false);
  });

  it("adds up to one number an operator can act on", () => {
    const signals = buildHealthSignals({
      health: healthy,
      attention: {
        imports: 3,
        subtitlesNeedingAuthentication: 2,
        failedJobs: 7,
      },
    });
    expect(attentionCount(signals)).toBe(12);
  });

  it("says nothing at all when there is nothing waiting", () => {
    const signals = buildHealthSignals({
      health: healthy,
      attention: { imports: 0, subtitlesNeedingAuthentication: 0 },
    });
    expect(attentionCount(signals)).toBe(0);
    expect(overallVerdict(signals)).toBe("serving");
  });

  it("omits a signal whose count was never fetched", () => {
    // An absent number is not zero, and must not be drawn as though it were.
    const signals = buildHealthSignals({ health: healthy, attention: {} });
    expect(signals.some((entry) => entry.tier === "attention")).toBe(false);
  });
});

describe("an answer that has not arrived", () => {
  it("reads an unrecognised check as unknown rather than as healthy", () => {
    // Failing closed: a check whose vocabulary changed must not read as `ok`.
    const input: HealthInput = {
      health: { ...healthy!, checks: { ...healthy!.checks, database: "huh" } },
    };
    expect(signal(input, "database")?.state).toBe("unknown");
    expect(verdictOf(input)).toBe("degraded");
  });

  it("reads a missing check as unknown", () => {
    const input: HealthInput = {
      health: { alive: true, ready: true, checks: {} },
    };
    expect(signal(input, "ffmpeg")?.state).toBe("unknown");
  });
});
