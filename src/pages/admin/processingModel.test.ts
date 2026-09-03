import { describe, expect, it } from "vitest";
import type { ProcessingJob } from "../../lib/processingApi";
import type { ProcessingLiveProgress } from "../../lib/processingApi";
import {
  audioDecisionKey,
  buildPhaseFor,
  damagedSecondsTotal,
  formatDamagedInterval,
  isSalvaged,
  sourceDamageRecords,
  sourceIoNotice,
  completedEpochs,
  encodedFraction,
  encodedPercent,
  formatMediaClock,
  hasResumableCheckpoints,
  isWaitingForStorage,
  protectedSeconds,
  retryScopeKey,
  smoothedEncodedSeconds,
  audioFormatLabel,
  canCancel,
  canPause,
  canResume,
  canRetry,
  formatBytes,
  formatFileSize,
  formatDuration,
  formatFinishedAt,
  formatSpeed,
  lastSequence,
  mergeEvents,
  mergeJobFrame,
  progressPercent,
  processingDurationSeconds,
  processingElapsedSeconds,
  stageStateFor,
  subtitleDecisionKey,
  summariseLanguages,
} from "./processingModel";

function job(overrides: Partial<ProcessingJob> = {}): ProcessingJob {
  return {
    id: "job-1",
    itemId: "item-1",
    mediaFileId: "file-1",
    profile: "cmaf-hls-aligned-v2",
    state: "running",
    stage: "video",
    stageProgress: 0.5,
    overallProgress: 0.4,
    bytesProcessed: 0,
    actualOutputBytes: 0,
    outputBytes: null,
    estimatedOutputBytes: null,
    estimatedStagingBytes: null,
    speed: null,
    fps: null,
    etaSeconds: null,
    hardwareAdapter: "videotoolbox",
    videoEncoder: "hevc_videotoolbox",
    decision: null,
    validation: null,
    warnings: [],
    sourceDamage: null,
    errorCode: null,
    errorMessage: null,
    publishedVersion: null,
    attempts: 1,
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
    createdAt: "2026-01-01T00:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("stage timeline", () => {
  it("marks earlier stages done and later ones pending", () => {
    const current = job({ stage: "video", state: "running" });

    expect(stageStateFor("analysing", current)).toBe("done");
    expect(stageStateFor("video", current)).toBe("active");
    expect(stageStateFor("publishing", current)).toBe("pending");
  });

  it("shows every stage done once the job succeeded", () => {
    const finished = job({ state: "succeeded", stage: "complete" });

    expect(stageStateFor("waiting", finished)).toBe("done");
    expect(stageStateFor("complete", finished)).toBe("done");
  });

  /** A failed job has to leave the eye where the failure happened. */
  it("leaves a failed job's stage active so the failure is easy to find", () => {
    const failed = job({ state: "failed", stage: "validating" });

    expect(stageStateFor("validating", failed)).toBe("active");
    expect(stageStateFor("publishing", failed)).toBe("pending");
  });
});

describe("actions", () => {
  it("offers cancel only while a job is still going", () => {
    expect(canCancel(job({ state: "running" }))).toBe(true);
    expect(canCancel(job({ state: "queued" }))).toBe(true);
    expect(canCancel(job({ state: "succeeded" }))).toBe(false);
  });

  it("does not offer cancel twice", () => {
    expect(
      canCancel(job({ state: "running", cancellationRequested: true })),
    ).toBe(false);
  });

  it("offers pause only while a job is actually encoding", () => {
    expect(canPause(job({ state: "running" }))).toBe(true);
    expect(canPause(job({ state: "queued" }))).toBe(false);
    expect(canPause(job({ state: "succeeded" }))).toBe(false);
  });

  it("does not offer pause twice, or while cancelling", () => {
    expect(canPause(job({ state: "running", pauseRequested: true }))).toBe(
      false,
    );
    expect(
      canPause(job({ state: "running", cancellationRequested: true })),
    ).toBe(false);
  });

  it("offers resume once a job is paused", () => {
    expect(canResume(job({ state: "paused", pauseRequested: true }))).toBe(
      true,
    );
    expect(canResume(job({ state: "running" }))).toBe(false);
  });

  /**
   * A job the storage paused comes back on its own. Offering the button would
   * invite a click that can only fail while the volume is still missing.
   */
  it("does not offer resume for a job the storage paused", () => {
    expect(
      canResume(
        job({
          state: "paused",
          pauseRequested: true,
          pausedReason: "storage-unavailable",
        }),
      ),
    ).toBe(false);
  });

  it("offers retry only after a job stopped without succeeding", () => {
    expect(canRetry(job({ state: "failed" }))).toBe(true);
    expect(canRetry(job({ state: "cancelled" }))).toBe(true);
    expect(canRetry(job({ state: "succeeded" }))).toBe(false);
    expect(canRetry(job({ state: "running" }))).toBe(false);
  });
});

