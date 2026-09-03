import type {
  AudioTrackProgress,
  SourceDamageRecord,
  ProcessingAudioDecision,
  ProcessingBuildPhase,
  ProcessingJob,
  ProcessingLiveProgress,
  ProcessingStage,
  ProcessingSubtitleDecision,
} from "../../lib/processingApi";

/**
 * Presentation logic for the Media Processing page.
 *
 * Kept out of the component so the rules that matter — progress never going
 * backwards, an ETA that reads sensibly, which actions a job state allows —
 * can be tested without rendering anything.
 */

export const PROCESSING_STAGE_ORDER: ProcessingStage[] = [
  "waiting",
  "analysing",
  "planning",
  "video",
  "audio",
  "subtitles",
  "packaging",
  "validating",
  "publishing",
  "complete",
];

export type StageState = "done" | "active" | "pending";

/**
 * The timeline's state for one stage.
 *
 * A finished job shows every stage done; a failed or cancelled one leaves the
 * stage it stopped at as the active one, because that is where an operator
 * needs to look.
 */
export function stageStateFor(
  stage: ProcessingStage,
  job: Pick<ProcessingJob, "stage" | "state">,
): StageState {
  if (job.state === "succeeded") return "done";
  const currentIndex = PROCESSING_STAGE_ORDER.indexOf(job.stage);
  const index = PROCESSING_STAGE_ORDER.indexOf(stage);
  if (index < currentIndex) return "done";
  if (index === currentIndex) return "active";
  return "pending";
}

export function isActiveState(state: ProcessingJob["state"]): boolean {
  return ["pending", "queued", "running", "paused"].includes(state);
}

export function canCancel(
  job: Pick<ProcessingJob, "state" | "cancellationRequested">,
): boolean {
  return isActiveState(job.state) && !job.cancellationRequested;
}

/**
 * A running job can be suspended. Pausing keeps the encode where it stands
 * rather than discarding it, so it is offered wherever cancelling is — the
 * difference being that this one is reversible.
 */
export function canPause(
  job: Pick<
    ProcessingJob,
    "state" | "pauseRequested" | "cancellationRequested"
  >,
): boolean {
  return (
    job.state === "running" && !job.pauseRequested && !job.cancellationRequested
  );
}

/**
 * A job paused because the volume went away resumes on its own when it comes
 * back, so offering the button would invite a click that can only fail.
 */
export function canResume(
  job: Pick<
    ProcessingJob,
    "state" | "pauseRequested" | "pausedReason" | "cancellationRequested"
  >,
): boolean {
  return (
    job.pauseRequested &&
    !job.cancellationRequested &&
    job.pausedReason !== "storage-unavailable"
  );
}

export function canRetry(job: Pick<ProcessingJob, "state">): boolean {
  return ["failed", "cancelled"].includes(job.state);
}

/**
 * Progress as a whole number, clamped and never reported as complete before the
 * job actually is.
 *
 * A bar that reads 100% while a job is still validating invites someone to
 * close the page on unfinished work.
 */
export function progressPercent(
  job: Pick<ProcessingJob, "overallProgress" | "state">,
): number {
  const raw = Math.min(1, Math.max(0, job.overallProgress));
  if (job.state === "succeeded") return 100;
  return Math.min(99, Math.round(raw * 100));
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes))
    return "—";
  const safeBytes = Math.max(0, bytes);
  if (safeBytes < 1_000) return `${Math.round(safeBytes)} B`;
  if (safeBytes < 1_000_000) return `${(safeBytes / 1_000).toFixed(1)} KB`;

  // Output figures deliberately stay in MB even when they cross a gigabyte.
  // Actual and estimated output can then be compared digit-for-digit without
  // mentally converting one row from GB while another is still in MB.
  return `${(safeBytes / 1_000_000).toFixed(1)} MB`;
}

