import { describe, expect, it, vi } from "vitest";
import { reconcileInterruptedJobs } from "./interruptedJobs";
import { createProcessingJobRunner } from "./jobRunner";
import { createStorageGuard } from "./storageGuard";
import type {
  StorageIncidentRecord,
  StorageIncidentStore,
} from "./storageIncidentStore";
import type {
  ProcessingJobRecord,
  ProcessingJobStore,
  ProcessingPauseReason,
} from "./jobStore";

/**
 * A dry run of what happens to the real, currently-stranded job when the worker
 * next starts — proved without the drive.
 *
 * The job is `a6b95457-443b-4ba0-9fce-ad504cc25006`, working on a 28.9 GB 4K
 * HEVC HDR source under `/Volumes/Expansion/media`. Its live database row, read
 * read-only at the time this was written, is:
 *
 *   state             = running
 *   paused_reason     = NULL
 *   pause_requested   = false
 *   completed_epochs  = 0
 *   epoch_index       = NULL
 *   protected_seconds = 0
 *   encoded_seconds   = 0
 *   staging_directory = NULL
 *   attempts          = 2
 *
 * That row is reproduced verbatim below. `state = running` with nobody running
 * it is the signature of the forced power-off, and it is the exact input that,
 * under the old rule, was requeued within seconds of the next login — sending
 * FFmpeg back at the same region and taking the machine down a second time.
 *
 * The property proved here is not "it is handled gracefully". It is that the
 * packager function is **never called**, so no FFmpeg and no FFprobe process is
 * ever created. Everything else is commentary.
 *
 * `/Volumes/Expansion` is never touched: the media root is a string, the store
 * is a fake, and the packager is a spy that fails the test if it is invoked.
 */

const AFFECTED_JOB = "a6b95457-443b-4ba0-9fce-ad504cc25006";
const AFFECTED_MEDIA_FILE = "c60d968b-92c7-4009-815a-27adb4017ae3";
const MEDIA_ROOT = "/Volumes/Expansion/media";
const RELATIVE =
  "Movies/Pirates Of The Caribbean - Dead Men Tell No Tales (2017)/Pirates Of The Caribbean - Dead Men Tell No Tales 2017.mkv";