describe("job history time", () => {
  it("measures a completed job from its actual start", () => {
    expect(
      processingDurationSeconds(
        job({
          createdAt: "2026-01-01T09:59:00.000Z",
          startedAt: "2026-01-01T10:00:00.000Z",
          finishedAt: "2026-01-01T10:02:05.000Z",
        }),
      ),
    ).toBe(125);
  });

  it("has no duration or finish label before completion", () => {
    expect(processingDurationSeconds(job())).toBeNull();
    expect(formatFinishedAt(null, "en-US")).toBe("—");
  });

  it("measures elapsed time for a running job at the supplied refresh instant", () => {
    expect(
      processingElapsedSeconds(
        job({ startedAt: "2026-01-01T10:00:00.000Z" }),
        Date.parse("2026-01-01T10:02:05.000Z"),
      ),
    ).toBe(125);
  });

  it("formats the recorded finish instant in the requested locale", () => {
    const value = formatFinishedAt("2026-08-30T18:52:00.000Z", "en-US");
    expect(value).toContain("2026");
  });
});

describe("progressPercent", () => {
  /**
   * Reading 100% while the job is still validating invites someone to close
   * the page on unfinished work.
   */
  it("never reads complete before the job is", () => {
    expect(
      progressPercent(job({ overallProgress: 0.999, state: "running" })),
    ).toBe(99);
    expect(progressPercent(job({ overallProgress: 1, state: "running" }))).toBe(
      99,
    );
  });

  it("reads complete once the job succeeded", () => {
    expect(
      progressPercent(job({ overallProgress: 1, state: "succeeded" })),
    ).toBe(100);
  });

  it("clamps values from outside the range", () => {
    expect(progressPercent(job({ overallProgress: -1 }))).toBe(0);
  });
});

describe("live frame merging", () => {
  /**
   * A reconnect can replay an older frame after a newer one. Trusting arrival
   * order would walk the bar backwards, which reads as a fault.
   */
  it("never lets a replayed frame move progress backwards", () => {
    const merged = mergeJobFrame(
      job({ overallProgress: 0.8, stage: "validating" }),
      job({ overallProgress: 0.3, stage: "video" }),
    );

    expect(merged.overallProgress).toBe(0.8);
    expect(merged.stage).toBe("validating");
  });

  it("takes a genuinely newer frame", () => {
    const merged = mergeJobFrame(
      job({ overallProgress: 0.3, stage: "video" }),
      job({ overallProgress: 0.8, stage: "validating" }),
    );

    expect(merged.overallProgress).toBe(0.8);
    expect(merged.stage).toBe("validating");
  });

  it("replaces the frame outright when the job changed", () => {
    const merged = mergeJobFrame(
      job({ id: "other", overallProgress: 0.9 }),
      job({ id: "job-1", overallProgress: 0.1 }),
    );

    expect(merged.overallProgress).toBe(0.1);
  });
});

