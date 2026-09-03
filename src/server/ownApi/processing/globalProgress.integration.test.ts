/**
 * The whole-job bar, driven through the real runner from end to end.
 *
 * The unit tests prove the arithmetic; this proves the wiring. A fake packager
 * emits the exact event sequence a real one does — video epochs, audio, byte
 * assembly, weighted verification, publication — and every live sample the
 * worker writes is collected from the transient file it really uses. What is
 * asserted is the sequence of `globalProgress` values an operator's bar would
 * have been drawn from.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RenditionMediaProbe } from "../../../renditions/probe";
import type { HardwareReport } from "../../../renditions/hardware/detect";
import { createProcessingJobRunner } from "./jobRunner";
import type {
  PhaseTimingRecord,
  ProcessingJobRecord,
  ProcessingJobStore,
} from "./jobStore";
import type { LiveProgressSnapshot } from "./liveProgress";

const GIB = 1024 ** 3;
const SOURCE_SECONDS = 10_256;

/**
 * Every snapshot the worker publishes, captured where it publishes it.
 *
 * Reading them back out of the transient file would test the filesystem's
 * timing rather than the worker's arithmetic — and would silently drop samples
 * whose write had not landed yet. This records exactly what was handed to the
 * live lane, in order.
 */
const { published } = vi.hoisted(() => ({
  published: [] as unknown[],
}));

vi.mock("./liveProgress", async () => {
  const actual =
    await vi.importActual<typeof import("./liveProgress")>("./liveProgress");
  return {
    ...actual,
    writeLiveProgress: vi.fn(async (snapshot: unknown) => {
      published.push(JSON.parse(JSON.stringify(snapshot)));
    }),
    clearLiveProgress: vi.fn(async () => undefined),
  };
});

function snapshots(): LiveProgressSnapshot[] {
  return published as LiveProgressSnapshot[];
}

beforeEach(() => {
  published.length = 0;
  /*
   * The worker publishes at most four samples a second and the fake packager
   * below emits a whole job in microseconds, so without a clock to advance,
   * the throttle would collapse the trace into a single sample.
   */
  vi.useFakeTimers();
  return () => vi.useRealTimers();
});

function jobRecord(): ProcessingJobRecord {
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
  };
}

function probe(): RenditionMediaProbe {
  return {
    durationSeconds: SOURCE_SECONDS,
    video: {
      streamIndex: 0,
      codec: "h264",
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
        codec: "dts",
        channels: 6,
        language: "tur",
        isDefault: true,
        isForced: false,
      },
      {
        streamIndex: 2,
        codec: "ac3",
        channels: 2,
        language: "eng",
        isDefault: false,
        isForced: false,
      },
    ],
    subtitleTracks: [],
    container: "mkv",
    sizeBytes: 40 * GIB,
  } as unknown as RenditionMediaProbe;
}

const hardware = {
  platform: "darwin",
  probedAt: new Date().toISOString(),
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
} as unknown as HardwareReport;

function fakeStore(history: PhaseTimingRecord[] = []) {
  let current = jobRecord();
  const updates: Array<Parameters<ProcessingJobStore["update"]>[1]> = [];
  const store = {
    get: vi.fn(async () => current),
    update: vi.fn(async (_id: string, update) => {
      updates.push(update);
      const nextOverall =
        update.overallProgress === undefined
          ? current.overallProgress
          : Math.max(current.overallProgress, update.overallProgress);
      current = {
        ...current,
        ...update,
        overallProgress: nextOverall,
      } as ProcessingJobRecord;
      return current;
    }),
    appendEvent: vi.fn(async () => ({}) as never),
    incrementAttempts: vi.fn(async () => 1),
    listPhaseTimings: vi.fn(async () => history),
  } as unknown as ProcessingJobStore;
  return { store, updates, latest: () => current };
}

const paths = {
  mediaRoot: "/media",
  renditionRoot: "/outputs",
  stateRoot: mkdtempSync(path.join(tmpdir(), "seyirlik-trace-state-")),
  workRoot: "/work",
  logsRoot: "/logs",
} as never;