/** The live row, field for field. */
function affectedJob(
  overrides: Partial<ProcessingJobRecord> = {},
): ProcessingJobRecord {
  return {
    id: AFFECTED_JOB,
    jobId: null,
    itemId: "item-pirates",
    mediaFileId: AFFECTED_MEDIA_FILE,
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
    createdAt: new Date("2026-09-03T05:02:03.277Z"),
    startedAt: new Date("2026-09-03T10:04:40.316Z"),
    finishedAt: null,
    updatedAt: new Date("2026-09-03T10:04:40.316Z"),
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
      return [...rows.values()].filter((row) => row.clearedAtMs === null);
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

/**
 * A store that records what was asked of it and refuses to invent anything.
 *
 * `findInterrupted` returns exactly what the live query would return for this
 * database right now: the one stranded job.
 */
function fakeStore(jobs: ProcessingJobRecord[]) {
  let current = jobs[0]!;
  const pauses: Array<[string, ProcessingPauseReason]> = [];
  const events: Array<{ message: string; level: string }> = [];
  const store = {
    findInterrupted: vi.fn(async () => jobs),
    get: vi.fn(async () => current),
    update: vi.fn(async (_id: string, update: Record<string, unknown>) => {
      current = { ...current, ...update } as ProcessingJobRecord;
      return current;
    }),
    requestPause: vi.fn(async (id: string, reason: ProcessingPauseReason) => {
      pauses.push([id, reason]);
      current = {
        ...current,
        state: "paused",
        pauseRequested: true,
        pausedReason: reason,
      };
      return true;
    }),
    appendEvent: vi.fn(async (input: Record<string, unknown>) => {
      events.push({
        message: String(input.message),
        level: String(input.level ?? "info"),
      });
      return null as never;
    }),
    incrementAttempts: vi.fn(async () => 3),
  };
  return {
    pauses,
    events,
    store: store as unknown as ProcessingJobStore,
    latest: () => current,
  };
}

function guardFor(incidents: StorageIncidentStore, available = true) {
  return createStorageGuard({
    root: MEDIA_ROOT,
    watchdog: {
      poll: async () => available,
      get missingRoots() {
        return available ? [] : [MEDIA_ROOT];
      },
    },
    incidents,
  });
}

describe("the stranded job, rehearsed", () => {
  /**
   * Startup reconciliation, with the volume answering everything — which is the
   * condition under which the old code requeued it.
   */
  it("parks a6b95457 as recovery-pending and requeues nothing", async () => {
    const incidents = fakeIncidents();
    const guard = guardFor(incidents);
    const fake = fakeStore([affectedJob()]);
    const requeue = vi.fn(async () => 0);

    const result = await reconcileInterruptedJobs({
      store: fake.store,
      guard,
      mediaRoot: MEDIA_ROOT,
      // The watchdog said exactly this on the day of the incident.
      storageAvailable: async () => true,
      requeue,
    });

    expect(fake.pauses).toEqual([[AFFECTED_JOB, "recovery-pending"]]);
    expect(result.outcomes[0]?.decision.action).toBe("await-operator");
    expect(requeue).not.toHaveBeenCalled();
    expect(result.requeued).toBe(0);
    expect(guard.mayStartWork()).toBe(false);

    // And the hold is on disk before the process that made it can die again.
    const row = await incidents.findOpen(MEDIA_ROOT);
    expect(row?.state).toBe("recovery-pending");
    expect(row?.processingJobId).toBe(AFFECTED_JOB);
  });

  /**
   * The assertion the machine's survival actually depends on.
   *
   * Not "the job was marked correctly" — that no encoder process is created. The
   * packager is the only thing in the runner that spawns FFmpeg or FFprobe, and
   * it is a spy here: if the gate were wrong, this fails.
   */
  it("cannot reach the job runner's encoder path", async () => {
    const incidents = fakeIncidents();
    const guard = guardFor(incidents);
    const reconcileStore = fakeStore([affectedJob()]);

    await reconcileInterruptedJobs({
      store: reconcileStore.store,
      guard,
      mediaRoot: MEDIA_ROOT,
      storageAvailable: async () => true,
      requeue: async () => 0,
    });

    /*
     * Now suppose the job reaches the runner anyway — a queue row that outlived
     * the reconciliation, an operator pressing retry, a lease reclaimed after a
     * crash. The gate is inside `attempt()` precisely so that every route in is
     * covered, not only the one the reconciler controls.
     */
    const runnerStore = fakeStore([
      affectedJob({
        state: "queued",
        pauseRequested: true,
        pausedReason: "recovery-pending",
      }),
    ]);
    const packageFn = vi.fn();
    const probeFn = vi.fn();
    const detectHardwareFn = vi.fn();

    const outcome = await createProcessingJobRunner({
      store: runnerStore.store,
      paths: {
        mediaRoot: MEDIA_ROOT,
        renditionRoot: "/Volumes/Expansion/seyirlik/renditions",
        stateRoot: "/Volumes/Expansion/seyirlik/state/renditions",
        workRoot: "/Volumes/Expansion/seyirlik/work/renditions",
        logsRoot: "/Volumes/Expansion/seyirlik/logs/renditions",
      } as never,
      mediaRoot: MEDIA_ROOT,
      packageFn: packageFn as never,
      probeFn: probeFn as never,
      detectHardwareFn: detectHardwareFn as never,
      storageGuard: guard,
    }).run({
      processingJobId: AFFECTED_JOB,
      sourcePath: `${MEDIA_ROOT}/${RELATIVE}`,
      relativePath: RELATIVE,
      sizeBytes: 28_900_000_000,
      mtimeMs: 1_787_938_172_390,
    });

    /*
     * No encoder, no probe, and no hardware detection — which itself shells out
     * to FFmpeg. Nothing in this attempt created a process of any kind, so
     * nothing entered the kernel's I/O path for that volume.
     */
    expect(packageFn).not.toHaveBeenCalled();
    expect(probeFn).not.toHaveBeenCalled();
    expect(detectHardwareFn).not.toHaveBeenCalled();

    expect(outcome.status).toBe("waiting-for-storage");
    expect(runnerStore.latest().state).toBe("paused");
    expect(runnerStore.latest().pausedReason).toBe("recovery-pending");
  });

  /** Zero durable epochs must never be dressed up as recovered progress. */
  it("claims no checkpoint progress it does not have", async () => {
    const incidents = fakeIncidents();
    const fake = fakeStore([affectedJob()]);

    await reconcileInterruptedJobs({
      store: fake.store,
      guard: guardFor(incidents),
      mediaRoot: MEDIA_ROOT,
      storageAvailable: async () => true,
      requeue: async () => 0,
    });

    const message = fake.events[0]?.message ?? "";
    expect(message).not.toContain("durable checkpoint");
    expect(message).not.toContain("continues from");
    expect(message).not.toContain("fresh attempt");
    expect(message).toContain("unclean shutdown");
    // The counters are untouched: nothing invented a staging directory either.
    expect(fake.latest().completedEpochs).toBe(0);
    expect(fake.latest().protectedSeconds).toBe(0);
    expect(fake.latest().stagingDirectory).toBeNull();
  });

  /**
   * The same rehearsal with the drive unplugged, which is the state the machine
   * is actually in. It must still refuse, and for the honest reason: an encode
   * was in flight when the process died, and the drive being absent now says
   * nothing about how that attempt ended.
   */
  it("still refuses while the volume is absent, and says why", async () => {
    const incidents = fakeIncidents();
    const guard = guardFor(incidents, false);
    const fake = fakeStore([affectedJob()]);
    const requeue = vi.fn(async () => 0);

    await reconcileInterruptedJobs({
      store: fake.store,
      guard,
      mediaRoot: MEDIA_ROOT,
      storageAvailable: async () => false,
      requeue,
    });

    expect(fake.pauses).toEqual([[AFFECTED_JOB, "recovery-pending"]]);
    expect(requeue).not.toHaveBeenCalled();
  });

  /**
   * The two queued titles behind it. Without a gate these are the amplifier:
   * each one is another trip into the kernel's retry path to discover the same
   * thing the first one already established.
   */
  it("leaves the queued titles behind it dormant", async () => {
    const incidents = fakeIncidents();
    const guard = guardFor(incidents);

    await reconcileInterruptedJobs({
      store: fakeStore([affectedJob()]).store,
      guard,
      mediaRoot: MEDIA_ROOT,
      storageAvailable: async () => true,
      requeue: async () => 0,
    });

    const packageFn = vi.fn();
    for (const id of [
      "569529e1-6350-4c3e-8551-cce01081b6ad",
      "5bc45006-2c36-4dfc-83f5-179b2c07793b",
    ]) {
      const queued = fakeStore([affectedJob({ id, state: "queued" })]);
      const outcome = await createProcessingJobRunner({
        store: queued.store,
        paths: {
          mediaRoot: MEDIA_ROOT,
          renditionRoot: "/Volumes/Expansion/seyirlik/renditions",
          stateRoot: "/Volumes/Expansion/seyirlik/state/renditions",
          workRoot: "/Volumes/Expansion/seyirlik/work/renditions",
          logsRoot: "/Volumes/Expansion/seyirlik/logs/renditions",
        } as never,
        mediaRoot: MEDIA_ROOT,
        packageFn: packageFn as never,
        storageGuard: guard,
      }).run({
        processingJobId: id,
        sourcePath: `${MEDIA_ROOT}/${RELATIVE}`,
        relativePath: RELATIVE,
        sizeBytes: 1,
        mtimeMs: 1,
      });
      expect(outcome.status).toBe("waiting-for-storage");
    }
    expect(packageFn).not.toHaveBeenCalled();
  });

  /**
   * And the way out, end to end, so the rehearsal covers the recovery as well
   * as the refusal: two deliberate presses, and only then does work start.
   */
  it("resumes only after an operator verifies and then resumes", async () => {
    const incidents = fakeIncidents();
    const guard = guardFor(incidents);

    await reconcileInterruptedJobs({
      store: fakeStore([affectedJob()]).store,
      guard,
      mediaRoot: MEDIA_ROOT,
      storageAvailable: async () => true,
      requeue: async () => 0,
    });
    expect(guard.mayStartWork()).toBe(false);

    await guard.verify("operator");
    expect(guard.mayStartWork()).toBe(false);

    await guard.resume("operator");
    expect(guard.mayStartWork()).toBe(true);
  });
});
