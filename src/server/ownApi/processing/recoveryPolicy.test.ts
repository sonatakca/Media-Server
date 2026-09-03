import { describe, expect, it } from "vitest";
import {
  decideJobRecovery,
  jobRecordsStorageFault,
  looksExternallyBacked,
  type JobRecoveryInput,
} from "./recoveryPolicy";

/**
 * What happens to work the last run left behind.
 *
 * The rule this replaces was one line — "the path is listable, therefore
 * resume" — and it was applied to a job left `running` by a forced power-off,
 * against a drive whose USB bridge was returning `EIO` while its cached
 * directory metadata answered instantly. It resumed. The machine had to be
 * powered off a second time.
 */

const base: JobRecoveryInput = {
  storageState: "healthy",
  interruptionWasObserved: true,
  jobSawStorageFault: false,
  externallyBacked: true,
};

describe("the storage's verdict outranks everything about the job", () => {
  it("holds every job on quarantined storage, however healthy the job looks", () => {
    const decision = decideJobRecovery({
      ...base,
      storageState: "quarantined",
    });
    expect(decision.action).toBe("await-operator");
    expect(decision.reason).toContain("quarantined");
  });

  it("holds work on suspect storage too", () => {
    expect(decideJobRecovery({ ...base, storageState: "suspect" }).action).toBe(
      "await-operator",
    );
  });

  /** Verified is not resumed. The second press is the whole safety margin. */
  it("holds work that has been verified but not resumed", () => {
    expect(
      decideJobRecovery({ ...base, storageState: "recovery-pending" }).action,
    ).toBe("await-operator");
  });
});

describe("the clean unmount path, which still works", () => {
  it("waits for the volume rather than asking a person", () => {
    const decision = decideJobRecovery({
      ...base,
      storageState: "unavailable",
      interruptionWasObserved: true,
    });
    expect(decision.action).toBe("await-storage");
  });

  it("resumes an observed interruption once the storage is healthy", () => {
    expect(decideJobRecovery({ ...base }).action).toBe("resume");
  });
});

describe("a job whose own attempt met an I/O error", () => {
  /**
   * It is the one job in the queue guaranteed to read the bytes that failed, so
   * restarting it is the cheapest possible way to collect the second fault.
   */
  it("is held even while the volume as a whole is still healthy", () => {
    const decision = decideJobRecovery({
      ...base,
      storageState: "healthy",
      jobSawStorageFault: true,
    });
    expect(decision.action).toBe("await-operator");
    expect(decision.reason).toContain("same region");
  });
});

describe("an unclean shutdown with an encode in flight", () => {
  /** The exact case that produced the second freeze. */
  it("does not resume on external storage, however healthy it looks", () => {
    const decision = decideJobRecovery({
      storageState: "healthy",
      interruptionWasObserved: false,
      jobSawStorageFault: false,
      externallyBacked: true,
    });
    expect(decision.action).toBe("await-operator");
    expect(decision.reason).toContain("unclean shutdown");
  });

  /**
   * An internal volume that "went away" did not go away, and the wait-for-USB
   * behaviour is not the right answer for it. Costing an operator a press for
   * a disk that cannot be unplugged would be safety theatre.
   */
  it("does resume on internal storage", () => {
    expect(
      decideJobRecovery({
        storageState: "healthy",
        interruptionWasObserved: false,
        jobSawStorageFault: false,
        externallyBacked: false,
      }).action,
    ).toBe("resume");
  });
});

describe("recognising storage that can be unplugged", () => {
  it("treats the usual mount points as external", () => {
    expect(looksExternallyBacked("/Volumes/Expansion/media")).toBe(true);
    expect(looksExternallyBacked("/mnt/library")).toBe(true);
    expect(looksExternallyBacked("/media/usb0")).toBe(true);
    expect(looksExternallyBacked("/net/share")).toBe(true);
  });

  it("treats a path on the boot volume as internal", () => {
    expect(looksExternallyBacked("/Users/someone/Movies")).toBe(false);
    expect(looksExternallyBacked("/srv/media")).toBe(false);
  });
});

describe("reading a storage fault off a job row", () => {
  it("recognises an unreadable source and a quarantined pause", () => {
    expect(
      jobRecordsStorageFault({
        errorCode: "SOURCE_UNREADABLE",
        pausedReason: null,
      }),
    ).toBe(true);
    expect(
      jobRecordsStorageFault({
        errorCode: null,
        pausedReason: "storage-quarantined",
      }),
    ).toBe(true);
  });

  /**
   * The distinction cost a real investigation to establish and must not be
   * quietly undone by a set membership test: a media-progress timeout means the
   * encoder stopped while the source read perfectly, which says nothing at all
   * about the disk.
   */
  it("does not read a media-progress timeout as a storage fault", () => {
    expect(
      jobRecordsStorageFault({
        errorCode: "MEDIA_PROGRESS_TIMEOUT",
        pausedReason: null,
      }),
    ).toBe(false);
  });

  it("does not read an ordinary encode failure as a storage fault", () => {
    expect(
      jobRecordsStorageFault({
        errorCode: "ENCODE_FAILED",
        pausedReason: null,
      }),
    ).toBe(false);
    expect(
      jobRecordsStorageFault({ errorCode: null, pausedReason: "operator" }),
    ).toBe(false);
  });
});