describe("event merging", () => {
  /** Reconnects replay; the timeline must not gain the same line twice. */
  it("does not duplicate a replayed event", () => {
    const existing = [
      { sequence: 1, message: "a" },
      { sequence: 2, message: "b" },
    ];

    const merged = mergeEvents(existing, [
      { sequence: 2, message: "b" },
      { sequence: 3, message: "c" },
    ]);

    expect(merged.map((entry) => entry.sequence)).toEqual([1, 2, 3]);
  });

  it("keeps the timeline in sequence order whatever order events arrive in", () => {
    const merged = mergeEvents(
      [{ sequence: 3, message: "c" }],
      [{ sequence: 1, message: "a" }],
    );

    expect(merged.map((entry) => entry.sequence)).toEqual([1, 3]);
  });

  it("reports the highest sequence so a reconnect resumes from it", () => {
    expect(
      lastSequence([{ sequence: 1 }, { sequence: 7 }, { sequence: 4 }]),
    ).toBe(7);
    expect(lastSequence([])).toBe(0);
  });
});

describe("formatting", () => {
  it("shows sizes an operator can compare at a glance", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1_500)).toBe("1.5 KB");
    expect(formatBytes(999_999)).toBe("1000.0 KB");
    expect(formatBytes(125_400_000)).toBe("125.4 MB");
    expect(formatBytes(10_000_000_000)).toBe("10000.0 MB");
    expect(formatBytes(null)).toBe("—");
  });

  it("names a standalone file size in gigabytes", () => {
    // The figure on the delete button: recognisable at a glance, because the
    // press after it is the one that cannot be taken back.
    expect(formatFileSize(20_250_000_000)).toBe("20.25 GB");
    expect(formatFileSize(24_600_000_000)).toBe("24.60 GB");
    expect(formatFileSize(1_000_000_000)).toBe("1.00 GB");
    expect(formatFileSize(2_500_000_000_000)).toBe("2.50 TB");
    // Under a gigabyte it stays in MB rather than reading as "0.7 GB".
    expect(formatFileSize(700_000_000)).toBe("700.0 MB");
    expect(formatFileSize(null)).toBe("—");
  });

  it("shows durations without leading zeroes people have to decode", () => {
    expect(formatDuration(45)).toBe("45s");
    expect(formatDuration(95)).toBe("1m 35s");
    expect(formatDuration(3725)).toBe("1h 02m 05s");
    expect(formatDuration(null)).toBe("—");
  });

  it("shows an em dash rather than a misleading zero when speed is unknown", () => {
    expect(formatSpeed(null)).toBe("—");
    expect(formatSpeed(0)).toBe("—");
    expect(formatSpeed(3.76)).toBe("3.76×");
  });
});

describe("summariseLanguages", () => {
  const audio = (
    languageName: string,
    language: string,
    keep: boolean,
    codec = "aac",
    channelLayout = "stereo",
  ) => ({ languageName, language, keep, codec, channelLayout }) as never;
  const sub = (
    languageName: string,
    language: string,
    keep: boolean,
    isForced = false,
  ) => ({ languageName, language, keep, isForced }) as never;

  it("separates what is kept from what is dropped", () => {
    const summary = summariseLanguages(
      [
        audio("English", "eng", true),
        audio("Turkish", "tur", true),
        audio("French", "fra", false),
      ],
      [
        sub("English", "eng", true),
        sub("English", "eng", true, true),
        sub("Turkish", "tur", false),
      ],
    );

    expect(summary.audioKept).toEqual([
      "English AAC stereo",
      "Turkish AAC stereo",
    ]);
    expect(summary.audioDropped).toEqual(["French AAC stereo"]);
    expect(summary.subtitlesKept).toEqual(["English", "English (forced)"]);
  });

  /**
   * Two English tracks where one is kept and one dropped would read as the same
   * word in both lists, which looks like a contradiction rather than a
   * decision, so the format tells them apart.
   */
  it("distinguishes two tracks of the same language by their format", () => {
    const summary = summariseLanguages(
      [
        audio("English", "eng", true, "aac", "7.1"),
        audio("English", "eng", false, "eac3", "5.1"),
      ],
      [],
    );

    expect(summary.audioKept).toEqual(["English AAC 7.1"]);
    expect(summary.audioDropped).toEqual(["English EAC3 5.1"]);
  });

  it("uses the interface's own language names when it knows them", () => {
    const summary = summariseLanguages(
      [audio("English", "eng", true)],
      [sub("Turkish", "tur", true)],
      (key) => (key === "processing.language.eng" ? "İngilizce" : "Türkçe"),
    );

    expect(summary.audioKept).toEqual(["İngilizce AAC stereo"]);
    expect(summary.subtitlesKept).toEqual(["Türkçe"]);
  });

  it("falls back to the server's name for a language it does not know", () => {
    const summary = summariseLanguages([audio("Welsh", "cym", true)], []);

    expect(summary.audioKept).toEqual(["Welsh AAC stereo"]);
  });

  it("copes with a job that has no decision yet", () => {
    const summary = summariseLanguages(undefined, undefined);

    expect(summary.audioKept).toEqual([]);
    expect(summary.subtitlesKept).toEqual([]);
  });
});

