// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  expectedStrategy,
  readStorageGate,
  RECORDED_EXPANSION_EVIDENCE,
  type StorageEvidence,
} from "./storageAuthorization";

describe("whether media may be written at all", () => {
  it("is closed when the importer is not configured", () => {
    /*
     * The importer is only mounted when a download root is configured, so its
     * absence is the closed gate rather than a fault to report.
     */
    const gate = readStorageGate({ importsAvailable: false });
    expect(gate.mayMutate).toBe(false);
    expect(gate.authorization).toBe("not-configured");
    expect(gate.reason).toBe("import-not-configured");
  });

  it("is open only when the importer answered", () => {
    const gate = readStorageGate({ importsAvailable: true });
    expect(gate.mayMutate).toBe(true);
    expect(gate.authorization).toBe("authorized");
  });

  it("has no third state that could be forced", () => {
    // There is deliberately nothing to override: the gate is derived, so no
    // control can put it into a state the server does not agree with.
    for (const importsAvailable of [true, false]) {
      const gate = readStorageGate({ importsAvailable });
      expect(["authorized", "not-configured"]).toContain(gate.authorization);
      expect(gate.mayMutate).toBe(gate.authorization === "authorized");
    }
  });
});

describe("what is known about the expansion drive", () => {
  it("is a recorded measurement with a date, not a live reading", () => {
    /*
     * The drive is out of scope until it has been imaged, and asking it
     * anything — including whether it is there — is what must not happen. The
     * evidence therefore carries when it was taken, so a reader can see that
     * it is a note rather than a probe.
     */
    expect(RECORDED_EXPANSION_EVIDENCE).toMatchObject({
      fileSystem: "exFAT",
      hardlinksSupported: false,
    });
    expect(RECORDED_EXPANSION_EVIDENCE.recordedOn).toMatch(
      /^\d{4}-\d{2}-\d{2}$/,
    );
  });
});

describe("what an import would do on that volume", () => {
  const noLinks: StorageEvidence = {
    ...RECORDED_EXPANSION_EVIDENCE,
    hardlinksSupported: false,
  };
  const withLinks: StorageEvidence = { ...noLinks, hardlinksSupported: true };

  it("expects a copy where the download must be kept and links are absent", () => {
    expect(expectedStrategy(noLinks, { retainSource: true })).toBe("copy");
  });

  it("expects a move where links are absent and nothing wants the download", () => {
    expect(expectedStrategy(noLinks, { retainSource: false })).toBe("move");
  });

  it("expects a hardlink wherever one is possible", () => {
    for (const retainSource of [true, false]) {
      expect(expectedStrategy(withLinks, { retainSource })).toBe("hardlink");
    }
  });

  it("never promises a hardlink on a filesystem that has none", () => {
    // exFAT is the recorded filesystem, and it has no hardlinks at all.
    expect(expectedStrategy(noLinks, { retainSource: true })).not.toBe(
      "hardlink",
    );
  });
});