/**
 * One size on its own, in the unit someone would actually say it in.
 *
 * Kept apart from `formatBytes`, which holds everything at MB on purpose so a
 * column of output figures can be read digit for digit. A source file
 * announced by itself is the opposite case: it is not being compared with
 * anything, it is usually tens of gigabytes, and "24600.0 MB" on a button that
 * deletes the file is a number to decode rather than a size to recognise.
 * Below a gigabyte it stays in MB, because "0.7 GB" reads as nothing at all.
 *
 * Two decimals, not one: at this scale a tenth of a gigabyte is still a
 * hundred megabytes, and the figure is being read to decide whether the file
 * is worth removing.
 */
export function formatFileSize(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes))
    return "—";
  const safeBytes = Math.max(0, bytes);
  if (safeBytes >= 1_000_000_000_000)
    return `${(safeBytes / 1_000_000_000_000).toFixed(2)} TB`;
  if (safeBytes >= 1_000_000_000)
    return `${(safeBytes / 1_000_000_000).toFixed(2)} GB`;
  return formatBytes(safeBytes);
}

/** Duration in the shortest form that stays unambiguous. */
export function formatDuration(seconds: number | null | undefined): string {
  if (
    seconds === null ||
    seconds === undefined ||
    !Number.isFinite(seconds) ||
    seconds < 0
  ) {
    return "—";
  }
  const whole = Math.round(seconds);
  if (whole < 60) return `${whole}s`;
  const minutes = Math.floor(whole / 60);
  const remainder = whole % 60;
  if (minutes < 60) return `${minutes}m ${String(remainder).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m ${String(remainder).padStart(2, "0")}s`;
}

export function formatSpeed(speed: number | null | undefined): string {
  if (
    speed === null ||
    speed === undefined ||
    !Number.isFinite(speed) ||
    speed <= 0
  ) {
    return "—";
  }
  return `${speed.toFixed(2)}×`;
}

/** Wall-clock time spent on a finished job, measured from its actual start. */
export function processingDurationSeconds(
  job: Pick<ProcessingJob, "createdAt" | "startedAt" | "finishedAt">,
): number | null {
  if (!job.finishedAt) return null;
  const start = Date.parse(job.startedAt ?? job.createdAt);
  const finish = Date.parse(job.finishedAt);
  if (!Number.isFinite(start) || !Number.isFinite(finish) || finish < start) {
    return null;
  }
  return (finish - start) / 1000;
}

/** Wall-clock time already spent on work that has not finished yet. */
export function processingElapsedSeconds(
  job: Pick<ProcessingJob, "createdAt" | "startedAt">,
  nowMs: number,
): number | null {
  const start = Date.parse(job.startedAt ?? job.createdAt);
  if (!Number.isFinite(start) || !Number.isFinite(nowMs) || nowMs < start) {
    return null;
  }
  return (nowMs - start) / 1000;
}

/** Local date and clock time for a history row. */
export function formatFinishedAt(
  finishedAt: string | null | undefined,
  locale: string,
): string {
  if (!finishedAt) return "—";
  const value = new Date(finishedAt);
  if (!Number.isFinite(value.getTime())) return "—";
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(value);
}

/** Languages kept and dropped, ready to render as two short lists. */
export function summariseLanguages(
  audio: ProcessingAudioDecision[] | undefined,
  subtitles: ProcessingSubtitleDecision[] | undefined,
  translate: (key: string) => string = (key) => key,
  forcedLabel = "forced",
): { audioKept: string[]; audioDropped: string[]; subtitlesKept: string[] } {
  const unique = (values: string[]) => [...new Set(values)];
  const name = (entry: { language: string; languageName: string }) =>
    localisedLanguageName(entry, translate);
  // A track is named by its language *and* its format here: two English tracks
  // where one is kept and one dropped would otherwise read as the same word in
  // both lists, which looks like a contradiction rather than a decision.
  const audioName = (entry: ProcessingAudioDecision) =>
    `${name(entry)} ${audioFormatLabel(entry)}`.trim();
  return {
    audioKept: unique(
      (audio ?? []).filter((entry) => entry.keep).map(audioName),
    ),
    audioDropped: unique(
      (audio ?? []).filter((entry) => !entry.keep).map(audioName),
    ),
    subtitlesKept: unique(
      (subtitles ?? [])
        .filter((entry) => entry.keep)
        .map(
          (entry) =>
            `${name(entry)}${entry.isForced ? ` (${forcedLabel})` : ""}`,
        ),
    ),
  };
}

