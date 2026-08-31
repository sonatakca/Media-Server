import { ownApiClient, ownApiUrl } from "../api/ownApi/client";

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
  errorCode: string | null;
  errorMessage: string | null;
  publishedVersion: string | null;
  attempts: number;
  cancellationRequested: boolean;
  pauseRequested: boolean;
  pausedReason: "operator" | "storage-unavailable" | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
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

export interface ProcessingOverview {
  counts: Record<ProcessingState, number>;
  hardware: HardwareReport;
  jobs: ProcessingJob[];
  stages: ProcessingStage[];
  profile: string;
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