/**
 * The event sequence a real packager produces, compressed to the shape that
 * matters: each phase announced, then measured samples inside it.
 */
function fakePackager() {
  return vi.fn(async (_request: never, _paths: never, options: never) => {
    const emit = (options as { onEvent: (event: unknown) => void }).onEvent;
    /** Opens the publish throttle, so the next emission is not collapsed. */
    const capture = async () => {
      await vi.advanceTimersByTimeAsync(300);
    };

    emit({ type: "build-stage", mediaId: "m", stage: "planning" });
    await capture();

    emit({ type: "build-stage", mediaId: "m", stage: "encoding" });
    emit({
      type: "epoch-plan",
      mediaId: "m",
      epochCount: 34,
      epochTargetSeconds: 300,
      sourceDurationSeconds: SOURCE_SECONDS,
      reusedEpochs: 0,
      protectedSeconds: 0,
      checkpointBytes: 0,
      invalidated: [],
    });
    for (const fraction of [0.25, 0.5, 0.75, 1]) {
      emit({
        type: "epoch-progress",
        mediaId: "m",
        index: Math.floor(fraction * 33),
        epochCount: 34,
        startSeconds: 0,
        endSeconds: SOURCE_SECONDS,
        epochProcessedSeconds: SOURCE_SECONDS * fraction,
        encodedSeconds: SOURCE_SECONDS * fraction,
        protectedSeconds: SOURCE_SECONDS * fraction,
        sourceDurationSeconds: SOURCE_SECONDS,
        speed: 2.4,
        writtenBytes: 26.86 * GIB * fraction,
      });
      await capture();
    }

    emit({ type: "build-stage", mediaId: "m", stage: "audio" });
    for (const fraction of [0.2, 0.6, 1]) {
      emit({
        type: "audio-progress",
        mediaId: "m",
        progress: {
          tracks: [
            {
              id: "track-1",
              language: "tur",
              codec: "aac",
              channels: 6,
              writtenBytes: 120 * 1024 * 1024 * fraction,
            },
          ],
          processedSeconds: SOURCE_SECONDS * fraction,
          durationSeconds: SOURCE_SECONDS,
          fraction,
          speed: 21.4,
          writtenBytes: 120 * 1024 * 1024 * fraction,
        },
      });
      await capture();
    }

    emit({ type: "build-stage", mediaId: "m", stage: "assembling" });
    for (const fraction of [0, 0.704, 1]) {
      emit({
        type: "assembly-progress",
        mediaId: "m",
        progress: {
          totalBytes: 26.86 * GIB,
          completedBytes: 26.86 * GIB * fraction,
          fraction,
          renditions: [
            {
              id: "2160p",
              expectedBytes: 10.18 * GIB,
              writtenBytes: 10.18 * GIB * Math.min(1, fraction * 2.64),
              state: fraction >= 0.379 ? "complete" : "running",
            },
          ],
          currentId: "2160p",
          bytesPerSecond: 15.3 * 1024 * 1024,
        },
      });
      await capture();
    }

    emit({ type: "build-stage", mediaId: "m", stage: "validating" });
    for (const [done, weight] of [
      [1, 0.05],
      [14, 0.5],
      [28, 1],
    ] as const) {
      emit({
        type: "verification-progress",
        mediaId: "m",
        progress: {
          totalChecks: 28,
          completedChecks: done,
          totalWeight: 26.86 * GIB,
          completedWeight: 26.86 * GIB * weight,
          fraction: weight,
          groups: [{ kind: "video-probe", completed: done, total: 8 }],
          ...(done === 28 ? { ok: true } : {}),
        },
      });
      await capture();
    }

    emit({ type: "build-stage", mediaId: "m", stage: "publishing" });
    emit({
      type: "publish-progress",
      mediaId: "m",
      progress: {
        steps: [
          { id: "video", state: "complete" },
          { id: "swap", state: "complete" },
        ],
        totalBytes: 26.86 * GIB,
        completedBytes: 26.86 * GIB,
        fraction: 1,
      },
    });
    await capture();

    return {
      status: "ready",
      mediaId: "m",
      relativePath: "Movies/Gladiator/Gladiator.mkv",
      versionDirectory: "v1",
      storageBytes: 26.86 * GIB,
      jobOutputBytes: 26.86 * GIB,
    };
  });
}

