import { mkdtempSync } from "node:fs";
import { mkdtemp, rm, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProcessingJobRunner } from "./jobRunner";
import { createStorageGuard } from "./storageGuard";
import type {
  StorageIncidentRecord,
  StorageIncidentStore,
} from "./storageIncidentStore";
import type { ProcessingJobRecord, ProcessingJobStore } from "./jobStore";
import type { ProcessingStage } from "./stages";
import type { RenditionMediaProbe } from "../../../renditions/probe";
import type { HardwareReport } from "../../../renditions/hardware/detect";
import {
  createStorageWatchdog,
  isStorageAvailable,
} from "../../../renditions/processing/storageWatchdog";

/**
 * The incident, reproduced against storage that cannot hurt anything.
 *
 * A USB-attached drive returned `EIO` from the SCSI block layer while staying
 * mounted and answering directory metadata instantly. Seyirlik's recovery read
 * that metadata, concluded the storage was healthy, and sent FFmpeg back at the
 * same region after a forced reboot — which produced a second kernel I/O storm
 * and a second forced power-off.
 *
 * Every failure below is injected: a temp directory renamed out from under a
 * job stands in for an unmount, a thrown `EIO` stands in for the block layer,
 * and the packager is a spy that records whether it was ever called. That last
 * one is the assertion that matters most in this file — "no encoder was
 * started" is the property the machine's survival actually depended on.
 *
 * Nothing here goes near a real media volume.
 */

// ------------------------------------------------------------------ fixtures

function record(
  overrides: Partial<ProcessingJobRecord> = {},
): ProcessingJobRecord {
  return {
    id: "job-1",
    jobId: "queue-1",
    itemId: "item-1",
    mediaFileId: "file-1",
    sourceFingerprint: "f".repeat(64),
    profile: "cmaf-hls-aligned-v2",
    state: "queued",
    stage: "waiting",
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
    attempts: 0,
    cancellationRequested: false,
    pauseRequested: false,
    pausedReason: null,
    epochCount: null,
    epochIndex: null,
    completedEpochs: 0,
    protectedSeconds: 0,
    encodedSeconds: 0,
    sourceDurationSeconds: null,
    epochStartSeconds: null,
    epochEndSeconds: null,
    checkpointBytes: 0,
    freeBytes: null,
    createdAt: new Date(),
    startedAt: null,
    finishedAt: null,
    updatedAt: new Date(),
    ...overrides,
  };
}

function probe(): RenditionMediaProbe {
  return {
    durationSeconds: 7746.241,
    video: {
      streamIndex: 0,
      codec: "hevc",
      width: 3840,
      height: 1604,
      rotation: 0,
      frameRate: 23.976,
      bitDepth: 10,
      isHdr: true,
    },
    audioTracks: [
      {
        streamIndex: 1,
        codec: "eac3",
        channels: 8,
        language: "eng",
        isDefault: true,
        isCommentary: false,
        isVisualImpaired: false,
        isOriginal: false,
      },
    ],
    subtitleTracks: [],
    chapters: [],
  };
}

const hardware: HardwareReport = {
  platform: "darwin",
  ffmpegPath: "ffmpeg",
  probedAt: "2026-01-01T00:00:00.000Z",
  adapters: [
    {
      id: "videotoolbox",
      label: "Apple VideoToolbox",
      platform: "darwin",
      available: true,
      lanes: [],
    },
  ],
  selected: {
    h264: "h264_videotoolbox",
    hevc: "hevc_videotoolbox",
    hevcTenBit: "hevc_videotoolbox",
  },
  selectedAdapter: {
    h264: "videotoolbox",
    hevc: "videotoolbox",
    hevcTenBit: "videotoolbox",
  },
};