describe("localised decision sentences", () => {
  /**
   * The server's own sentence is English. Rendering from the reason code is
   * what keeps a Turkish interface from switching language halfway down the
   * page.
   */
  it("maps every audio decision onto a translation key", () => {
    expect(
      audioDecisionKey({
        keep: true,
        reason: "source-default",
        isCommentary: false,
      } as never),
    ).toBe("processing.audio.keep.source-default");
    expect(
      audioDecisionKey({
        keep: false,
        reason: "duplicate-language",
        isCommentary: false,
      } as never),
    ).toBe("processing.audio.drop.duplicate-language");
  });

  it("names a kept commentary track as commentary, not as a language", () => {
    expect(
      audioDecisionKey({
        keep: true,
        reason: "preferred-language",
        isCommentary: true,
      } as never),
    ).toBe("processing.audio.keep.commentary");
  });

  it("maps every subtitle decision onto a translation key", () => {
    expect(
      subtitleDecisionKey({
        keep: true,
        reason: "forced-preferred-language",
      } as never),
    ).toBe("processing.subtitle.keep.forced-preferred-language");
    expect(
      subtitleDecisionKey({
        keep: false,
        reason: "hearing-impaired-not-requested",
      } as never),
    ).toBe("processing.subtitle.drop.hearing-impaired-not-requested");
  });

  it("describes an audio format from its layout when one is known", () => {
    expect(
      audioFormatLabel({
        codec: "aac",
        channelLayout: "7.1",
        channels: 8,
      } as never),
    ).toBe("AAC 7.1");
    expect(audioFormatLabel({ codec: "eac3", channels: 6 } as never)).toBe(
      "EAC3 6ch",
    );
    expect(audioFormatLabel({ codec: "aac" } as never)).toBe("AAC");
  });
});

function liveSample(
  overrides: Partial<ProcessingLiveProgress> = {},
): ProcessingLiveProgress {
  return {
    processingJobId: "job-1",
    revision: 1,
    timestampMs: 1_000,
    stage: "video",
    phase: "encoding",
    epochIndex: 10,
    epochCount: 31,
    epochStartSeconds: 3000,
    epochEndSeconds: 3300,
    epochFraction: 0.308,
    completedEpochs: 10,
    protectedSeconds: 3000,
    encodedSeconds: 3092.5,
    sourceDurationSeconds: 9039.2,
    ...overrides,
  };
}

describe("encoded progress", () => {
  it("is media time encoded, not a position in the workflow", () => {
    /*
     * The case the whole separation exists for: a job whose workflow bar reads
     * 89% because it has reached a late stage, while the encoder is a third of
     * the way through the film.
     */
    const running = job({
      overallProgress: 0.89,
      encodedSeconds: 3092.5,
      sourceDurationSeconds: 9039.2,
    });
    expect(progressPercent(running)).toBe(89);
    expect(encodedPercent(running)).toBe(34.2);
  });

  it("prefers the live sample, which is fresher than the row", () => {
    const running = job({
      encodedSeconds: 3000,
      sourceDurationSeconds: 9039.2,
    });
    expect(encodedPercent(running, liveSample())).toBe(34.2);
  });

  it("never goes backwards when a stale row arrives after a live sample", () => {
    const running = job({
      encodedSeconds: 4000,
      sourceDurationSeconds: 9039.2,
    });
    const fraction = encodedFraction(running, liveSample());
    expect(fraction).toBeCloseTo(4000 / 9039.2, 6);
  });

  it("says nothing at all before the source duration is known", () => {
    expect(encodedPercent(job({ sourceDurationSeconds: null }))).toBeNull();
  });

  it("reads complete only when the job actually is", () => {
    expect(
      encodedPercent(
        job({
          state: "succeeded",
          encodedSeconds: 0,
          sourceDurationSeconds: 9039.2,
        }),
      ),
    ).toBe(100);
  });
});

