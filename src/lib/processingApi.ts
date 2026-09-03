import { ownApiClient, ownApiUrl } from "../api/ownApi/client";
/*
 * Type-only, so nothing from the packaging layer is bundled into the browser:
 * these are the exact shapes the worker measures and the live stream carries,
 * and restating them here would let the two drift apart silently.
 */
import type {
  AssemblyPhaseProgress,
  AssemblyRenditionProgress,
  AudioPhaseProgress,
  AudioTrackProgress,
  PublishPhaseProgress,
  PublishStepProgress,
  VerificationPhaseProgress,
} from "../renditions/adaptive/phaseProgress";
import type {
  SourceDamageRecord,
  SourceInterval,
} from "../renditions/adaptive/epochs/salvage";
import type { SourceIoStatus } from "../server/ownApi/processing/liveProgress";

export type { SourceDamageRecord, SourceInterval, SourceIoStatus };

export type {
  AssemblyPhaseProgress,
  AssemblyRenditionProgress,
  AudioPhaseProgress,
  AudioTrackProgress,
  PublishPhaseProgress,
  PublishStepProgress,
  VerificationPhaseProgress,
};

/** One finished phase, summarised for the history strip. */
export interface CompletedPhaseSummary {
  phase: ProcessingBuildPhase;
  elapsedSeconds: number;
  bytes?: number;
  count?: number;
  reused?: boolean;
}

/**
 * Client for the media-processing administration API.
 *
 * Kept apart from `mediaApi` because nothing here is part of playback: these
 * calls are only reachable by an administrator and only from the processing
 * page.
 */

export type ProcessingState =
  | "pending"
  | "queued"
  | "running"
  | "paused"
  | "succeeded"
  | "failed"
  | "cancelled";

export type ProcessingStage =
  | "waiting"
  | "analysing"
  | "planning"
  | "video"
  | "audio"
  | "subtitles"
  | "packaging"
  | "validating"
  | "publishing"
  | "complete";

export interface ProcessingLadderRung {
  qualityHeight: number;
  width: number;
  height: number;
}

export interface ProcessingAudioDecision {
  streamIndex: number;
  language: string;
  languageName: string;
  codec: string;
  channels?: number;
  channelLayout?: string;
  title?: string;
  isDefault: boolean;
  isCommentary: boolean;
  keep: boolean;
  reason: string;
  explanation: string;
}

export interface ProcessingSubtitleDecision {
  streamIndex: number;
  language: string;
  languageName: string;
  codec: string;
  title?: string;
  isDefault: boolean;
  isForced: boolean;
  isHearingImpaired: boolean;
  isTextBased: boolean;
  keep: boolean;
  reason: string;
  requiresOcr: boolean;
  explanation: string;
}

export interface ProcessingDecision {
  action: string;
  summary: string;
  source: {
    container: string;
    durationSeconds: number;
    sizeBytes: number;
    width: number;
    height: number;
    qualityHeight: number;
    frameRate?: number;
    videoCodec: string;
    bitDepth?: number;
    pixelFormat?: string;
    isHdr: boolean;
    colorTransfer?: string;
    colorPrimaries?: string;
  };
  ladder: ProcessingLadderRung[];
  /**
   * The rungs this job will actually encode. Absent on jobs recorded before
   * processing became incremental, where the whole ladder was always built.
   */
  renditionsToEncode?: number[];
  incremental?: boolean;
  videoCodec: "h264" | "hevc";
  videoEncoder: string;
  hardwareAdapter: string;
  preservesHdr: boolean;
  streams: {
    audio: ProcessingAudioDecision[];
    subtitles: ProcessingSubtitleDecision[];
    keptAudioStreamIndexes: number[];
    keptSubtitleStreamIndexes: number[];
    warnings: string[];
  };
  estimate: {
    outputBytes: number;
    stagingBytes: number;
    freeBytes?: number;
    sufficient: boolean;
    reserveBytes: number;
  };
  warnings: string[];
}