function fakeStore(initial = record()) {
  let current = initial;
  const events: Array<{
    stage: ProcessingStage;
    message: string;
    level: string;
  }> = [];
  const store = {
    get: vi.fn(async () => current),
    update: vi.fn(async (_id: string, update) => {
      current = { ...current, ...update } as ProcessingJobRecord;
      return current;
    }),
    appendEvent: vi.fn(async (input) => {
      events.push({
        stage: input.stage,
        message: input.message,
        level: input.level ?? "info",
      });
      return {
        id: events.length,
        processingJobId: input.processingJobId,
        sequence: events.length,
        stage: input.stage,
        level: input.level ?? "info",
        message: input.message,
        detail: input.detail ?? null,
        createdAt: new Date(),
      };
    }),
    incrementAttempts: vi.fn(async () => 1),
  } as unknown as ProcessingJobStore;
  return { store, events, latest: () => current };
}

/** An incident store backed by a map: the database, minus the database. */
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
        clearedAtMs:
          health.state === "healthy"
            ? (health.clearedAtMs ?? health.changedAtMs)
            : null,
      };
      rows.set(health.root, row);
      return row;
    },
  };
}

const paths = {
  mediaRoot: "/media",
  renditionRoot: "/outputs",
  stateRoot: mkdtempSync(path.join(tmpdir(), "seyirlik-quarantine-")),
} as never;

const input = {
  processingJobId: "job-1",
  sourcePath: "/media/Movies/Pirates Of The Caribbean (2017)/Pirates 2017.mkv",
  relativePath: "Movies/Pirates Of The Caribbean (2017)/Pirates 2017.mkv",
  sizeBytes: 28_900_000_000,
  mtimeMs: 1_787_938_172_390,
};

function guardFor(
  incidents: StorageIncidentStore,
  available: () => boolean = () => true,
  root = "/media",
) {
  return createStorageGuard({
    root,
    watchdog: {
      poll: async () => available(),
      get missingRoots() {
        return available() ? [] : [root];
      },
    },
    incidents,
    /*
     * A stable identity for the volume under test, so a recovery here is a
     * genuinely verified one rather than a metadata check. The suites that care
     * about a *missing* identity live in storageGuard.test.ts and build their
     * own guard without a probe.
     */
    identityProbe: async () => ({
      volumeUuid: `uuid-for-${root}`,
      deviceNode: "/dev/disk6s1",
      medium: "physical-external" as const,
      fsType: "exfat",
      mountPath: root,
    }),
  });
}

function runnerWith(
  store: ProcessingJobStore,
  packageFn: ReturnType<typeof vi.fn>,
  storageGuard: ReturnType<typeof createStorageGuard>,
  probeFn: ReturnType<typeof vi.fn> = vi.fn(async () => probe()),
) {
  return createProcessingJobRunner({
    store,
    paths,
    mediaRoot: "/media",
    detectHardwareFn: vi.fn(async () => hardware) as never,
    probeFn: probeFn as never,
    freeBytesFn: vi.fn(async () => 1_000_000_000_000),
    packageFn: packageFn as never,
    storageGuard,
  });
}

// --------------------------------------------------------------------- tests