describe("the global bar across a whole job", () => {
  it("rises through every phase and reaches the end only on success", async () => {
    const fake = fakeStore();
    const packageFn = fakePackager();

    const outcome = await createProcessingJobRunner({
      store: fake.store,
      paths,
      mediaRoot: "/media",
      detectHardwareFn: vi.fn(async () => hardware) as never,
      probeFn: vi.fn(async () => probe()) as never,
      freeBytesFn: vi.fn(async () => 500 * GIB) as never,
      packageFn: packageFn as never,
    }).run({
      processingJobId: "job-1",
      sourcePath: "/media/Movies/Gladiator/Gladiator.mkv",
      relativePath: "Movies/Gladiator/Gladiator.mkv",
      sizeBytes: 40 * GIB,
      mtimeMs: 0,
    });

    expect(outcome.status).toBe("succeeded");
    const samples = snapshots();

    /*
     * The trace itself: phase, the phase's own measured fraction, and the bar
     * position each one produced. This is the sequence the audit asks to see.
     */
    const trace = samples.map((sample) => ({
      phase: sample.phase,
      phaseFraction: Number((sample.phaseFraction ?? 0).toFixed(3)),
      globalProgress: Number((sample.globalProgress ?? 0).toFixed(4)),
    }));

    if (process.env.TRACE) {
      for (const entry of trace) {
        console.log(
          `${String(entry.phase).padEnd(11)} phaseFraction=${entry.phaseFraction
            .toFixed(3)
            .padStart(5)}  globalProgress=${entry.globalProgress.toFixed(4)}`,
        );
      }
    }

    // Every phase is represented.
    expect(new Set(trace.map((entry) => entry.phase))).toEqual(
      new Set([
        "planning",
        "encoding",
        "audio",
        "assembling",
        "validating",
        "publishing",
      ]),
    );

    // The bar never goes backwards, at any point, including every handover.
    let previous = -1;
    for (const entry of trace) {
      expect(entry.globalProgress).toBeGreaterThanOrEqual(previous);
      previous = entry.globalProgress;
    }

    // It never claims the end while the packager is still working.
    for (const entry of trace) {
      expect(entry.globalProgress).toBeLessThan(1);
    }

    // Each phase starts no lower than the previous one finished.
    const lastOf = (phase: string) =>
      [...trace].reverse().find((entry) => entry.phase === phase);
    const firstOf = (phase: string) =>
      trace.find((entry) => entry.phase === phase);
    const order = [
      "encoding",
      "audio",
      "assembling",
      "validating",
      "publishing",
    ] as const;
    for (let index = 0; index < order.length - 1; index += 1) {
      const ending = lastOf(order[index]!)!;
      const starting = firstOf(order[index + 1]!)!;
      expect(starting.globalProgress).toBeGreaterThanOrEqual(
        ending.globalProgress,
      );
    }

    // Only the persisted success fills it.
    expect(fake.latest().state).toBe("succeeded");
    expect(fake.latest().overallProgress).toBe(1);
  });

  /**
   * The weights are read from history at the start of the attempt and are not
   * revisited, so a machine that assembles at 15 MiB/s gives assembly a share
   * of the bar that matches what it will really cost.
   */
  it("weights the bar from this machine's measured history", async () => {
    const base = Date.UTC(2026, 8, 1);
    const slowStorage: PhaseTimingRecord[] = [0, 1, 2].map(() => ({
      sourceDurationSeconds: SOURCE_SECONDS,
      outputBytes: 26.86 * GIB,
      videoEncoder: "hevc_videotoolbox",
      hardwareAdapter: "videotoolbox",
      audioTrackCount: 2,
      startedAt: new Date(base),
      finishedAt: new Date(base + 16_000_000),
      stageStartedAt: {
        video: new Date(base),
        audio: new Date(base + 13_080_000),
        packaging: new Date(base + 13_320_000),
        validating: new Date(base + 15_118_000),
        publishing: new Date(base + 15_940_000),
      },
    }));

    const withHistory = fakeStore(slowStorage);
    const withoutHistory = fakeStore([]);
    const run = async (fake: ReturnType<typeof fakeStore>) => {
      published.length = 0;
      await createProcessingJobRunner({
        store: fake.store,
        paths,
        mediaRoot: "/media",
        detectHardwareFn: vi.fn(async () => hardware) as never,
        probeFn: vi.fn(async () => probe()) as never,
        freeBytesFn: vi.fn(async () => 500 * GIB) as never,
        packageFn: fakePackager() as never,
      }).run({
        processingJobId: "job-1",
        sourcePath: "/media/Movies/Gladiator/Gladiator.mkv",
        relativePath: "Movies/Gladiator/Gladiator.mkv",
        sizeBytes: 40 * GIB,
        mtimeMs: 0,
      });
      return [...snapshots()];
    };

    const measured = await run(withHistory);
    const assumed = await run(withoutHistory);

    /*
     * Where the bar stands when assembly begins. With the slow storage
     * measured, assembly is a visible share of what remains; with the
     * constants, the same real half hour is a sliver.
     */
    const atAssemblyStart = (samples: LiveProgressSnapshot[]) =>
      samples.find((sample) => sample.phase === "assembling")!.globalProgress!;
    const atAssemblyEnd = (samples: LiveProgressSnapshot[]) =>
      [...samples].reverse().find((sample) => sample.phase === "assembling")!
        .globalProgress!;

    const measuredShare = atAssemblyEnd(measured) - atAssemblyStart(measured);
    const assumedShare = atAssemblyEnd(assumed) - atAssemblyStart(assumed);
    expect(measuredShare).toBeGreaterThan(assumedShare * 2);
  });
});