export interface ProcessingJob {
  id: string;
  itemId: string;
  mediaFileId: string;
  profile: string;
  state: ProcessingState;
  stage: ProcessingStage;
  stageProgress: number;
  overallProgress: number;
  bytesProcessed: number;
  /**
   * Bytes this job has physically written.
   *
   * Distinct from `outputBytes`, which is the whole published package: an
   * incremental job that adds one rendition writes a fraction of what the
   * title holds, and reporting the package total as this job's output is what
   * showed a 5%-complete run as having produced 10 GiB.
   */
  actualOutputBytes: number;
  outputBytes: number | null;
  estimatedOutputBytes: number | null;
  estimatedStagingBytes: number | null;
  speed: number | null;
  fps: number | null;
  etaSeconds: number | null;
  hardwareAdapter: string | null;
  videoEncoder: string | null;
  decision: ProcessingDecision | null;
  validation: { ok: boolean; issues: string[] } | null;
  warnings: string[];
  /**
   * Intervals of the source that could not be read and were replaced.
   *
   * Null for a clean encode. A succeeded job carrying these is *salvaged*: the
   * package is playable and on the source's own timeline, with black picture
   * and silence where the disk could not answer. The page must not present the
   * two as the same outcome.
   */
  sourceDamage: SourceDamageRecord[] | null;
  errorCode: string | null;
  errorMessage: string | null;
  publishedVersion: string | null;
  attempts: number;
  cancellationRequested: boolean;
  pauseRequested: boolean;
  /**
   * Why the job is paused, and who may un-pause it.
   *
   * Only `storage-unavailable` comes back on its own. The other two mean a
   * person has to look: `storage-quarantined` is an established I/O fault, and
   * `recovery-pending` is an attempt whose ending nobody observed.
   */
  pausedReason:
    | "operator"
    | "storage-unavailable"
    | "storage-quarantined"
    | "recovery-pending"
    | null;
  /**
   * The checkpointed build's position.
   *
   * `encodedSeconds / sourceDurationSeconds` is how much of the film has been
   * encoded, and is the only figure that may be shown as encoding progress.
   * `overallProgress` remains a whole-workflow weighting and reads as nearly
   * done long before the encoder is.
   */
  epochCount: number | null;
  epochIndex: number | null;
  completedEpochs: number;
  /** Media time that would survive the machine losing power right now. */
  protectedSeconds: number;
  encodedSeconds: number;
  sourceDurationSeconds: number | null;
  epochStartSeconds: number | null;
  epochEndSeconds: number | null;
  /** Bytes of encoded media protected by checkpoints. */
  checkpointBytes: number;
  freeBytes: number | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
}

/** Where a checkpointed build is, in terms an operator recognises. */
export type ProcessingBuildPhase =
  | "planning"
  | "encoding"
  | "audio"
  | "subtitles"
  | "assembling"
  | "validating"
  | "publishing";

/**
 * One high-frequency sample from the running encoder.
 *
 * Delivered on its own event so it can arrive four times a second without the
 * job row being written that often. Everything in it is transient: a page that
 * has none of it still shows the durable figures from the job record.
 */