describe("a quarantined volume refuses to start work", () => {
  it("one hard fault blocks the next ffprobe and ffmpeg spawn immediately", async () => {
    const incidents = fakeIncidents();
    const guard = guardFor(incidents);
    await guard.reportFailure({
      kind: "source-io",
      detail: "EIO at LBA 91234",
    });
    expect(guard.health.state).toBe("quarantined");

    const fake = fakeStore();
    const packageFn = vi.fn();
    const probeFn = vi.fn();
    const outcome = await runnerWith(fake.store, packageFn, guard, probeFn).run(
      input,
    );

    /*
     * The assertion the machine's survival depended on. Not "the job failed
     * gracefully" — no FFmpeg was started at all, so nothing entered the
     * kernel's retry path.
     */
    expect(packageFn).not.toHaveBeenCalled();
    expect(probeFn).not.toHaveBeenCalled();
    expect(outcome.status).toBe("waiting-for-storage");
    expect(fake.latest().state).toBe("paused");
    expect(fake.latest().pausedReason).toBe("storage-quarantined");
    expect(fake.events.at(-1)?.message).toContain(
      "will not resume automatically",
    );
  });

  /**
   * A backlog behind a failing title is the amplifier: without this each queued
   * job is another forty-second kernel retry sequence discovering the same
   * thing.
   */
  it("keeps every queued job behind it dormant", async () => {
    const incidents = fakeIncidents();
    const guard = guardFor(incidents);
    await guard.reportFailure({ kind: "source-io", detail: "EIO" });

    const packageFn = vi.fn();
    for (const id of ["job-1", "job-2", "job-3", "job-4"]) {
      const fake = fakeStore(record({ id }));
      const outcome = await runnerWith(fake.store, packageFn, guard).run({
        ...input,
        processingJobId: id,
      });
      expect(outcome.status).toBe("waiting-for-storage");
    }
    expect(packageFn).not.toHaveBeenCalled();
  });

  /** A second job's failure must stop the one already running. */
  it("does not start once the guard turns while other work is queued", async () => {
    const incidents = fakeIncidents();
    const guard = guardFor(incidents);
    await guard.reportFailure({ kind: "source-io", detail: "EIO" });

    const packageFn = vi.fn(async () => ({ status: "succeeded" }) as never);
    const second = fakeStore(record({ id: "job-2" }));
    await runnerWith(second.store, packageFn, guard).run({
      ...input,
      processingJobId: "job-2",
    });
    expect(packageFn).not.toHaveBeenCalled();
  });
});

describe("a quarantine across process restarts", () => {
  /** The worker being relaunched by launchd must not be a reset. */
  it("survives a worker restart", async () => {
    const incidents = fakeIncidents();
    const first = guardFor(incidents);
    await first.reportFailure({ kind: "source-io", detail: "EIO" });

    // A brand-new process, with the volume answering perfectly.
    const second = guardFor(incidents, () => true);
    await second.reload();

    const fake = fakeStore();
    const packageFn = vi.fn();
    await runnerWith(fake.store, packageFn, second).run(input);
    expect(packageFn).not.toHaveBeenCalled();
  });

  /**
   * The forced power-off that ends a kernel I/O storm is exactly the event that
   * used to clear every in-memory circuit breaker.
   */
  it("survives a host reboot", async () => {
    const incidents = fakeIncidents();
    const before = guardFor(incidents);
    await before.reportFailure({ kind: "source-io", detail: "EIO" });

    // Reboot: every process is new, only the database survives.
    const server = guardFor(incidents);
    const worker = guardFor(incidents);
    await server.reload();
    await worker.reload();

    expect(server.health.state).toBe("quarantined");
    expect(worker.health.state).toBe("quarantined");
    expect(worker.mayStartWork()).toBe(false);
  });

  /** Only the two-press flow, and nothing else, lifts it. */
  it("is lifted only through verify and then resume", async () => {
    const incidents = fakeIncidents();
    const guard = guardFor(incidents, () => true);
    // The runtime learns identity on its first healthy poll, before any work.
    await guard.ensureIdentity();
    await guard.reportFailure({ kind: "source-io", detail: "EIO" });

    await guard.observeAvailability(true);
    expect(guard.mayStartWork()).toBe(false);

    await guard.verify("operator");
    expect(guard.mayStartWork()).toBe(false);

    await guard.resume("operator");
    expect(guard.mayStartWork()).toBe(true);

    expect(guard.health.state).toBe("healthy");
  });
});