describe("the live sample survives an operation that reports nothing", () => {
  /**
   * A single ffprobe of a ten-gigabyte rendition returns nothing until it
   * exits. The reader drops a sample older than six seconds, so without a
   * heartbeat the panel vanished in the middle of work that was going
   * perfectly well. The heartbeat republishes the same figures — and only the
   * same figures.
   */
  it("republishes the confirmed values without advancing them", async () => {
    const fake = fakeStore();
    let releasePackager = () => {};
    const held = new Promise<void>((resolve) => {
      releasePackager = resolve;
    });

    const packageFn = vi.fn(
      async (_request: never, _paths: never, options: never) => {
        const emit = (options as { onEvent: (event: unknown) => void }).onEvent;
        emit({ type: "build-stage", mediaId: "m", stage: "validating" });
        emit({
          type: "verification-progress",
          mediaId: "m",
          progress: {
            totalChecks: 8,
            completedChecks: 3,
            totalWeight: 1000,
            completedWeight: 300,
            fraction: 0.3,
            groups: [{ kind: "video-probe", completed: 3, total: 8 }],
          },
        });
        // Inside one long probe that reports nothing until it returns.
        await held;
        return {
          status: "ready",
          mediaId: "m",
          relativePath: "x",
          versionDirectory: "v1",
        };
      },
    );

    const run = createProcessingJobRunner({
      store: fake.store,
      paths,
      mediaRoot: "/media",
      detectHardwareFn: vi.fn(async () => hardware) as never,
      probeFn: vi.fn(async () => probe()) as never,
      freeBytesFn: vi.fn(async () => 500 * GIB) as never,
      packageFn: packageFn as never,
    }).run({
      processingJobId: "job-1",
      sourcePath: "/media/x.mkv",
      relativePath: "x.mkv",
      sizeBytes: 40 * GIB,
      mtimeMs: 0,
    });

    /*
     * The runner has real work to do before it reaches the packager — probing,
     * hardware detection, writing the registry — and fake timers only let that
     * I/O drain as the clock is advanced. Advance until the first sample lands
     * rather than assuming one interval is enough.
     */
    // The samples that actually carry a verification measurement, as opposed
    // to the phase-transition sample that precedes them.
    const validating = () =>
      snapshots().filter(
        (sample) => sample.phase === "validating" && sample.verification,
      );
    for (
      let attempt = 0;
      attempt < 40 && validating().length === 0;
      attempt++
    ) {
      await vi.advanceTimersByTimeAsync(50);
    }
    const before = validating()[validating().length - 1]!;
    expect(before).toBeDefined();
    await vi.advanceTimersByTimeAsync(10_000);
    const after = validating()[validating().length - 1]!;
    releasePackager();
    await run;

    // Republished, so the reader keeps the panel rather than dropping it.
    expect(after.timestampMs).toBeGreaterThan(before.timestampMs);
    // Unchanged: the same measurement, and the same moment it was measured.
    expect(after.globalProgress).toBe(before.globalProgress);
    expect(after.verification?.completedChecks).toBe(3);
    expect(after.confirmedAtMs).toBe(before.confirmedAtMs);
    // Which is what lets the page withdraw a rate it can no longer stand by.
    expect(after.timestampMs - after.confirmedAtMs!).toBeGreaterThan(5_000);
  });

  it("stops publishing once the job is over", async () => {
    const fake = fakeStore();
    await createProcessingJobRunner({
      store: fake.store,
      paths,
      mediaRoot: "/media",
      detectHardwareFn: vi.fn(async () => hardware) as never,
      probeFn: vi.fn(async () => probe()) as never,
      freeBytesFn: vi.fn(async () => 500 * GIB) as never,
      packageFn: fakePackager() as never,
    }).run({
      processingJobId: "job-1",
      sourcePath: "/media/x.mkv",
      relativePath: "x.mkv",
      sizeBytes: 40 * GIB,
      mtimeMs: 0,
    });

    const afterRun = snapshots().length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(snapshots().length).toBe(afterRun);
  });
});