export interface ProcessingLiveProgress {
  processingJobId: string;
  revision: number;
  /** When the sample was published. Refreshed by the worker's heartbeat. */
  timestampMs: number;
  /**
   * When the values were last actually measured, which is not the same thing.
   * A phase inside one long operation keeps publishing the same figures so the
   * panel survives; this is what says they have not moved.
   */
  confirmedAtMs?: number;
  stage: ProcessingStage;
  phase: ProcessingBuildPhase;
  epochIndex: number | null;
  epochCount: number | null;
  epochStartSeconds: number | null;
  epochEndSeconds: number | null;
  epochFraction: number | null;
  completedEpochs: number;
  protectedSeconds: number;
  encodedSeconds: number;
  sourceDurationSeconds: number;
  fps?: number;
  speed?: number;
  smoothedSpeed?: number;
  etaSeconds?: number;
  writtenBytes?: number;
  encoder?: string;
  qualityHeights?: number[];
  /**
   * Cumulative progress across the whole job, in [0,1).
   *
   * Drawn as a bar and never printed as a number: everything inside a phase is
   * measured exactly, while the boundaries between phases rest on an estimate
   * of their relative cost, and a percentage would claim a precision the second
   * half of that does not have.
   */
  globalProgress?: number;
  /** How far through the current phase, by that phase's own measure. */
  phaseFraction?: number;
  /** Present only for the phase named by `phase`. */
  audio?: AudioPhaseProgress;
  assembly?: AssemblyPhaseProgress;
  verification?: VerificationPhaseProgress;
  publish?: PublishPhaseProgress;
  completedPhases?: CompletedPhaseSummary[];
  /** The source-read diagnosis, present only while there is one to make. */
  sourceIo?: SourceIoStatus;
  /** Intervals already replaced in this attempt. */
  sourceDamage?: SourceDamageRecord[];
}

export interface ProcessingJobEvent {
  sequence: number;
  stage: ProcessingStage;
  level: "info" | "warning" | "error";
  message: string;
  createdAt: string;
}

export interface HardwareLane {
  family: "h264" | "hevc";
  tenBit: boolean;
  encoder: string | null;
  available: boolean;
  reason?: string;
  detail?: string;
}

export interface HardwareAdapterReport {
  id: string;
  label: string;
  platform: string;
  available: boolean;
  reason?: string;
  detail?: string;
  lanes: HardwareLane[];
}

export interface HardwareReport {
  platform: string;
  probedAt: string;
  adapters: HardwareAdapterReport[];
  selected: { h264: string; hevc: string; hevcTenBit: string };
  selectedAdapter: { h264: string; hevc: string; hevcTenBit: string };
}

/**
 * What the server remembers about the storage, as opposed to what the storage
 * currently says about itself.
 *
 * The distinction is the entire point of the panel this feeds. A drive whose
 * USB bridge is returning `EIO` still answers a `stat` instantly, so "is it
 * mounted" is the question that was being asked throughout the incident that
 * required two forced power-offs. This is the answer to the other one.
 */
export type StorageHealthState =
  | "healthy"
  | "unavailable"
  | "suspect"
  | "quarantined"
  | "recovery-pending";

export interface ProcessingStorageHealth {
  root: string;
  state: StorageHealthState;
  /** One sentence, already written for an operator. Shown verbatim. */
  summary: string;
  reason: string;
  faultCount: number;
  missingRoots: string[];
  firstFaultAt: string | null;
  lastFaultAt: string | null;
  changedAt: string;
  verifiedAt: string | null;
  mayStartWork: boolean;
  /** True whenever the volume returning is not, on its own, enough. */
  automaticResumeBlocked: boolean;
  /** The next step is the operator's cheap, non-destructive check. */
  awaitingVerification: boolean;
  /** Verification passed; only the explicit resume press remains. */
  awaitingResume: boolean;
}

export interface ProcessingOverview {
  counts: Record<ProcessingState, number>;
  hardware: HardwareReport;
  jobs: ProcessingJob[];
  stages: ProcessingStage[];
  profile: string;
  storage: ProcessingStorageHealth;
}

export function getProcessingOverview(): Promise<ProcessingOverview> {
  return ownApiClient.request<ProcessingOverview>("/processing/overview");
}

export function getProcessingHardware(): Promise<HardwareReport> {
  return ownApiClient.request<HardwareReport>("/processing/hardware");
}