/**
 * Merges a live progress frame onto the job already on screen.
 *
 * The stream can deliver an older frame after a newer one when a reconnect
 * replays, so the merge keeps the furthest-along values rather than trusting
 * arrival order.
 */
export function mergeJobFrame(
  previous: ProcessingJob | undefined,
  next: ProcessingJob,
): ProcessingJob {
  if (!previous || previous.id !== next.id) return next;
  return {
    ...next,
    overallProgress: Math.max(previous.overallProgress, next.overallProgress),
    stage:
      PROCESSING_STAGE_ORDER.indexOf(next.stage) >=
      PROCESSING_STAGE_ORDER.indexOf(previous.stage)
        ? next.stage
        : previous.stage,
  };
}

/**
 * Appends stage events without letting a reconnect duplicate them.
 *
 * Every event carries a per-job sequence number, so a replay is recognised by
 * its sequence rather than by comparing message text.
 */
export function mergeEvents<T extends { sequence: number }>(
  previous: T[],
  incoming: T[],
): T[] {
  if (incoming.length === 0) return previous;
  const bySequence = new Map(previous.map((entry) => [entry.sequence, entry]));
  for (const entry of incoming) bySequence.set(entry.sequence, entry);
  return [...bySequence.values()].sort(
    (left, right) => left.sequence - right.sequence,
  );
}

export function lastSequence(events: Array<{ sequence: number }>): number {
  return events.reduce(
    (highest, entry) => Math.max(highest, entry.sequence),
    0,
  );
}

/**
 * A decision sentence in the viewer's own language.
 *
 * The server sends a readable English sentence and, separately, the structured
 * reason it came from. The sentence is a useful fallback, but rendering from
 * the reason is what lets the Turkish interface stay Turkish rather than
 * switching language halfway down the page.
 */
export function audioDecisionKey(entry: ProcessingAudioDecision): string {
  if (entry.keep && entry.isCommentary)
    return "processing.audio.keep.commentary";
  return `processing.audio.${entry.keep ? "keep" : "drop"}.${entry.reason}`;
}

export function subtitleDecisionKey(entry: ProcessingSubtitleDecision): string {
  return `processing.subtitle.${entry.keep ? "keep" : "drop"}.${entry.reason}`;
}

/** The codec and channel layout, as a short parenthetical for the sentence. */
export function audioFormatLabel(entry: ProcessingAudioDecision): string {
  const layout =
    entry.channelLayout ?? (entry.channels ? `${entry.channels}ch` : "");
  return [entry.codec.toUpperCase(), layout].filter(Boolean).join(" ");
}

/**
 * The translation key for a language name, so a Turkish interface says
 * "İngilizce" rather than "English".
 *
 * Falls back to the server's own name for anything outside the set the
 * interface knows, which is better than showing a bare ISO code.
 */
export function languageNameKey(code: string): string {
  return `processing.language.${code}`;
}

export const KNOWN_LANGUAGE_CODES = new Set([
  "eng",
  "tur",
  "fra",
  "deu",
  "spa",
  "ita",
  "jpn",
  "rus",
  "por",
  "ara",
  "zho",
  "kor",
  "nld",
  "und",
]);

export function localisedLanguageName(
  entry: { language: string; languageName: string },
  translate: (key: string) => string,
): string {
  if (!KNOWN_LANGUAGE_CODES.has(entry.language)) return entry.languageName;
  const key = languageNameKey(entry.language);
  const translated = translate(key);
  // A locale missing this key returns the key itself. Showing
  // `processing.language.eng` to a viewer is worse than showing "English", so
  // an untranslated key falls back to the name the server sent.
  return translated && translated !== key ? translated : entry.languageName;
}

