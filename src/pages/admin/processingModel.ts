import type {
  ProcessingAudioDecision,
  ProcessingJob,
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
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // One decimal at every scale: comparing an estimate against an actual size
  // is the whole point of showing both, and dropping the decimal above 100
  // made two visibly different sizes render identically.
  return `${value.toFixed(1)} ${units[unit]}`;
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
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
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