/** What the title already holds, so a preview can describe the work left. */
export type ExistingPackage =
  | { present: false }
  | {
      present: true;
      /** True when the package was built from these bytes under this profile. */
      current: boolean;
      sourceMatches: boolean;
      profileMatches: boolean;
      rungs: number[];
      /**
       * True when the package holds every standard rung at or below its own
       * best one — a whole ladder, judged without the source. Absent from
       * servers predating it.
       */
      complete?: boolean;
      /**
       * The package's transfer characteristic: "sdr", "hdr10" or "hlg".
       * Absent from servers predating it, so read it as unknown, not as SDR.
       */
      hdr?: string;
      /**
       * Rungs today's ladder would add to this package.
       *
       * Separate from `current`: a package can match its source and profile
       * exactly and still be a rung short, because a ladder gaining a rung
       * does not make what is on disk unreadable.
       */
      missingRungs: number[];
      audioTracks: number;
      subtitleTracks: number;
      totalBytes: number;
    };

interface ProcessingPreviewBase {
  itemId: string;
  mediaFileId: string;
  relativePath: string;
  existing: ExistingPackage;
  activeJobId: string | null;
}

/**
 * A preview describes a title, not only the work waiting for it.
 *
 * The source can be deleted while the package built from it stays on disk, so
 * `sourceAvailable` is false rather than the request failing: there is no
 * decision to show, but the renditions the title still holds are worth seeing.
 */
export type ProcessingPreview =
  | (ProcessingPreviewBase & {
      /*
       * Optional, and only ever `true`, so that a server predating this field
       * is read as "the source is there" — which is what every response it can
       * produce means. Absence must not be mistaken for absence of a source.
       */
      sourceAvailable?: true;
      sourceFingerprint: string;
      decision: ProcessingDecision;
    })
  | (ProcessingPreviewBase & {
      sourceAvailable: false;
      sourceFingerprint: null;
      decision: null;
    });

export function previewProcessing(
  itemId: string,
  mediaFileId?: string,
): Promise<ProcessingPreview> {
  return ownApiClient.request<ProcessingPreview>("/processing/preview", {
    method: "POST",
    body: { itemId, ...(mediaFileId ? { mediaFileId } : {}) },
  });
}

export function enqueueProcessing(
  itemId: string,
  mediaFileId?: string,
): Promise<{ job: ProcessingJob }> {
  return ownApiClient.request<{ job: ProcessingJob }>("/processing/jobs", {
    method: "POST",
    body: { itemId, ...(mediaFileId ? { mediaFileId } : {}) },
  });
}

/**
 * Removes the source file of a title whose package already holds every
 * rendition.
 *
 * Separate from anything in the job lifecycle: it queues nothing and touches
 * no package, it only takes away the bytes a finished title no longer needs.
 * The server re-checks the package before unlinking, so a refusal here is a
 * real answer about the title and not a stale preview.
 */
export function deleteProcessingSource(
  itemId: string,
  mediaFileId?: string,
): Promise<{
  deleted: boolean;
  /** True when the file was already gone, which is not a failure. */
  alreadyAbsent: boolean;
  freedBytes: number;
}> {
  return ownApiClient.request("/processing/source/delete", {
    method: "POST",
    body: { itemId, ...(mediaFileId ? { mediaFileId } : {}) },
  });
}

export function listProcessingJobs(limit = 50): Promise<ProcessingJob[]> {
  return ownApiClient.request<ProcessingJob[]>(
    `/processing/jobs?limit=${encodeURIComponent(String(limit))}`,
  );
}

export function getProcessingJob(
  jobId: string,
  afterSequence = 0,
): Promise<{
  job: ProcessingJob;
  /**
   * The latest encoder sample, when one is fresh enough to trust.
   *
   * Carried on the snapshot as well as on the stream so a page that has just
   * reconnected does not have to wait for the next tick before it can say where
   * the encode is — that wait is what made a refresh look like a stall.
   */
  live: ProcessingLiveProgress | null;
  streamDecisions: {
    audio: ProcessingAudioDecision[];
    subtitles: ProcessingSubtitleDecision[];
  } | null;
  events: ProcessingJobEvent[];
}> {
  return ownApiClient.request(
    `/processing/jobs/${encodeURIComponent(jobId)}?afterSequence=${afterSequence}`,
  );
}