/**
 * How much of the film has actually been encoded.
 *
 * Deliberately not `overallProgress`. That figure weights whole workflow
 * stages, so a job which had merely *reached* a late stage read as 89% while
 * FFmpeg was a third of the way through the picture — the exact confusion this
 * separation exists to end. This is media time and nothing else: the epochs
 * that are durable, plus however far into the running one the encoder has got.
 *
 * The live sample wins when there is one, because it is up to four times
 * fresher than the job row; the row answers when the encoder has not reported
 * yet, which is what a page opened after a restart sees.
 */
export function encodedFraction(
  job: Pick<
    ProcessingJob,
    "encodedSeconds" | "sourceDurationSeconds" | "state"
  >,
  live?: ProcessingLiveProgress | null,
): number | null {
  const duration = live?.sourceDurationSeconds ?? job.sourceDurationSeconds;
  if (!duration || duration <= 0) return null;
  if (job.state === "succeeded") return 1;
  const encoded = Math.max(live?.encodedSeconds ?? 0, job.encodedSeconds);
  return Math.min(1, Math.max(0, encoded / duration));
}

export function encodedPercent(
  job: Pick<
    ProcessingJob,
    "encodedSeconds" | "sourceDurationSeconds" | "state"
  >,
  live?: ProcessingLiveProgress | null,
): number | null {
  const fraction = encodedFraction(job, live);
  if (fraction === null) return null;
  // One decimal, because at feature length a whole percent is a minute and a
  // half of film and a bar that only moves once a minute reads as stuck.
  return Math.round(fraction * 1000) / 10;
}

/** Position on the source timeline, as a clock. */
export function formatMediaClock(seconds: number | null | undefined): string {
  if (
    seconds === null ||
    seconds === undefined ||
    !Number.isFinite(seconds) ||
    seconds < 0
  ) {
    return "--:--:--";
  }
  const whole = Math.floor(seconds);
  const hours = String(Math.floor(whole / 3600)).padStart(2, "0");
  const minutes = String(Math.floor((whole % 3600) / 60)).padStart(2, "0");
  const rest = String(whole % 60).padStart(2, "0");
  return `${hours}:${minutes}:${rest}`;
}

/**
 * The number an operator most wants: how much work a crash cannot take away.
 */
export function protectedSeconds(
  job: Pick<ProcessingJob, "protectedSeconds">,
  live?: ProcessingLiveProgress | null,
): number {
  return Math.max(job.protectedSeconds, live?.protectedSeconds ?? 0);
}

export function completedEpochs(
  job: Pick<ProcessingJob, "completedEpochs">,
  live?: ProcessingLiveProgress | null,
): number {
  return Math.max(job.completedEpochs, live?.completedEpochs ?? 0);
}

/**
 * Media time to show right now, interpolated between authoritative samples.
 *
 * Bounded twice over: never past the end of the running epoch, and never past
 * what the elapsed time could plausibly have produced. A stalled encoder
 * therefore reaches the bound and stops, rather than showing a bar that keeps
 * moving over an encoder that is doing nothing.
 */
export function smoothedEncodedSeconds({
  live,
  nowMs,
}: {
  live: ProcessingLiveProgress | null | undefined;
  nowMs: number;
}): number | null {
  if (!live) return null;
  /*
   * The floor is the durable mark, and it is applied to every path out of this
   * function including the ceilings below.
   *
   * Media that is already checkpointed has been encoded by definition, so a
   * position behind it is not a conservative estimate, it is a wrong one — and
   * the one thing an operator reads this number for is to know how much work is
   * safe. Nothing in the current event order produces such a sample, but
   * "currently impossible" is not the same as "cannot happen", and a bar that
   * walks backwards over protected media is the exact confusion this panel
   * exists to remove.
   */
  const floor = live.protectedSeconds;
  const speed = live.smoothedSpeed ?? live.speed;
  if (!speed || speed <= 0) return Math.max(floor, live.encodedSeconds);
  const elapsedSeconds = Math.max(0, (nowMs - live.timestampMs) / 1000);
  const ceiling = Math.min(
    live.sourceDurationSeconds,
    live.epochEndSeconds ?? live.sourceDurationSeconds,
  );
  return Math.max(
    floor,
    Math.min(ceiling, live.encodedSeconds + elapsedSeconds * speed),
  );
}