describe("a single validation check that takes minutes", () => {
  /**
   * The gap this closes.
   *
   * `ffprobe -skip_frame nokey` walking an eleven-gigabyte rendition is one
   * check out of thirty-six, so the counter the page prints could not move
   * while it ran — and neither could the phase bar, which is weighted by check.
   * Minutes of healthy work looked identical to a hang. Now the scan reports
   * where it has reached, the running check contributes the part of itself it
   * has done, and the bar moves without the counter lying about what has
   * finished.
   */
  const scan = (
    emit: (event: unknown) => void,
    fraction: number,
    rendition = "2160p",
  ): void => {
    emit({
      type: "verification-progress",
      mediaId: "m",
      progress: {
        totalChecks: 36,
        completedChecks: 10,
        totalWeight: 1_000,
        completedWeight: 100,
        // The running check weighs 500 and is `fraction` through it.
        fraction: (100 + 500 * fraction) / 1_000,
        groups: [{ kind: "video-probe", completed: 0, total: 8 }],
        current: {
          kind: "video-probe",
          rendition,
          startedAtMs: 1,
          currentMediaSeconds: 9_039 * fraction,
          totalMediaSeconds: 9_039,
          fraction,
          rate: 21.4,
          etaSeconds: 139,
        },
      },
    });
  };

  const runScan = async (fake: ReturnType<typeof fakeStore>) => {
    const packageFn = vi.fn(
      async (_request: never, _paths: never, options: never) => {
        const emit = (options as { onEvent: (event: unknown) => void }).onEvent;
        emit({ type: "build-stage", mediaId: "m", stage: "validating" });
        for (const fraction of [0, 0.25, 0.5, 0.75]) {
          scan(emit, fraction);
          // The publish throttle is 250ms; advance past it so each scan
          // report becomes its own sample rather than being coalesced.
          await vi.advanceTimersByTimeAsync(300);
        }
        return {
          status: "ready" as const,
          mediaId: "m",
          relativePath: "Movies/Gladiator/Gladiator.mkv",
          versionDirectory: "v1",
          storageBytes: 26.86 * GIB,
          jobOutputBytes: 26.86 * GIB,
        };
      },
    );
    await createProcessingJobRunner({
      store: fake.store,
      paths,
      mediaRoot: "/media",
      detectHardwareFn: vi.fn(async () => hardware) as never,
      probeFn: vi.fn(async () => probe()) as never,
      freeBytesFn: vi.fn(async () => 500 * GIB) as never,
      packageFn: packageFn as never,
    }).run({
      processingJobId: "job-1",
      sourcePath: "/media/Movies/Gladiator/Gladiator.mkv",
      relativePath: "Movies/Gladiator/Gladiator.mkv",
      sizeBytes: 40 * GIB,
      mtimeMs: 0,
    });
  };

  it("moves the whole job's bar while one check is still running", async () => {
    const fake = fakeStore();
    await runScan(fake);
    const during = snapshots().filter(
      (sample) => sample.phase === "validating" && sample.verification,
    );
    expect(during.length).toBeGreaterThan(1);

    const bars = during.map((sample) => sample.globalProgress ?? 0);
    expect(bars[bars.length - 1]).toBeGreaterThan(bars[0]!);
    // Monotonic throughout.
    for (let index = 1; index < bars.length; index += 1) {
      expect(bars[index]).toBeGreaterThanOrEqual(bars[index - 1]!);
    }
    // …and the counter never claimed a check had finished.
    for (const sample of during) {
      expect(sample.verification!.completedChecks).toBe(10);
    }
  });

  it("keeps the current rendition and its position in the live sample", async () => {
    const fake = fakeStore();
    await runScan(fake);
    /*
     * What a browser reloading mid-scan reads back. Without it the page falls
     * back to the last phase it knew about, which is the "assembling 100%"
     * this whole exercise exists to remove.
     */
    const last = [...snapshots()]
      .reverse()
      .find((sample) => sample.verification?.current)!;
    expect(last.phase).toBe("validating");
    expect(last.verification!.current!.rendition).toBe("2160p");
    expect(last.verification!.current!.fraction).toBeGreaterThan(0);
    expect(last.verification!.current!.totalMediaSeconds).toBe(9_039);
    expect(last.verification!.completedChecks).toBe(10);
  });

  it("never reaches the end until the job itself has", async () => {
    const fake = fakeStore();
    await runScan(fake);
    for (const sample of snapshots()) {
      if (sample.phase === "validating") {
        expect(sample.globalProgress ?? 0).toBeLessThan(1);
      }
    }
    expect(fake.latest().state).toBe("succeeded");
    expect(fake.latest().overallProgress).toBe(1);
  });

  /*
   * A rendition of two and a half hours prints thousands of keyframes. Writing
   * one row per keyframe would put the database under load proportional to
   * ffprobe's output; the live channel absorbs them and the durable record is
   * written on its own interval.
   */
  it("does not write a database row per reported keyframe", async () => {
    const fake = fakeStore();
    const packageFn = vi.fn(
      async (_request: never, _paths: never, options: never) => {
        const emit = (options as { onEvent: (event: unknown) => void }).onEvent;
        emit({ type: "build-stage", mediaId: "m", stage: "validating" });
        for (let index = 0; index < 400; index += 1) {
          scan(emit, index / 400);
        }
        return {
          status: "ready" as const,
          mediaId: "m",
          relativePath: "Movies/Gladiator/Gladiator.mkv",
          versionDirectory: "v1",
          storageBytes: 26.86 * GIB,
          jobOutputBytes: 26.86 * GIB,
        };
      },
    );
    await createProcessingJobRunner({
      store: fake.store,
      paths,
      mediaRoot: "/media",
      detectHardwareFn: vi.fn(async () => hardware) as never,
      probeFn: vi.fn(async () => probe()) as never,
      freeBytesFn: vi.fn(async () => 500 * GIB) as never,
      packageFn: packageFn as never,
    }).run({
      processingJobId: "job-1",
      sourcePath: "/media/Movies/Gladiator/Gladiator.mkv",
      relativePath: "Movies/Gladiator/Gladiator.mkv",
      sizeBytes: 40 * GIB,
      mtimeMs: 0,
    });

    const progressWrites = fake.updates.filter(
      (update) => update.stageProgress !== undefined,
    );
    expect(progressWrites.length).toBeLessThan(20);
  });
});
