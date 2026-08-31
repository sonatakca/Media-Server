import { describe, expect, it } from "vitest";
import type { ProcessingJob } from "../../lib/processingApi";
import {
  audioDecisionKey,
  audioFormatLabel,
  canCancel,
  canPause,
  canResume,
  canRetry,
  formatBytes,
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
    errorCode: null,
    errorMessage: null,
    publishedVersion: null,
    attempts: 1,
    cancellationRequested: false,
    pauseRequested: false,
    pausedReason: null,
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
    expect(formatBytes(1024 * 1024 * 125.4)).toBe("125.4 MiB");
    expect(formatBytes(null)).toBe("—");
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
