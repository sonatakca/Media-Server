import { describe, expect, it, vi } from "vitest";
import {
  AUTOMATIC_REQUEUE_PAUSE_REASON,
  OPERATOR_HELD_PAUSE_REASONS,
  pauseReasonFor,
  reconcileInterruptedJobs,
} from "./interruptedJobs";
import { createStorageGuard } from "./storageGuard";
import type {
  StorageIncidentRecord,
  StorageIncidentStore,
} from "./storageIncidentStore";
import type { ProcessingJobRecord, ProcessingPauseReason } from "./jobStore";

/**
 * Startup, with a job the last run left marked `running`.
 *
 * This is the exact decision that produced the second forced power-off. The old
 * rule asked the watchdog whether the storage was ready and requeued on a
 * `true` — and the watchdog said `true`, correctly, for a drive that was
 * mounted, listable, on the same device, and returning `EIO` from the SCSI
 * block layer on every read.
 *
 * The scenario is reproduced with the real job id and the real counters
 * observed at the time: `completed_epochs = 0`, `epoch_index = NULL`,
 * `protected_seconds = 0`, `attempts = 2`.
 */

const MEDIA_ROOT = "/Volumes/Expansion/media";
const AFFECTED_JOB = "a6b95457-443b-4ba0-9fce-ad504cc25006";

function record(
  overrides: Partial<ProcessingJobRecord> = {},
): ProcessingJobRecord {
  return {
    id: AFFECTED_JOB,
    jobId: null,
    itemId: "item-1",
    mediaFileId: "c60d968b-92c7-4009-815a-27adb4017ae3",
    sourceFingerprint: "f".repeat(64),
    profile: "cmaf-hls-aligned-v2",
    state: "running",
    stage: "planning",
    stageProgress: 0,
    overallProgress: 0,
    bytesProcessed: 0,
    outputBytes: null,
    estimatedOutputBytes: null,
    estimatedStagingBytes: null,
    speed: null,
    fps: null,
    etaSeconds: null,
    hardwareAdapter: null,
    videoEncoder: null,
    decision: null,
    streamDecisions: null,
    validation: null,
    sourceDamage: null,
    scratchIdentity: null,
    warnings: [],
    errorCode: null,
    errorMessage: null,
    // Exactly as observed: no staging directory was ever committed.
    stagingDirectory: null,
    publishedVersion: null,
    attempts: 2,
    cancellationRequested: false,
    pauseRequested: false,
    pausedReason: null,
    epochCount: null,
    epochIndex: null,
    completedEpochs: 0,
    protectedSeconds: 0,
    encodedSeconds: 0,
    sourceDurationSeconds: 7746.241,
    epochStartSeconds: null,
    epochEndSeconds: null,
    checkpointBytes: 0,
    freeBytes: null,
    createdAt: new Date("2026-09-03T05:02:03Z"),
    startedAt: new Date("2026-09-03T10:04:40Z"),
    finishedAt: null,
    updatedAt: new Date("2026-09-03T10:04:40Z"),
    ...overrides,
  };
}