describe("formatMediaClock", () => {
  it("reads as a position in the film", () => {
    expect(formatMediaClock(3093)).toBe("00:51:33");
    expect(formatMediaClock(9039.2)).toBe("02:30:39");
    expect(formatMediaClock(0)).toBe("00:00:00");
  });

  it("shows nothing rather than a wrong time when there is no value", () => {
    expect(formatMediaClock(null)).toBe("--:--:--");
    expect(formatMediaClock(Number.NaN)).toBe("--:--:--");
  });
});

describe("protected progress", () => {
  it("takes the furthest-along figure either source knows", () => {
    expect(
      protectedSeconds(job({ protectedSeconds: 2700 }), liveSample()),
    ).toBe(3000);
    expect(completedEpochs(job({ completedEpochs: 12 }), liveSample())).toBe(
      12,
    );
  });
});

describe("smoothedEncodedSeconds", () => {
  it("moves between samples at the rate the encoder reported", () => {
    const value = smoothedEncodedSeconds({
      live: liveSample({ smoothedSpeed: 0.6 }),
      nowMs: 1_500,
    });
    expect(value).toBeCloseTo(3092.8, 6);
  });

  it("stops at the end of the running epoch rather than running past it", () => {
    const value = smoothedEncodedSeconds({
      live: liveSample({ smoothedSpeed: 5 }),
      nowMs: 600_000,
    });
    expect(value).toBe(3300);
  });

  it("does not move at all when nothing is known about the rate", () => {
    expect(smoothedEncodedSeconds({ live: liveSample(), nowMs: 900_000 })).toBe(
      3092.5,
    );
  });

  it("has nothing to say without a live sample", () => {
    expect(smoothedEncodedSeconds({ live: null, nowMs: 1 })).toBeNull();
  });
});

/**
 * The numbers an operator uses to decide whether it is safe to unplug.
 *
 * They are read together — a position, a percentage and a protected mark — so
 * they have to agree with each other at every instant, not merely be
 * individually plausible. These pin the relationships rather than the values.
 */