/**
 * The whole-job bar's position, as a percentage of its own width.
 *
 * Three sources, in order of authority: a finished job is finished, a live
 * sample knows where the work is, and the row is what remains after a restart.
 * Taking the largest of the two that are live is what keeps the bar from
 * stepping backwards when a sample arrives a moment before the row that
 * follows it — they are written by different processes at different rates.
 *
 * Deliberately returns a number for a bar's width and nothing else. The page
 * never prints it: inside every phase the figures are measured exactly, but the
 * boundaries between phases are an estimate of relative cost, and a percentage
 * would claim a precision that half of the model does not have.
 */
export function globalProgressPercent(
  job: Pick<ProcessingJob, "overallProgress" | "state">,
  live?: ProcessingLiveProgress | null,
): number {
  if (job.state === "succeeded") return 100;
  const fromRow = Number.isFinite(job.overallProgress)
    ? Math.min(1, Math.max(0, job.overallProgress))
    : 0;
  const fromLive =
    live?.globalProgress !== undefined && Number.isFinite(live.globalProgress)
      ? Math.min(1, Math.max(0, live.globalProgress))
      : 0;
  // Never the full width unless the job actually finished: a bar that fills
  // while a package is still being published is the exact lie this replaces.
  return Math.min(99.9, Math.max(fromRow, fromLive) * 100);
}

/**
 * How long a live sample may be trusted before it is treated as a stall.
 *
 * The worker publishes about four times a second while any phase is producing
 * progress, so silence for this long means the work stopped: a pause, a
 * vanished volume, a killed worker. The figures in the last sample are still
 * true — they are what was measured — but a throughput and a remaining time are
 * not, because both describe a rate that is no longer happening.
 *
 * Mirrors the server's own staleness window; the two describe the same fact
 * from either end of the stream.
 */
export const LIVE_SAMPLE_STALE_MS = 6_000;

export function liveSampleIsStale(
  live: ProcessingLiveProgress | null | undefined,
  nowMs: number,
): boolean {
  if (!live) return false;
  /*
   * Measured at, not published at. The worker republishes the same figures
   * every couple of seconds so a long single operation keeps its panel; what
   * decides whether a throughput is still true is when the figures last
   * changed, which is what `confirmedAtMs` records. Samples from before that
   * field existed fall back to the publication time, where the two were equal.
   */
  return (
    nowMs - (live.confirmedAtMs ?? live.timestampMs) > LIVE_SAMPLE_STALE_MS
  );
}

/** Bytes per second, in the units a person reading a disk figure expects. */
export function formatByteRate(
  bytesPerSecond: number | null | undefined,
): string {
  if (
    bytesPerSecond === null ||
    bytesPerSecond === undefined ||
    !Number.isFinite(bytesPerSecond) ||
    bytesPerSecond <= 0
  ) {
    return "—";
  }
  if (bytesPerSecond >= 1024 ** 3) {
    return `${(bytesPerSecond / 1024 ** 3).toFixed(2)} GiB/s`;
  }
  if (bytesPerSecond >= 1024 ** 2) {
    return `${(bytesPerSecond / 1024 ** 2).toFixed(1)} MiB/s`;
  }
  return `${(bytesPerSecond / 1024).toFixed(0)} KiB/s`;
}

/**
 * A percentage for a phase's own detail, where one decimal is meaningful.
 *
 * Unlike the global bar these are exact: bytes written over bytes to write,
 * media seconds over media seconds.
 */