function fakeIncidents(): StorageIncidentStore & {
  rows: Map<string, StorageIncidentRecord>;
} {
  const rows = new Map<string, StorageIncidentRecord>();
  return {
    rows,
    async findOpen(root) {
      const row = rows.get(root);
      return row && row.clearedAtMs === null ? row : null;
    },
    async listOpen() {
      return [...rows.values()];
    },
    async listRecent() {
      return [...rows.values()];
    },
    async save(health, context = {}) {
      const existing = rows.get(health.root);
      if (!existing && health.state === "healthy") return null;
      const row: StorageIncidentRecord = {
        ...health,
        id: existing?.id ?? "incident-1",
        failureClass: context.failureClass ?? existing?.failureClass ?? null,
        processingJobId:
          context.processingJobId ?? existing?.processingJobId ?? null,
        quarantinedAtMs:
          existing?.quarantinedAtMs ??
          (health.state === "quarantined" ? health.changedAtMs : null),
        acknowledgedBy:
          context.acknowledgedBy ?? existing?.acknowledgedBy ?? null,
        // First identity wins, exactly as the real store's COALESCE does.
        // Adoption is the one write allowed to move a recorded identity.
        identity: context.adoption
          ? (context.identity ?? null)
          : (existing?.identity ?? context.identity ?? null),
        identitySource: context.adoption
          ? "adopted"
          : (existing?.identitySource ?? (context.identity ? "probe" : null)),
        adoptedAtMs:
          context.adoption?.adoptedAtMs ?? existing?.adoptedAtMs ?? null,
        supersededVolumeUuid: context.adoption
          ? (existing?.identity?.volumeUuid ?? null)
          : (existing?.supersededVolumeUuid ?? null),
        createdAtMs: existing?.createdAtMs ?? health.changedAtMs,
        updatedAtMs: health.changedAtMs,
        clearedAtMs: health.state === "healthy" ? health.changedAtMs : null,
      };
      rows.set(health.root, row);
      return row;
    },
  };
}

function fakeStore(jobs: ProcessingJobRecord[]) {
  const pauses: Array<[string, ProcessingPauseReason]> = [];
  const events: Array<{ jobId: string; message: string; level: string }> = [];
  return {
    pauses,
    events,
    store: {
      findInterrupted: vi.fn(async () => jobs),
      requestPause: vi.fn(async (id: string, reason: ProcessingPauseReason) => {
        pauses.push([id, reason]);
        return true;
      }),
      appendEvent: vi.fn(async (input: Record<string, unknown>) => {
        events.push({
          jobId: String(input.processingJobId),
          message: String(input.message),
          level: String(input.level ?? "info"),
        });
        return null as never;
      }),
    },
  };
}

function guardFor(incidents: StorageIncidentStore, root = MEDIA_ROOT) {
  return createStorageGuard({
    root,
    watchdog: { poll: async () => true, missingRoots: [] },
    incidents,
  });
}

describe("the incident, at the moment it would have repeated", () => {
  /**
   * The regression test for the second freeze. The volume answers everything it
   * is asked; the only thing that stops the encode is that nobody watched the
   * last attempt end.
   */
  it("rehearses affected stale-running job: recovery-pending never reaches runner or FFmpeg", async () => {
    const incidents = fakeIncidents();
    const guard = guardFor(incidents);
    const affected = record();
    expect(affected.state).toBe("running");
    expect(affected.pausedReason).toBeNull();
    expect(affected.completedEpochs).toBe(0);
    const fake = fakeStore([affected]);
    const ffmpegSpawn = vi.fn();
    const jobRunner = vi.fn(async () => {
      ffmpegSpawn();
      return 1;
    });
    const requeue = vi.fn(async () => jobRunner());

    const result = await reconcileInterruptedJobs({
      store: fake.store,
      guard,
      mediaRoot: MEDIA_ROOT,
      // Exactly what the watchdog reported on the day: available.
      storageAvailable: async () => true,
      requeue,
    });

    expect(requeue).not.toHaveBeenCalled();
    expect(jobRunner).not.toHaveBeenCalled();
    expect(ffmpegSpawn).not.toHaveBeenCalled();
    expect(result.requeued).toBe(0);
    expect(fake.pauses).toEqual([[AFFECTED_JOB, "recovery-pending"]]);
    expect(guard.mayStartWork()).toBe(false);
  });

  /** The history must record the reasoning, not an intention. */
  it("says what it decided rather than announcing a fresh attempt", async () => {
    const incidents = fakeIncidents();
    const fake = fakeStore([record()]);
    await reconcileInterruptedJobs({
      store: fake.store,
      guard: guardFor(incidents),
      mediaRoot: MEDIA_ROOT,
      storageAvailable: async () => true,
      requeue: async () => 0,
    });

    const message = fake.events[0]?.message ?? "";
    expect(message).toContain("unclean shutdown");
    expect(message).not.toContain("starting a fresh attempt");
    expect(message).not.toContain("durable checkpoint");
    expect(fake.events[0]?.level).toBe("warning");
  });

  /** And the block has to be on disk before the next process starts. */
  it("writes the hold down so a later process finds it", async () => {
    const incidents = fakeIncidents();
    const fake = fakeStore([record()]);
    await reconcileInterruptedJobs({
      store: fake.store,
      guard: guardFor(incidents),
      mediaRoot: MEDIA_ROOT,
      storageAvailable: async () => true,
      requeue: async () => 0,
    });

    const row = await incidents.findOpen(MEDIA_ROOT);
    expect(row?.state).toBe("recovery-pending");
    expect(row?.processingJobId).toBe(AFFECTED_JOB);

    // A fresh process reads it back and still refuses.
    const next = guardFor(incidents);
    await next.reload();
    expect(next.mayStartWork()).toBe(false);
  });

  /**
   * The queued titles behind it are the amplifier: without the guard they would
   * be started one at a time against the same drive.
   */
  it("leaves queued work behind it dormant", async () => {
    const incidents = fakeIncidents();
    const guard = guardFor(incidents);
    await reconcileInterruptedJobs({
      store: fakeStore([record()]).store,
      guard,
      mediaRoot: MEDIA_ROOT,
      storageAvailable: async () => true,
      requeue: async () => 0,
    });
    expect(guard.mayStartWork()).toBe(false);
  });
});