describe("progress invariants", () => {
  it("never reports a position behind media that is already protected", () => {
    /*
     * The shape of the discrepancy this is here to make impossible: a sample
     * whose protected mark has moved past its own encoded figure. Nothing in
     * the current event order writes one, and the display must not depend on
     * that staying true.
     */
    const value = smoothedEncodedSeconds({
      live: liveSample({ protectedSeconds: 600, encodedSeconds: 599.4 }),
      nowMs: 1_000,
    });
    expect(value).toBe(600);
  });

  it("keeps the floor even when the epoch ceiling would pull it back", () => {
    const value = smoothedEncodedSeconds({
      live: liveSample({
        protectedSeconds: 600,
        encodedSeconds: 599.4,
        epochStartSeconds: 300,
        // A ceiling behind the protected mark, which must not win.
        epochEndSeconds: 599.5,
        smoothedSpeed: 4,
      }),
      nowMs: 60_000,
    });
    expect(value).toBeGreaterThanOrEqual(600);
  });

  it("never runs past the end of the source, however long the gap in samples", () => {
    const value = smoothedEncodedSeconds({
      live: liveSample({
        epochEndSeconds: null,
        smoothedSpeed: 50,
        sourceDurationSeconds: 9039.2,
      }),
      nowMs: 10_000_000,
    });
    expect(value).toBeLessThanOrEqual(9039.2);
  });

  it("keeps the running epoch's own progress inside the running epoch", () => {
    const value = smoothedEncodedSeconds({
      live: liveSample({ smoothedSpeed: 100 }),
      nowMs: 10_000_000,
    });
    expect(value).toBeGreaterThanOrEqual(3000);
    expect(value).toBeLessThanOrEqual(3300);
  });

  /**
   * The specific reading that must never appear: a panel saying a checkpoint
   * protects the first ten minutes while the position beside it reads 09:59.
   */
  it("cannot show 00:09:59 once 00:10:00 is durable", () => {
    const live = liveSample({
      protectedSeconds: 600.016,
      encodedSeconds: 599.9,
      epochStartSeconds: 600.016,
      epochEndSeconds: 900.02,
      sourceDurationSeconds: 1200,
    });
    const position = smoothedEncodedSeconds({ live, nowMs: 1_000 })!;
    expect(formatMediaClock(position)).toBe("00:10:00");
    expect(
      formatMediaClock(protectedSeconds({ protectedSeconds: 0 }, live)),
    ).toBe("00:10:00");
    // And the percentage that goes with it is not below half.
    expect(
      encodedPercent(
        {
          encodedSeconds: 0,
          sourceDurationSeconds: 1200,
          state: "running",
        },
        { ...live, encodedSeconds: position },
      )!,
    ).toBeGreaterThanOrEqual(50);
  });

  it("takes the protected mark from whichever source is further ahead", () => {
    // The durable row ahead of a live sample that has not caught up.
    expect(
      protectedSeconds(
        { protectedSeconds: 3300 },
        liveSample({ protectedSeconds: 3000 }),
      ),
    ).toBe(3300);
    // And the live sample ahead of a row that has not been written yet.
    expect(protectedSeconds({ protectedSeconds: 0 }, liveSample())).toBe(3000);
  });
});

describe("buildPhaseFor", () => {
  it("uses the live sample while there is one", () => {
    expect(
      buildPhaseFor(
        job({ stage: "video" }),
        liveSample({ phase: "assembling" }),
      ),
    ).toBe("assembling");
  });

  it("falls back to the stage so a reopened page still names the phase", () => {
    expect(buildPhaseFor(job({ stage: "packaging" }))).toBe("assembling");
    expect(buildPhaseFor(job({ stage: "video" }))).toBe("encoding");
    expect(buildPhaseFor(job({ stage: "waiting" }))).toBeNull();
  });
});

describe("checkpoint-aware actions", () => {
  it("recognises a stopped job that has work worth continuing from", () => {
    expect(
      hasResumableCheckpoints(
        job({
          state: "cancelled",
          completedEpochs: 10,
          protectedSeconds: 3000,
        }),
      ),
    ).toBe(true);
  });

  it("does not claim checkpoints for a job that never made one", () => {
    expect(
      hasResumableCheckpoints(
        job({ state: "failed", completedEpochs: 0, protectedSeconds: 0 }),
      ),
    ).toBe(false);
  });

  it("says what Retry will actually redo", () => {
    expect(
      retryScopeKey(
        job({ state: "failed", completedEpochs: 3, protectedSeconds: 900 }),
      ),
    ).toBe("processing.retry.fromCheckpoints");
    expect(
      retryScopeKey(
        job({ state: "failed", completedEpochs: 0, protectedSeconds: 0 }),
      ),
    ).toBe("processing.retry.fromStart");
  });

  it("distinguishes waiting for a drive from waiting for a person", () => {
    expect(
      isWaitingForStorage(
        job({
          state: "paused",
          pauseRequested: true,
          pausedReason: "storage-unavailable",
        }),
      ),
    ).toBe(true);
    expect(
      isWaitingForStorage(
        job({
          state: "paused",
          pauseRequested: true,
          pausedReason: "operator",
        }),
      ),
    ).toBe(false);
  });

  it("keeps Continue off a storage pause, which resumes on its own", () => {
    const stalled = job({
      state: "paused",
      pauseRequested: true,
      pausedReason: "storage-unavailable",
    });
    expect(canResume(stalled)).toBe(false);
    expect(canCancel(stalled)).toBe(true);
  });
});