export function cancelProcessingJob(
  jobId: string,
): Promise<{ job: ProcessingJob }> {
  return ownApiClient.request<{ job: ProcessingJob }>(
    `/processing/jobs/${encodeURIComponent(jobId)}/cancel`,
    { method: "POST" },
  );
}

export function pauseProcessingJob(
  jobId: string,
): Promise<{ job: ProcessingJob }> {
  return ownApiClient.request<{ job: ProcessingJob }>(
    `/processing/jobs/${encodeURIComponent(jobId)}/pause`,
    { method: "POST" },
  );
}

export function resumeProcessingJob(
  jobId: string,
): Promise<{ job: ProcessingJob }> {
  return ownApiClient.request<{ job: ProcessingJob }>(
    `/processing/jobs/${encodeURIComponent(jobId)}/resume`,
    { method: "POST" },
  );
}

export function retryProcessingJob(
  jobId: string,
): Promise<{ job: ProcessingJob }> {
  return ownApiClient.request<{ job: ProcessingJob }>(
    `/processing/jobs/${encodeURIComponent(jobId)}/retry`,
    { method: "POST" },
  );
}

/**
 * The operator's cheap check that the storage is back.
 *
 * Reads directory metadata and a device identity, and nothing else: no media,
 * no checksum, no benchmark. A verification that exercised a suspect drive
 * would simply be the next outage under a friendlier name.
 */
export function verifyProcessingStorage(): Promise<{
  ok: boolean;
  detail: string;
  /**
   * Which thing happened, so a page can never present a replacement as a
   * confirmed recovery of the original hardware. There is deliberately no
   * option here meaning "ignore identity": a volume that cannot be matched is
   * not verified, and the way forward is `adoptProcessingStorage`.
   */
  outcome: "same-identity-verified" | "identity-unconfirmed" | "unavailable";
  storage: ProcessingStorageHealth;
}> {
  return ownApiClient.request("/processing/storage/verify", { method: "POST" });
}

/**
 * Declares the volume currently present to be the storage from now on.
 *
 * For replacement hardware, and for a quarantine recorded before identities
 * were captured. Not an "ignore identity" button: it requires a volume that
 * reports an authoritative UUID, writes that UUID down, keeps the superseded
 * one in the history, and makes every later check an ordinary strict one
 * against the new identity. Refused when nothing there can identify itself.
 */
export function adoptProcessingStorage(): Promise<{
  detail: string;
  adoptedVolumeUuid: string | null;
  storage: ProcessingStorageHealth;
}> {
  return ownApiClient.request("/processing/storage/adopt", { method: "POST" });
}

/**
 * The second, explicit press. The only thing that lifts a quarantine.
 *
 * Separate from verification on purpose: reconnecting a drive must never be, on
 * its own, the thing that restarts a multi-hour 4K encode against it.
 */
export function resumeProcessingStorage(): Promise<{
  storage: ProcessingStorageHealth;
}> {
  return ownApiClient.request("/processing/storage/resume", { method: "POST" });
}

export function deleteProcessingJob(jobId: string): Promise<{ removed: true }> {
  return ownApiClient.request<{ removed: true }>(
    `/processing/jobs/${encodeURIComponent(jobId)}`,
    { method: "DELETE" },
  );
}

/**
 * URL of the live progress stream for one job.
 *
 * `lastEventId` resumes where a dropped connection stopped, so a page that is
 * refreshed mid-encode picks up the timeline rather than replaying it.
 */
export function processingStreamUrl(jobId: string, lastEventId = 0): string {
  return ownApiUrl(
    `/ownAPI/v1/processing/jobs/${encodeURIComponent(jobId)}/stream?lastEventId=${lastEventId}`,
  );
}
