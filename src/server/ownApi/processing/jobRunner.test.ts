import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RenditionMediaProbe } from "../../../renditions/probe";
import type { HardwareReport } from "../../../renditions/hardware/detect";
import { createProcessingJobRunner } from "./jobRunner";
import type { ProcessingJobRecord, ProcessingJobStore } from "./jobStore";
import type { ProcessingStage } from "./stages";

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
    warnings: [],
    errorCode: null,
    errorMessage: null,
    stagingDirectory: null,
    publishedVersion: null,
    attempts: 0,
    cancellationRequested: false,
    pauseRequested: false,
    pausedReason: null,
    createdAt: new Date(),
    startedAt: null,
    finishedAt: null,
    updatedAt: new Date(),
    ...overrides,
  };
}

function probe(
  overrides: Partial<RenditionMediaProbe> = {},
): RenditionMediaProbe {
  return {
    durationSeconds: 300,
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
        codec: "aac",
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
    ...overrides,
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

function fakeStore() {
  let current = record();
  const events: Array<{
    stage: ProcessingStage;
    message: string;
    level: string;
  }> = [];
  const updates: Array<Parameters<ProcessingJobStore["update"]>[1]> = [];
  const store = {
    get: vi.fn(async () => current),
    update: vi.fn(async (_id: string, update) => {
      updates.push(update);
      // Mirrors the store's own monotonic guard.
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
  return {
    store,
    events,
    updates,
    setCancelled: () => {
      current = { ...current, cancellationRequested: true };
    },
    /** What the storage watchdog does when the volume disappears. */
    setStorageUnavailable: () => {
      current = {
        ...current,
        pauseRequested: true,
        pausedReason: "storage-unavailable",
      };
    },
    latest: () => current,
  };
}

const paths = {
  mediaRoot: "/media",
  renditionRoot: "/outputs",
  stateRoot: mkdtempSync(path.join(tmpdir(), "seyirlik-runner-")),
} as never;

function runner(
  fake: ReturnType<typeof fakeStore>,
  packageFn: ReturnType<typeof vi.fn>,
  softwareThreads?: number,
) {
  return createProcessingJobRunner({
    store: fake.store,
    paths,
    mediaRoot: "/media",
    detectHardwareFn: vi.fn(async () => hardware) as never,
    probeFn: vi.fn(async () => probe()) as never,
    packageFn: packageFn as never,
    ...(softwareThreads === undefined ? {} : { softwareThreads }),
  });
}

const input = {
  processingJobId: "job-1",
  sourcePath: "/media/Movies/Dune.mp4",
  relativePath: "Movies/Dune.mp4",
  sizeBytes: 477_590_241,
  mtimeMs: 1_787_938_172_390,
};

describe("processing job runner", () => {
  let fake: ReturnType<typeof fakeStore>;

  beforeEach(() => {
    fake = fakeStore();
  });

  it("publishes a validated package and completes", async () => {
    const packageFn = vi.fn(async () => ({
      mediaId: "file-1",
      relativePath: "Movies/Dune.mp4",
      status: "ready" as const,
      versionDirectory: "cmaf-hls-aligned-v2-abcdef0123456789",
      storageBytes: 149_000_000,
    }));

    const outcome = await runner(fake, packageFn).run(input);

    expect(outcome.status).toBe("succeeded");
    expect(fake.latest().state).toBe("succeeded");
    expect(fake.latest().stage).toBe("complete");
    expect(fake.latest().overallProgress).toBe(1);
    expect(fake.latest().publishedVersion).toBe(
      "cmaf-hls-aligned-v2-abcdef0123456789",
    );
  });

  it("walks the stages in order and records each one", async () => {
    const packageFn = vi.fn(async () => ({
      mediaId: "file-1",
      relativePath: "Movies/Dune.mp4",
      status: "ready" as const,
      versionDirectory: "v2-abc",
    }));

    await runner(fake, packageFn).run(input);

    const stages = fake.events.map((event) => event.stage);
    expect(stages).toContain("analysing");
    expect(stages.indexOf("analysing")).toBeLessThan(
      stages.indexOf("planning"),
    );
    expect(stages.indexOf("planning")).toBeLessThan(stages.indexOf("video"));
    expect(stages.indexOf("video")).toBeLessThan(stages.indexOf("validating"));
    expect(stages.indexOf("validating")).toBeLessThan(
      stages.indexOf("publishing"),
    );
  });

  it("records the language decisions where an operator can read them", async () => {
    const packageFn = vi.fn(async () => ({
      mediaId: "file-1",
      relativePath: "Movies/Dune.mp4",
      status: "ready" as const,
    }));

    await runner(fake, packageFn).run(input);

    expect(fake.events.map((event) => event.message).join(" | ")).toContain(
      "Keeping English",
    );
  });

  /** A package that fails validation must never reach the player. */
  it("does not publish a package that failed validation", async () => {
    const packageFn = vi.fn(async () => ({
      mediaId: "file-1",
      relativePath: "Movies/Dune.mp4",
      status: "validation-failed" as const,
      issues: ["segment boundary drifted"],
    }));

    const outcome = await runner(fake, packageFn).run(input);

    expect(outcome.status).toBe("failed");
    expect(outcome.errorCode).toBe("VALIDATION_FAILED");
    expect(fake.latest().publishedVersion).toBeNull();
    expect(fake.latest().validation).toEqual({
      ok: false,
      issues: ["segment boundary drifted"],
    });
  });

  /**
   * Running out of room halfway through leaves a staging directory to clean up
   * by hand, so the shortfall has to stop the job before any encoding starts.
   */
  it("stops before encoding when the volume is too full", async () => {
    const packageFn = vi.fn();
    const localRunner = createProcessingJobRunner({
      store: fake.store,
      paths,
      mediaRoot: "/media",
      detectHardwareFn: vi.fn(async () => hardware) as never,
      probeFn: vi.fn(async () => probe()) as never,
      packageFn: packageFn as never,
      freeBytesFn: vi.fn(async () => 1_000_000) as never,
    });

    const outcome = await localRunner.run(input);

    expect(outcome.status).toBe("failed");
    expect(outcome.errorCode).toBe("INSUFFICIENT_DISK_SPACE");
    expect(packageFn).not.toHaveBeenCalled();
  });

  it("reports cancellation without failing the job", async () => {
    const packageFn = vi.fn(async () => {
      fake.setCancelled();
      return {
        mediaId: "file-1",
        relativePath: "Movies/Dune.mp4",
        status: "interrupted" as const,
      };
    });

    const outcome = await runner(fake, packageFn).run(input);

    expect(outcome.status).toBe("cancelled");
    expect(fake.latest().state).toBe("cancelled");
    expect(fake.latest().errorCode).toBe("CANCELLED");
  });

  /**
   * Cancellation has to reach FFmpeg. Checking only between stages let a
   * cancelled encode run to completion, which to an operator looks exactly
   * like the request being ignored.
   */
  it("aborts the encoder when cancellation is requested mid-encode", async () => {
    let observed: AbortSignal | undefined;
    const packageFn = vi.fn(async (_request, _paths, options: never) => {
      observed = (options as { signal?: AbortSignal }).signal;
      fake.setCancelled();
      // The packager would normally be inside FFmpeg here; waiting lets the
      // runner's cancellation watch fire.
      await new Promise((resolve) => setTimeout(resolve, 1200));
      return {
        mediaId: "file-1",
        relativePath: "Movies/Dune.mp4",
        status: observed?.aborted
          ? ("interrupted" as const)
          : ("ready" as const),
      };
    });

    const outcome = await runner(fake, packageFn).run(input);

    expect(observed).toBeDefined();
    expect(observed!.aborted).toBe(true);
    expect(outcome.status).toBe("cancelled");
  });

  it("does not abort the encoder when nothing asked it to", async () => {
    let observed: AbortSignal | undefined;
    const packageFn = vi.fn(async (_request, _paths, options: never) => {
      observed = (options as { signal?: AbortSignal }).signal;
      await new Promise((resolve) => setTimeout(resolve, 1200));
      return {
        mediaId: "file-1",
        relativePath: "Movies/Dune.mp4",
        status: "ready" as const,
      };
    });

    await runner(fake, packageFn).run(input);

    expect(observed!.aborted).toBe(false);
  });

  it("keeps overall progress moving forward when FFmpeg reports a lower timestamp", async () => {
    const packageFn = vi.fn(async (_request, _paths, options: never) => {
      const onEvent = (options as { onEvent?: (event: unknown) => void })
        .onEvent!;
      onEvent({
        type: "encode-progress",
        mediaId: "file-1",
        processedSeconds: 200,
        durationSeconds: 300,
        speed: 3,
      });
      onEvent({
        type: "encode-progress",
        mediaId: "file-1",
        processedSeconds: 40,
        durationSeconds: 300,
        speed: 3,
      });
      return {
        mediaId: "file-1",
        relativePath: "Movies/Dune.mp4",
        status: "ready" as const,
      };
    });

    await runner(fake, packageFn).run(input);

    const reported = fake.updates
      .map((update) => update.overallProgress)
      .filter((value): value is number => value !== undefined);
    for (let index = 1; index < reported.length; index += 1) {
      expect(reported[index]!).toBeGreaterThanOrEqual(
        Math.min(...reported.slice(0, index)),
      );
    }
    expect(fake.latest().overallProgress).toBe(1);
  });

  it("computes an ETA from the encoder's own speed", async () => {
    const packageFn = vi.fn(async (_request, _paths, options: never) => {
      const onEvent = (options as { onEvent?: (event: unknown) => void })
        .onEvent!;
      onEvent({
        type: "encode-progress",
        mediaId: "file-1",
        processedSeconds: 100,
        durationSeconds: 300,
        speed: 2,
      });
      return {
        mediaId: "file-1",
        relativePath: "Movies/Dune.mp4",
        status: "ready" as const,
      };
    });

    await runner(fake, packageFn).run(input);

    const etas = fake.updates
      .map((update) => update.etaSeconds)
      .filter(
        (value): value is number => typeof value === "number" && value > 0,
      );
    expect(etas).toContain(100);
  });

  it("passes the policy's audio selection to the packager", async () => {
    const packageFn = vi.fn(async () => ({
      mediaId: "file-1",
      relativePath: "Movies/Dune.mp4",
      status: "ready" as const,
    }));

    await runner(fake, packageFn).run(input);

    const options = (packageFn.mock.calls[0] as unknown as unknown[])[2];
    expect(options).toMatchObject({
      audioStreamIndexes: [1],
      videoEncoder: "hevc_videotoolbox",
    });
  });

  it("passes an explicit software thread override to the packager", async () => {
    const packageFn = vi.fn(async () => ({
      mediaId: "file-1",
      relativePath: "Movies/Dune.mp4",
      status: "ready" as const,
    }));

    await runner(fake, packageFn, 8).run(input);

    const options = (packageFn.mock.calls[0] as unknown as unknown[])[2];
    expect(options).toMatchObject({ softwareThreads: 8 });
  });

  /**
   * Losing the volume mid-encode.
   *
   * This used to suspend FFmpeg and leave it holding descriptors on storage
   * that was no longer there, and an aborted encode was reported as cancelled
   * — so an accidental unplug looked like a deliberate stop and needed a
   * person to press Retry.
   */
  it("parks the job as waiting for storage rather than cancelling it", async () => {
    const packageFn = vi.fn(async () => {
      fake.setStorageUnavailable();
      // The runner polls the store once a second, so the encode has to still
      // be in flight when that tick lands — as a real one would be.
      await new Promise((resolve) => setTimeout(resolve, 1_300));
      return {
        mediaId: "file-1",
        relativePath: "Movies/Dune.mp4",
        status: "interrupted" as const,
      };
    });

    const outcome = await runner(fake, packageFn as never).run(input);

    expect(outcome.status).toBe("waiting-for-storage");
    const final = fake.latest();
    expect(final.state).toBe("paused");
    // It has not finished, so it must not claim a finish time.
    expect(final.finishedAt ?? null).toBeNull();
    // And it is not an error the operator has to clear.
    expect(final.errorCode ?? null).toBeNull();
  });

  /** A person cancelling still cancels; the two paths must stay distinct. */
  it("still reports a genuine cancellation as cancelled", async () => {
    const packageFn = vi.fn(async () => {
      fake.setCancelled();
      await new Promise((resolve) => setTimeout(resolve, 1_300));
      return {
        mediaId: "file-1",
        relativePath: "Movies/Dune.mp4",
        status: "interrupted" as const,
      };
    });

    const outcome = await runner(fake, packageFn as never).run(input);
    expect(outcome.status).toBe("cancelled");
    expect(fake.latest().state).toBe("cancelled");
  });

  /**
   * A new attempt owns its own telemetry.
   *
   * The live bug: a retry inherited the previous attempt's 89% overall
   * progress and its finish time, so a run that had just begun showed as
   * nearly done and as having finished before it started.
   */
  it("starts an attempt with fresh progress and no finish time", async () => {
    const packageFn = vi.fn(async () => ({
      mediaId: "file-1",
      relativePath: "Movies/Dune.mp4",
      status: "ready" as const,
    }));

    await runner(fake, packageFn).run(input);

    const start = fake.updates.find((update) => update.state === "running") as
      | Record<string, unknown>
      | undefined;
    expect(start).toBeDefined();
    expect(start!.finishedAt).toBeNull();
    expect(start!.overallProgress).toBe(0);
    expect(start!.stageProgress).toBe(0);
    expect(start!.speed).toBeNull();
    expect(start!.fps).toBeNull();
    expect(start!.etaSeconds).toBeNull();
    expect(start!.validation).toBeNull();
    expect(start!.errorCode).toBeNull();
  });
});