export function phasePercent(fraction: number | null | undefined): string {
  if (
    fraction === null ||
    fraction === undefined ||
    !Number.isFinite(fraction)
  ) {
    return "—";
  }
  return `${(Math.min(1, Math.max(0, fraction)) * 100).toFixed(1)}%`;
}

/** The label key for a finished phase's history line. */
export function completedPhaseLabelKey(phase: ProcessingBuildPhase): string {
  return BUILD_PHASE_LABEL_KEYS[phase];
}

/**
 * An audio track's one-line description: language, codec, channels.
 *
 * Assembled here rather than in the component so the fallbacks are testable —
 * a source that declares no language for a track is ordinary, and the line has
 * to read properly without it.
 */
export function describeAudioTrack(
  track: AudioTrackProgress,
  languageName: (code: string) => string,
): string {
  const channels =
    track.channels >= 6
      ? "5.1"
      : track.channels === 2
        ? "2.0"
        : track.channels === 1
          ? "1.0"
          : null;
  return [
    track.language ? languageName(track.language) : track.title,
    track.codec.toUpperCase(),
    channels,
  ]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
}

/** Human phase label key, so the page can say what is happening rather than a percentage. */
export const BUILD_PHASE_LABEL_KEYS: Readonly<
  Record<ProcessingBuildPhase, string>
> = {
  planning: "processing.phase.planning",
  encoding: "processing.phase.encoding",
  audio: "processing.phase.audio",
  subtitles: "processing.phase.subtitles",
  assembling: "processing.phase.assembling",
  validating: "processing.phase.validating",
  publishing: "processing.phase.publishing",
};

/**
 * The phase to show, from whichever source knows.
 *
 * The live sample is authoritative while it exists. Without one the stage on
 * the job row is mapped back, so a page opened after a restart still says
 * "Assembling" rather than falling back to a bare percentage.
 */
export function buildPhaseFor(
  job: Pick<ProcessingJob, "stage">,
  live?: ProcessingLiveProgress | null,
): ProcessingBuildPhase | null {
  if (live) return live.phase;
  switch (job.stage) {
    case "planning":
      return "planning";
    case "video":
      return "encoding";
    case "audio":
      return "audio";
    case "subtitles":
      return "subtitles";
    case "packaging":
      return "assembling";
    case "validating":
      return "validating";
    case "publishing":
      return "publishing";
    default:
      return null;
  }
}

/**
 * Whether a stopped job has durable work a retry would carry forward.
 *
 * Retry is offered on any finished-unhappily job, but what it *means* differs:
 * with checkpoints it continues, without them it starts again, and telling an
 * operator which is what the button is for.
 */
export function hasResumableCheckpoints(
  job: Pick<ProcessingJob, "completedEpochs" | "protectedSeconds" | "state">,
): boolean {
  return (
    ["failed", "cancelled", "paused"].includes(job.state) &&
    job.completedEpochs > 0 &&
    job.protectedSeconds > 0
  );
}

/**
 * What Retry will actually redo, in words.
 *
 * "Retry" on its own invites the fear it is about to throw away five hours of
 * encoding, which for a checkpointed build is precisely wrong.
 */
export function retryScopeKey(
  job: Pick<ProcessingJob, "completedEpochs" | "protectedSeconds" | "state">,
): "processing.retry.fromCheckpoints" | "processing.retry.fromStart" {
  return hasResumableCheckpoints(job)
    ? "processing.retry.fromCheckpoints"
    : "processing.retry.fromStart";
}

/**
 * Whether the job is waiting for a volume rather than for a person.
 *
 * A storage-paused job resumes on its own, so the page offers waiting and a
 * storage re-check rather than a Continue button that can only fail.
 */
export function isWaitingForStorage(
  job: Pick<ProcessingJob, "state" | "pauseRequested" | "pausedReason">,
): boolean {
  return job.pausedReason === "storage-unavailable" && job.pauseRequested;
}

