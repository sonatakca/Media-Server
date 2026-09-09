// @vitest-environment node
import { describe, expect, it } from "vitest";
import { backupHealth, type BackupRun } from "./backupRepository";

function run(over: Partial<BackupRun> = {}): BackupRun {
  return {
    id: "b1",
    state: "succeeded",
    destinationClass: "local-protected",
    dumpPresent: true,
    configPresent: true,
    secretsPresent: true,
    verification: "verified",
    startedAtMs: 1,
    ...over,
  };
}

describe("what makes a backup state healthy", () => {
  it("is healthy only when a restore was actually rehearsed", () => {
    /*
     * A dump that exists is not a dump that restores. The whole reason this
     * distinction is drawn is that a panel reporting "backed up" from the mere
     * presence of a file reads as reassurance and carries none.
     */
    expect(backupHealth(run())).toEqual({ healthy: true, reason: "verified" });
    expect(backupHealth(run({ verification: "unverified" }))).toEqual({
      healthy: false,
      reason: "unverified",
    });
    expect(backupHealth(run({ verification: "failed" }))).toMatchObject({
      healthy: false,
    });
  });

  it("says so plainly when no backup has ever run", () => {
    expect(backupHealth(null)).toEqual({
      healthy: false,
      reason: "never-run",
    });
  });

  it("does not call a failed run healthy because files happen to exist", () => {
    expect(backupHealth(run({ state: "failed" }))).toEqual({
      healthy: false,
      reason: "last-run-failed",
    });
  });

  it("counts a dump without its configuration as incomplete", () => {
    // The two are different kinds of incomplete, and neither restores alone.
    expect(backupHealth(run({ configPresent: false }))).toEqual({
      healthy: false,
      reason: "incomplete",
    });
    expect(backupHealth(run({ dumpPresent: false }))).toEqual({
      healthy: false,
      reason: "incomplete",
    });
  });

  it("never reports a run still in progress as healthy", () => {
    expect(
      backupHealth(run({ state: "running", verification: "unverified" }))
        .healthy,
    ).toBe(false);
  });
});