describe("the failure signals a real drive produces", () => {
  const cases: Array<[string, string]> = [
    ["EIO while reading the source", "EIO: input/output error, read"],
    ["ENXIO after the device disappears", "ENXIO: no such device or address"],
    ["FFmpeg reporting an input error", "Input/output error"],
    ["a stale handle", "ESTALE: stale file handle"],
    ["a device that is gone", "Device not configured"],
  ];

  for (const [name, detail] of cases) {
    it(`quarantines and persists on the first occurrence of: ${name}`, async () => {
      const incidents = fakeIncidents();
      const guard = guardFor(incidents);
      await guard.reportFailure({ kind: "storage-unavailable", detail });

      expect(guard.health.state).toBe("quarantined");
      expect(guard.health.faultCount).toBe(1);
      expect(guard.mayStartWork()).toBe(false);

      /*
       * In memory is not enough, and saying so is the point of this assertion.
       * The incident that motivated all of this ended in a forced power-off,
       * which is precisely the event an in-memory breaker does not survive — so
       * the row has to exist after fault number one, not after fault number two.
       */
      const row = await incidents.findOpen("/media");
      expect(row?.state).toBe("quarantined");
      expect(row?.quarantinedAtMs).not.toBeNull();
    });
  }

  it("quarantines on the first active device disappearance", async () => {
    const incidents = fakeIncidents();
    const guard = guardFor(incidents);
    await guard.reportFailure({
      kind: "storage-device-lost",
      detail: "the source device disappeared during a read",
    });
    expect(guard.health.state).toBe("quarantined");
    expect(guard.health.faultCount).toBe(1);
    expect((await incidents.findOpen("/media"))?.state).toBe("quarantined");
  });

  /**
   * The distinction that must survive: an encoder that stopped while the source
   * read perfectly is a fault in the encode. Quarantining for it would take a
   * library offline over a filter-graph bug — and would eventually teach an
   * operator to ignore quarantines.
   */
  it("does not quarantine for a media-progress timeout", async () => {
    const incidents = fakeIncidents();
    const guard = guardFor(incidents);
    for (let index = 0; index < 5; index += 1) {
      await guard.reportFailure({
        kind: "media-progress-timeout",
        detail:
          "Epoch 27 produced no media for 991s after reaching 268.5s. Every completed checkpoint is kept.",
      });
    }
    expect(guard.health.state).toBe("healthy");
    expect(guard.mayStartWork()).toBe(true);
  });

  it("quarantines on the first confirmed bounded source-read timeout", async () => {
    const incidents = fakeIncidents();
    const guard = guardFor(incidents);
    await guard.reportFailure({
      kind: "source-io",
      detail: "a targeted read of the same window did not answer either",
    });
    expect(guard.health.state).toBe("quarantined");
    expect(guard.health.faultCount).toBe(1);
    expect((await incidents.findOpen("/media"))?.state).toBe("quarantined");
  });
});

describe("a single hard fault, across every restart there is", () => {
  /**
   * One fault, then each of the three restarts that used to clear an in-memory
   * breaker. The host reboot is the one that matters most: a forced power-off is
   * how a kernel I/O storm actually ends, so it is the event the quarantine is
   * least allowed to be erased by.
   */
  it("survives a worker restart, a server restart, and a host reboot", async () => {
    const incidents = fakeIncidents();
    const original = guardFor(incidents);
    await original.reportFailure({
      kind: "storage-io",
      detail: "EIO at LBA 91234",
    });
    expect(original.health.state).toBe("quarantined");
    expect(original.health.faultCount).toBe(1);

    /*
     * Every guard below is a brand-new process whose volume answers every
     * question put to it — which is exactly what the failing drive did between
     * retry storms, and exactly why none of them may take that as evidence.
     */
    for (const _restart of ["worker", "server", "host"]) {
      const restarted = guardFor(incidents, () => true);
      await restarted.reload();
      expect(restarted.health.state).toBe("quarantined");
      expect(restarted.mayStartWork()).toBe(false);

      // And a healthy-looking poll after the restart still changes nothing.
      await restarted.observeAvailability(true);
      expect(restarted.mayStartWork()).toBe(false);
    }
  });

  /**
   * The exhaustive statement of "no automatic path clears a hard quarantine".
   *
   * Every non-operator input the system can produce, applied to a root
   * quarantined by one fault. If any of these returned `true` there would be a
   * route back to running an encoder without a person having looked.
   */
  it("is cleared by no automatic path whatsoever", async () => {
    const incidents = fakeIncidents();
    const guard = guardFor(incidents, () => true);
    await guard.ensureIdentity();
    await guard.reportFailure({ kind: "storage-io", detail: "EIO" });

    // A day of healthy polls.
    for (let poll = 0; poll < 500; poll += 1) {
      await guard.observeAvailability(true);
    }
    // A full unplug-and-return cycle.
    await guard.observeAvailability(false);
    await guard.observeAvailability(true);
    // Another unclean restart.
    await guard.reportUncleanRestart({ detail: "job still running" });
    // Work that succeeded elsewhere, and an encoder-only stall.
    await guard.reportFailure({
      kind: "media-progress-timeout",
      detail: "no media for 991s",
    });
    // And a fresh process reading the row back.
    await guard.reload();

    expect(guard.health.state).toBe("quarantined");
    expect(guard.mayStartWork()).toBe(false);

    // Only the two deliberate presses move it.
    await guard.verify("operator");
    expect(guard.mayStartWork()).toBe(false);
    await guard.resume("operator");
    expect(guard.mayStartWork()).toBe(true);
  });
});