/**
 * Whether a finished job replaced part of the source rather than encoding it.
 *
 * The one question that separates a perfect encode from a salvaged one, and it
 * is deliberately not answerable from the job's state: both succeeded, both
 * left a playable package, and only this says that five minutes of the film are
 * black because the disk could not read them.
 */
export function isSalvaged(job: Pick<ProcessingJob, "sourceDamage">): boolean {
  return (job.sourceDamage?.length ?? 0) > 0;
}

/** Replaced intervals, from whichever source knows: the live sample or the row. */
export function sourceDamageRecords(
  job: Pick<ProcessingJob, "sourceDamage">,
  live?: ProcessingLiveProgress | null,
): SourceDamageRecord[] {
  const fromLive = live?.sourceDamage ?? [];
  const fromRow = job.sourceDamage ?? [];
  return fromLive.length >= fromRow.length ? fromLive : fromRow;
}

/** `00:50:00–00:55:00`, the form the warning and the panel both use. */
export function formatDamagedInterval(
  record: Pick<SourceDamageRecord, "sourceStartSeconds" | "sourceEndSeconds">,
): string {
  return `${formatMediaClock(record.sourceStartSeconds)}–${formatMediaClock(
    record.sourceEndSeconds,
  )}`;
}

/** Total media time replaced, for a one-line summary. */
export function damagedSecondsTotal(
  records: readonly SourceDamageRecord[],
): number {
  return records.reduce(
    (total, record) =>
      total + Math.max(0, record.sourceEndSeconds - record.sourceStartSeconds),
    0,
  );
}

/** What the panel says about the source, and the values its sentence needs. */
export interface SourceIoNotice {
  key:
    | "processing.sourceIo.waiting"
    | "processing.sourceIo.aborting"
    | "processing.sourceIo.suspected"
    | "processing.sourceIo.confirmed"
    | "processing.sourceIo.replacing"
    | "processing.sourceIo.replaced";
  /** Substitutions for the template, already formatted as clock times. */
  values: Record<string, string>;
  /** True while nothing is wrong yet and the encoder may simply be busy. */
  tentative: boolean;
}

/**
 * The source-read notice to show, if any.
 *
 * Deliberately says as little as the evidence supports. Media time stopping is
 * "waiting for source data", because an encoder is allowed to be busy; a read
 * that has actually failed is "source read problem"; and only a spent budget on
 * a healthy volume justifies naming an interval as damaged. Showing the last of
 * those first is how a page ends up accusing a perfectly good disc.
 */
export function sourceIoNotice(
  live: ProcessingLiveProgress | null | undefined,
): SourceIoNotice | null {
  const status = live?.sourceIo;
  if (!status) return null;
  const from = formatMediaClock(status.startSeconds ?? 0);
  const to = formatMediaClock(status.endSeconds ?? 0);
  switch (status.state) {
    case "waiting":
      return {
        key: "processing.sourceIo.waiting",
        values: {},
        tentative: true,
      };
    case "aborting":
      /*
       * No longer tentative: the encoder is being stopped. What follows can
       * take tens of seconds, because a process wedged in an uninterruptible
       * read cannot be killed until the kernel returns control — so saying so
       * is the difference between a page that looks busy and one that looks
       * crashed.
       */
      return {
        key: "processing.sourceIo.aborting",
        values: {},
        tentative: false,
      };
    case "suspected":
      return {
        key: "processing.sourceIo.suspected",
        values: {
          attempt: String(status.attempt ?? 1),
          attempts: String(status.maxAttempts ?? 1),
        },
        tentative: true,
      };
    case "confirmed":
      return {
        key: "processing.sourceIo.confirmed",
        values: { from, to },
        tentative: false,
      };
    case "replacing":
      return {
        key: "processing.sourceIo.replacing",
        values: { from, to },
        tentative: false,
      };
    case "replaced":
      return {
        key: "processing.sourceIo.replaced",
        values: {
          from: formatMediaClock(
            status.resumeSeconds ?? status.endSeconds ?? 0,
          ),
        },
        tentative: false,
      };
    default:
      return null;
  }
}