const DAMAGE = {
  type: "source-damage" as const,
  epochIndex: 10,
  sourceStartSeconds: 3000.039,
  sourceEndSeconds: 3300.005,
  expectedDurationSeconds: 299.966,
  sourceRetryCount: 4,
  evidence: [],
  detectedAt: "2026-09-02T00:00:00.000Z",
};

/**
 * Telling a perfect encode from a salvaged one.
 *
 * Both succeed, both leave a playable package, and the state alone cannot say
 * that five minutes of the film are black. This is the only thing that can.
 */
describe("a salvaged title", () => {
  it("is not the same outcome as a clean one", () => {
    expect(isSalvaged(job())).toBe(false);
    expect(isSalvaged(job({ sourceDamage: [] }))).toBe(false);
    expect(isSalvaged(job({ sourceDamage: [DAMAGE] }))).toBe(true);
  });

  it("names its interval the way the incident report does", () => {
    expect(formatDamagedInterval(DAMAGE)).toBe("00:50:00–00:55:00");
    expect(damagedSecondsTotal([DAMAGE])).toBeCloseTo(299.966, 3);
  });

  it("prefers whichever lane has seen more of the damage", () => {
    // The live sample leads while a job runs; the row is what survives a
    // restart. Taking the fuller of the two stops the list flickering.
    expect(sourceDamageRecords(job({ sourceDamage: [DAMAGE] }), null)).toEqual([
      DAMAGE,
    ]);
    expect(
      sourceDamageRecords(job(), {
        sourceDamage: [DAMAGE],
      } as never),
    ).toEqual([DAMAGE]);
    expect(sourceDamageRecords(job(), null)).toEqual([]);
  });
});

/**
 * Saying as little as the evidence supports.
 *
 * An encoder is allowed to be busy, so media time stopping is only ever
 * "waiting"; a read that has actually failed is a problem; and only a spent
 * budget on a healthy volume justifies naming an interval as damaged.
 */
describe("sourceIoNotice", () => {
  it("says nothing when there is nothing to say", () => {
    expect(sourceIoNotice(null)).toBeNull();
    expect(sourceIoNotice({} as never)).toBeNull();
  });

  it("is tentative while nothing is known", () => {
    const notice = sourceIoNotice({
      sourceIo: {
        state: "waiting",
        epochIndex: 10,
        startSeconds: 3000,
        endSeconds: 3300,
      },
    } as never);
    expect(notice?.key).toBe("processing.sourceIo.waiting");
    expect(notice?.tentative).toBe(true);
  });

  it("stops being tentative once the encoder is being stopped", () => {
    const notice = sourceIoNotice({
      sourceIo: {
        state: "aborting",
        epochIndex: 10,
        startSeconds: 3000,
        endSeconds: 3300,
        lastMediaSeconds: 123.29,
      },
    } as never);
    expect(notice?.key).toBe("processing.sourceIo.aborting");
    expect(notice?.tentative).toBe(false);
  });

  it("becomes a statement only once a read has failed for good", () => {
    expect(
      sourceIoNotice({
        sourceIo: {
          state: "suspected",
          epochIndex: 10,
          startSeconds: 3000,
          endSeconds: 3300,
          attempt: 3,
          maxAttempts: 4,
        },
      } as never),
    ).toEqual({
      key: "processing.sourceIo.suspected",
      values: { attempt: "3", attempts: "4" },
      tentative: true,
    });
    const confirmed = sourceIoNotice({
      sourceIo: {
        state: "confirmed",
        epochIndex: 10,
        startSeconds: 3000,
        endSeconds: 3300,
      },
    } as never);
    expect(confirmed?.tentative).toBe(false);
    expect(confirmed?.values).toEqual({ from: "00:50:00", to: "00:55:00" });
  });

  it("says where the build carries on from once the interval is replaced", () => {
    expect(
      sourceIoNotice({
        sourceIo: {
          state: "replaced",
          epochIndex: 10,
          startSeconds: 3000,
          endSeconds: 3300,
          resumeSeconds: 3300,
        },
      } as never),
    ).toEqual({
      key: "processing.sourceIo.replaced",
      values: { from: "00:55:00" },
      tentative: false,
    });
  });
});