describe("a media root that disappears mid-encode", () => {
  let base = "";
  let root = "";

  beforeEach(async () => {
    base = await mkdtemp(path.join(tmpdir(), "seyirlik-vanish-"));
    root = path.join(base, "media");
    await mkdtemp(path.join(base, "x-")); // keeps the parent non-empty
    await rm(root, { recursive: true, force: true });
    await mkdtemp(path.join(base, "media-")).then(async (made) => {
      await rename(made, root);
    });
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  /**
   * A rename is an unmount as far as every path holder is concerned: the
   * directory stops resolving and every open descriptor points at something
   * nobody can reach by name. That is the whole of the signal Seyirlik can
   * observe, which is exactly what these tests are for.
   */
  it("is seen as a clean absence and stays automatically recoverable", async () => {
    const incidents = fakeIncidents();
    const watchdog = createStorageWatchdog({
      mediaRoot: root,
      check: isStorageAvailable,
    });
    const guard = createStorageGuard({ root, watchdog, incidents });

    expect(await watchdog.poll()).toBe(true);
    await guard.observeAvailability(true);
    expect(guard.mayStartWork()).toBe(true);

    await rename(root, path.join(base, "unplugged"));

    expect(await watchdog.poll()).toBe(false);
    await guard.observeAvailability(false);
    expect(guard.health.state).toBe("unavailable");
    expect(guard.mayStartWork()).toBe(false);
    /*
     * The important half: a clean disappearance is not a fault, so nobody has
     * to be woken up for it.
     */
    expect(guard.resumesAutomatically()).toBe(true);
  });

  it("refuses to start an encode while it is gone", async () => {
    const incidents = fakeIncidents();
    const guard = guardFor(incidents, () => false, root);
    await guard.observeAvailability(false);

    const fake = fakeStore();
    const packageFn = vi.fn();
    const outcome = await runnerWith(fake.store, packageFn, guard).run(input);
    expect(packageFn).not.toHaveBeenCalled();
    expect(outcome.status).toBe("waiting-for-storage");
    expect(fake.latest().pausedReason).toBe("storage-unavailable");
  });
});

describe("a job parked for recovery after an unclean restart", () => {
  it("does not run, and is not confused with a quarantine", async () => {
    const incidents = fakeIncidents();
    const guard = guardFor(incidents);
    await guard.reportUncleanRestart({
      detail: "A processing job was still marked running.",
      processingJobId: "a6b95457-443b-4ba0-9fce-ad504cc25006",
    });
    expect(guard.health.state).toBe("recovery-pending");

    const fake = fakeStore(record({ state: "running" }));
    const packageFn = vi.fn();
    await runnerWith(fake.store, packageFn, guard).run(input);
    expect(packageFn).not.toHaveBeenCalled();
    expect(fake.latest().pausedReason).toBe("recovery-pending");
  });
});

describe("a quarantine is scoped to the volume it was recorded against", () => {
  const EXPANSION_ROOT = "/Volumes/Expansion/media";
  const E2E_ROOT = "/Volumes/SeyirlikE2EMedia/media";

  /**
   * Requirement 1, and the reason it is not obvious: both roots live under
   * `/Volumes`, and one of them is a 2.9 GB disk image holding synthetic
   * `E2E Title (2026)` media. A quarantine keyed on "somewhere under /Volumes"
   * — or held in a single process-wide flag — would stop the test suite for a
   * fault on hardware it has never touched.
   */
  it("quarantining Expansion leaves the E2E disk image working", async () => {
    const incidents = fakeIncidents();
    const expansion = guardFor(incidents, () => true, EXPANSION_ROOT);
    const e2e = guardFor(incidents, () => true, E2E_ROOT);

    await expansion.reportFailure({
      kind: "storage-io",
      detail: "EIO at LBA 91234",
    });

    expect(expansion.health.state).toBe("quarantined");
    expect(expansion.mayStartWork()).toBe(false);

    // The image is untouched, and a fresh process agrees.
    expect(e2e.mayStartWork()).toBe(true);
    await e2e.reload();
    expect(e2e.health.state).toBe("healthy");
    expect(e2e.mayStartWork()).toBe(true);
    expect(await incidents.findOpen(E2E_ROOT)).toBeNull();
  });

  /**
   * Requirement 5. An E2E run must be able to encode against its image while
   * the real drive is quarantined, or the safety mechanism has taken the test
   * suite hostage.
   */
  it("lets an encode run on the E2E image while Expansion is quarantined", async () => {
    const incidents = fakeIncidents();
    const expansion = guardFor(incidents, () => true, EXPANSION_ROOT);
    await expansion.reportFailure({ kind: "storage-io", detail: "EIO" });

    const e2e = guardFor(incidents, () => true, E2E_ROOT);
    const fake = fakeStore();
    const packageFn = vi.fn(async () => ({ status: "succeeded" }) as never);
    await runnerWith(fake.store, packageFn, e2e).run(input);

    expect(packageFn).toHaveBeenCalledTimes(1);
    // And Expansion is still shut, for the avoidance of doubt.
    expect(expansion.mayStartWork()).toBe(false);
  });

  /**
   * The same isolation has to survive a restart, because the incident rows are
   * what a restarted process reads and they are keyed per root.
   */
  it("keeps the two apart across a restart", async () => {
    const incidents = fakeIncidents();
    await guardFor(incidents, () => true, EXPANSION_ROOT).reportFailure({
      kind: "storage-io",
      detail: "EIO",
    });

    const expansionAfter = guardFor(incidents, () => true, EXPANSION_ROOT);
    const e2eAfter = guardFor(incidents, () => true, E2E_ROOT);
    await expansionAfter.reload();
    await e2eAfter.reload();

    expect(expansionAfter.mayStartWork()).toBe(false);
    expect(e2eAfter.mayStartWork()).toBe(true);
  });

  /**
   * Requirements 2 and 3 at the reconciliation level: a volume turning up at
   * the quarantined path does not release the hold, whatever it is. The guard
   * refuses on the recorded state alone, so no mount event of any kind reaches
   * a decision to start work.
   */
  it("is not released by anything appearing at the quarantined path", async () => {
    const incidents = fakeIncidents();
    const guard = guardFor(incidents, () => true, EXPANSION_ROOT);
    await guard.reportFailure({ kind: "storage-io", detail: "EIO" });

    // A disk image is mounted there; the watchdog is delighted.
    for (let poll = 0; poll < 20; poll += 1) {
      await guard.observeAvailability(true);
    }
    expect(guard.mayStartWork()).toBe(false);

    const fake = fakeStore();
    const packageFn = vi.fn();
    await runnerWith(fake.store, packageFn, guard).run(input);
    expect(packageFn).not.toHaveBeenCalled();
  });
});

describe("external storage must be identified before any heavy work", () => {
  const EXTERNAL_ROOT = "/Volumes/Expansion/media";
  /** The synthetic images the tests mount live here, not under /Volumes. */
  const IMAGE_ROOT = "/tmp/seyirlik-e2e-abc123/mnt-SeyirlikE2EMedia/media";

  function guardWithProbe(
    incidents: StorageIncidentStore,
    root: string,
    probe: () => Promise<{
      volumeUuid: string | null;
      deviceNode: string | null;
      medium:
        | "physical-external"
        | "physical-internal"
        | "disk-image"
        | "network"
        | "unknown";
      fsType: string | null;
      mountPath: string | null;
    } | null>,
  ) {
    return createStorageGuard({
      root,
      watchdog: { poll: async () => true, missingRoots: [] },
      incidents,
      identityProbe: probe,
    });
  }

  /**
   * The acceptance case. The volume is healthy and answering; only its identity
   * is unobtainable. Starting anyway would mean a later fault could not be
   * recorded against anything, so recovery would have nothing to match and the
   * operator would be pushed into adoption for want of a UUID that was easy to
   * capture while the disk was well.
   */
  it("spawns no ffprobe, ffmpeg or hardware probe when identity cannot be established", async () => {
    const incidents = fakeIncidents();
    const guard = guardWithProbe(incidents, EXTERNAL_ROOT, async () => {
      throw new Error("diskutil failed");
    });

    const fake = fakeStore();
    const packageFn = vi.fn();
    const probeFn = vi.fn();
    const detectHardwareFn = vi.fn();

    const outcome = await createProcessingJobRunner({
      store: fake.store,
      paths,
      mediaRoot: "/media",
      packageFn: packageFn as never,
      probeFn: probeFn as never,
      detectHardwareFn: detectHardwareFn as never,
      storageGuard: guard,
    }).run(input);

    /*
     * All three, because each one is a process against the source: the packager
     * runs FFmpeg, the prober runs FFprobe, and hardware detection shells out to
     * FFmpeg too.
     */
    expect(packageFn).not.toHaveBeenCalled();
    expect(probeFn).not.toHaveBeenCalled();
    expect(detectHardwareFn).not.toHaveBeenCalled();

    expect(outcome.status).toBe("waiting-for-storage");
    expect(fake.latest().pausedReason).toBe("recovery-pending");
    expect(fake.events.at(-1)?.message).toContain("could not be established");
  });

  /** External media that reports no UUID is the same refusal. */
  it("refuses external media that answers but reports no UUID", async () => {
    const incidents = fakeIncidents();
    const guard = guardWithProbe(incidents, EXTERNAL_ROOT, async () => ({
      volumeUuid: null,
      deviceNode: "/dev/disk6s1",
      medium: "physical-external",
      fsType: "exfat",
      mountPath: EXTERNAL_ROOT,
    }));
    const fake = fakeStore();
    const packageFn = vi.fn();
    const outcome = await createProcessingJobRunner({
      store: fake.store,
      paths,
      mediaRoot: "/media",
      packageFn: packageFn as never,
      probeFn: vi.fn(async () => probe()) as never,
      detectHardwareFn: vi.fn(async () => hardware) as never,
      /*
       * Free space is a separate gate with its own tests, and the boot volume's
       * is not a stable input — the disk images these suites mount consume it.
       * Pinned so this asserts the identity policy and nothing else.
       */
      freeBytesFn: (async () => 10 * 1024 ** 4) as never,
      storageGuard: guard,
    }).run(input);

    expect(packageFn).not.toHaveBeenCalled();
    expect(outcome.status).toBe("waiting-for-storage");
  });

  /** With a UUID, work proceeds exactly as before. */
  it("allows work once the external volume identifies itself", async () => {
    const incidents = fakeIncidents();
    const guard = guardWithProbe(incidents, EXTERNAL_ROOT, async () => ({
      volumeUuid: "11111111-1111-1111-1111-111111111111",
      deviceNode: "/dev/disk6s1",
      medium: "physical-external",
      fsType: "exfat",
      mountPath: EXTERNAL_ROOT,
    }));
    const fake = fakeStore();
    const packageFn = vi.fn(async () => ({ status: "succeeded" }) as never);
    await createProcessingJobRunner({
      store: fake.store,
      paths,
      mediaRoot: "/media",
      packageFn: packageFn as never,
      probeFn: vi.fn(async () => probe()) as never,
      detectHardwareFn: vi.fn(async () => hardware) as never,
      /*
       * Free space is a separate gate with its own tests, and the boot volume's
       * is not a stable input — the disk images these suites mount consume it.
       * Pinned so this asserts the identity policy and nothing else.
       */
      freeBytesFn: (async () => 10 * 1024 ** 4) as never,
      storageGuard: guard,
    }).run(input);

    expect(packageFn).toHaveBeenCalledTimes(1);
  });

  /**
   * The rule is scoped, not blanket. A synthetic disk image is a file; holding
   * the E2E suite for want of a UUID on one would enforce the policy exactly
   * where it buys nothing, and would teach everyone to disable it.
   */
  it("does not impose the rule on a synthetic disk image", async () => {
    const incidents = fakeIncidents();
    const guard = guardWithProbe(incidents, IMAGE_ROOT, async () => ({
      volumeUuid: null,
      deviceNode: "/dev/disk4s2",
      medium: "disk-image",
      fsType: "hfs",
      mountPath: IMAGE_ROOT,
    }));
    const fake = fakeStore();
    const packageFn = vi.fn(async () => ({ status: "succeeded" }) as never);
    await createProcessingJobRunner({
      store: fake.store,
      paths,
      mediaRoot: "/media",
      packageFn: packageFn as never,
      probeFn: vi.fn(async () => probe()) as never,
      detectHardwareFn: vi.fn(async () => hardware) as never,
      /*
       * Free space is a separate gate with its own tests, and the boot volume's
       * is not a stable input — the disk images these suites mount consume it.
       * Pinned so this asserts the identity policy and nothing else.
       */
      freeBytesFn: (async () => 10 * 1024 ** 4) as never,
      storageGuard: guard,
    }).run(input);

    expect(packageFn).toHaveBeenCalledTimes(1);
  });

  /**
   * And a deployment with no probe at all is not held hostage either: macOS has
   * `diskutil`, a Linux host does not, and blocking every encode there would be
   * enforcing a policy by disabling the product.
   */
  it("does not hold a deployment that has no identity probe", async () => {
    const incidents = fakeIncidents();
    const guard = createStorageGuard({
      root: EXTERNAL_ROOT,
      watchdog: { poll: async () => true, missingRoots: [] },
      incidents,
    });
    const fake = fakeStore();
    const packageFn = vi.fn(async () => ({ status: "succeeded" }) as never);
    await createProcessingJobRunner({
      store: fake.store,
      paths,
      mediaRoot: "/media",
      packageFn: packageFn as never,
      probeFn: vi.fn(async () => probe()) as never,
      detectHardwareFn: vi.fn(async () => hardware) as never,
      /*
       * Free space is a separate gate with its own tests, and the boot volume's
       * is not a stable input — the disk images these suites mount consume it.
       * Pinned so this asserts the identity policy and nothing else.
       */
      freeBytesFn: (async () => 10 * 1024 ** 4) as never,
      storageGuard: guard,
    }).run(input);

    expect(packageFn).toHaveBeenCalledTimes(1);
  });

  /** A hard fault with nothing cached still quarantines, as before. */
  it("still quarantines a hard fault when no identity was ever captured", async () => {
    const incidents = fakeIncidents();
    const guard = guardWithProbe(incidents, EXTERNAL_ROOT, async () => null);
    await guard.reportFailure({ kind: "storage-io", detail: "EIO" });
    expect(guard.health.state).toBe("quarantined");
    expect(guard.mayStartWork()).toBe(false);
    expect((await incidents.findOpen(EXTERNAL_ROOT))?.identity).toBeNull();
  });
});