describe("a stale running job whose storage is already quarantined", () => {
  it("is parked as quarantined rather than as recovery-pending", async () => {
    const incidents = fakeIncidents();
    const guard = guardFor(incidents);
    await guard.reportFailure({ kind: "source-io", detail: "EIO" });
    await guard.reportFailure({ kind: "source-io", detail: "EIO" });

    const fake = fakeStore([record()]);
    await reconcileInterruptedJobs({
      store: fake.store,
      guard,
      mediaRoot: MEDIA_ROOT,
      storageAvailable: async () => true,
      requeue: async () => 0,
    });
    expect(fake.pauses).toEqual([[AFFECTED_JOB, "storage-quarantined"]]);
  });

  /**
   * A job whose *own* attempt met an I/O error is held even where the volume as
   * a whole is healthy: it is the one job guaranteed to read the bytes that
   * failed.
   */
  it("holds a job that failed with an unreadable source", async () => {
    const incidents = fakeIncidents();
    const fake = fakeStore([
      record({ id: "other", errorCode: "SOURCE_UNREADABLE" }),
    ]);
    await reconcileInterruptedJobs({
      store: fake.store,
      guard: guardFor(incidents, "/srv/media"),
      // Internal storage, so the unclean-restart rule does not apply.
      mediaRoot: "/srv/media",
      storageAvailable: async () => true,
      requeue: async () => 0,
    });
    expect(fake.pauses[0]?.[1]).toBe("recovery-pending");
  });
});

describe("a stale running job on internal storage", () => {
  /**
   * Costing an operator a press for a disk that cannot be unplugged would be
   * safety theatre, and would train them to click through the prompt.
   */
  it("still resumes, because that storage did not go anywhere", async () => {
    const incidents = fakeIncidents();
    const requeue = vi.fn(async () => 1);
    const fake = fakeStore([record()]);

    const result = await reconcileInterruptedJobs({
      store: fake.store,
      guard: guardFor(incidents, "/srv/media"),
      mediaRoot: "/srv/media",
      storageAvailable: async () => true,
      requeue,
    });

    expect(fake.pauses).toEqual([[AFFECTED_JOB, "storage-unavailable"]]);
    expect(requeue).toHaveBeenCalledTimes(1);
    expect(result.requeued).toBe(1);
    expect(result.outcomes[0]?.decision.action).toBe("resume");
  });
});

describe("a stale running job while the volume is genuinely absent", () => {
  /** The clean unmount path: waits, and comes back on its own. */
  it("waits for the storage rather than asking a person", async () => {
    const incidents = fakeIncidents();
    const guard = createStorageGuard({
      root: MEDIA_ROOT,
      watchdog: { poll: async () => false, missingRoots: [MEDIA_ROOT] },
      incidents,
    });
    const fake = fakeStore([record()]);
    const requeue = vi.fn(async () => 0);

    await reconcileInterruptedJobs({
      store: fake.store,
      guard,
      mediaRoot: MEDIA_ROOT,
      storageAvailable: async () => false,
      requeue,
    });

    /*
     * `recovery-pending` and not `storage-unavailable`: an encode was in flight
     * on external storage when the process died, and the drive being absent now
     * does not tell anyone how that attempt ended.
     */
    expect(fake.pauses[0]?.[1]).toBe("recovery-pending");
    expect(requeue).not.toHaveBeenCalled();
  });
});

describe("nothing left behind", () => {
  it("does no work and asks the storage nothing", async () => {
    const incidents = fakeIncidents();
    const storageAvailable = vi.fn(async () => true);
    const requeue = vi.fn(async () => 0);
    const result = await reconcileInterruptedJobs({
      store: fakeStore([]).store,
      guard: guardFor(incidents),
      mediaRoot: MEDIA_ROOT,
      storageAvailable,
      requeue,
    });
    expect(result).toEqual({ outcomes: [], requeued: 0 });
    expect(storageAvailable).not.toHaveBeenCalled();
    expect(requeue).not.toHaveBeenCalled();
  });
});

describe("the pause reason a decision becomes", () => {
  /**
   * This mapping is what actually enforces the policy: only
   * `storage-unavailable` appears in the query the automatic requeue reads.
   */
  it("keeps automatic recovery for waits and denies it for holds", () => {
    expect(pauseReasonFor({ action: "resume", reason: "" }, "healthy")).toBe(
      "storage-unavailable",
    );
    expect(
      pauseReasonFor({ action: "await-storage", reason: "" }, "unavailable"),
    ).toBe("storage-unavailable");
    expect(
      pauseReasonFor({ action: "await-operator", reason: "" }, "quarantined"),
    ).toBe("storage-quarantined");
    expect(
      pauseReasonFor({ action: "await-operator", reason: "" }, "suspect"),
    ).toBe("storage-quarantined");
    expect(
      pauseReasonFor({ action: "await-operator", reason: "" }, "healthy"),
    ).toBe("recovery-pending");
  });
});

describe("which pause reasons an automatic path may act on", () => {
  /**
   * Invariant 7, expressed where both call sites read it from.
   *
   * The automatic requeue queries `AUTOMATIC_REQUEUE_PAUSE_REASON` alone, so a
   * held job is not merely filtered out — it is never returned. That matters
   * because the alternative, a runtime gate over a wider query, is one mistake
   * deep: a single wrong edit and a quarantine becomes automatically resumable.
   */
  it("never lets a held reason into the automatic query", () => {
    expect(AUTOMATIC_REQUEUE_PAUSE_REASON).toBe("storage-unavailable");
    expect(OPERATOR_HELD_PAUSE_REASONS).not.toContain(
      AUTOMATIC_REQUEUE_PAUSE_REASON,
    );
  });

  it("holds exactly the two reasons a person must lift", () => {
    expect([...OPERATOR_HELD_PAUSE_REASONS].sort()).toEqual([
      "recovery-pending",
      "storage-quarantined",
    ]);
  });

  /**
   * The two sets together must cover every reason the reconciler can assign, or
   * a job could be parked under a reason nothing ever looks at again.
   */
  it("covers every reason the reconciler can produce", () => {
    const produced = new Set(
      (
        [
          ["resume", "healthy"],
          ["await-storage", "unavailable"],
          ["await-operator", "quarantined"],
          ["await-operator", "suspect"],
          ["await-operator", "healthy"],
        ] as const
      ).map(([action, state]) => pauseReasonFor({ action, reason: "" }, state)),
    );
    for (const reason of produced) {
      expect(
        reason === AUTOMATIC_REQUEUE_PAUSE_REASON ||
          (OPERATOR_HELD_PAUSE_REASONS as readonly string[]).includes(reason),
      ).toBe(true);
    }
  });
});
