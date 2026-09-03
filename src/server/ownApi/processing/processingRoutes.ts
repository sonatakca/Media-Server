import { stat, unlink } from "node:fs/promises";
import path from "node:path";
import { OwnApiError } from "../ownApiHandler";
import { sendData } from "../api/envelope";
import type { RouteDefinition } from "../api/router";
import {
  asObjectBody,
  optionalBodyString,
  parseLimit,
  requireUuid,
} from "../api/validation";
import { isPathInsideRoot } from "../../pathSecurity";
import { RENDITION_TARGETS } from "../../../renditions/policy";
import type { CatalogueRepository } from "../catalogue/catalogueRepository";
import type { JobQueue } from "../tasks/jobQueue";
import {
  detectHardware,
  type HardwareReport,
} from "../../../renditions/hardware/detect";
import { probeMediaFile } from "../../../renditions/probe";
import { computeSourceFingerprint } from "../../../renditions/registry";
import {
  decideProcessing,
  freeBytesOn,
  type ProcessingDecision,
} from "../../../renditions/processing/decide";
import { ADAPTIVE_PROFILE_VERSION } from "../../../renditions/adaptive/profile";
import {
  readTitlePackageManifest,
  type TitlePackageManifest,
} from "../../../renditions/adaptive/publishTitle";
import {
  DuplicateProcessingJobError,
  type ProcessingJobRecord,
  type ProcessingJobStore,
  type ProcessingState,
} from "./jobStore";
import { PROCESSING_STAGES } from "./stages";
import {
  createPermissiveStorageGuard,
  type StorageGuard,
} from "./storageGuard";
import type { StorageIncidentStore } from "./storageIncidentStore";
import {
  liveProgressIsFresh,
  readLiveProgress,
  type LiveProgressSnapshot,
} from "./liveProgress";

export const PROCESSING_JOB_TYPE = "media.process";

export interface ProcessingRoutesOptions {
  catalogue: CatalogueRepository;
  store: ProcessingJobStore;
  queue: JobQueue;
  mediaRoot: string;
  renditionRoot: string;
  ffmpegPath?: string;
  ffprobePath?: string;
  /**
   * Whether the media volume is currently mounted. Injected rather than probed
   * here so the routes and the watchdog cannot disagree about it.
   */
  storageAvailable?: () => boolean;
  /**
   * The durable verdict on the storage, and the operator's way back from it.
   *
   * Separate from `storageAvailable` on purpose. That asks the volume whether
   * it is there, which a failing drive answers correctly right up to the moment
   * it takes the machine down; this asks what the system remembers about it,
   * which is the only thing that survives the forced reboot that ends such an
   * incident.
   */
  storageGuard?: StorageGuard;
  /** The incident history, for the panel that explains why nothing is running. */
  storageIncidents?: Pick<StorageIncidentStore, "listOpen" | "listRecent">;
}

/**
 * Hardware is probed by encoding, which costs a second or two. The result only
 * changes when the machine does, so it is held briefly rather than re-probed on
 * every page load.
 */
const HARDWARE_CACHE_MS = 60_000;

function toJobDto(job: ProcessingJobRecord) {
  return {
    id: job.id,
    itemId: job.itemId,
    mediaFileId: job.mediaFileId,
    profile: job.profile,
    state: job.state,
    stage: job.stage,
    stageProgress: job.stageProgress,
    overallProgress: job.overallProgress,
    bytesProcessed: job.bytesProcessed,
    outputBytes: job.outputBytes,
    estimatedOutputBytes: job.estimatedOutputBytes,
    /*
     * Named for what they mean rather than for where they are stored.
     * `actualOutputBytes` is what this job has physically written; it is never
     * the package's size and never a prediction. `outputBytes` is kept as the
     * published package total for anything already reading it.
     */
    actualOutputBytes: job.bytesProcessed,
    estimatedStagingBytes: job.estimatedStagingBytes,
    speed: job.speed,
    fps: job.fps,
    etaSeconds: job.etaSeconds,
    hardwareAdapter: job.hardwareAdapter,
    videoEncoder: job.videoEncoder,
    decision: job.decision,
    validation: job.validation,
    warnings: job.warnings,
    /*
     * Null for a clean encode; an array of replaced intervals for a salvaged
     * one. The page needs this to tell a perfect result from a title that is
     * playable because five minutes of it were substituted, which a `succeeded`
     * state alone cannot say. It carries seconds and counts only — never a path.
     */
    sourceDamage: job.sourceDamage,
    errorCode: job.errorCode,
    errorMessage: job.errorMessage,
    publishedVersion: job.publishedVersion,
    attempts: job.attempts,
    cancellationRequested: job.cancellationRequested,
    pauseRequested: job.pauseRequested,
    pausedReason: job.pausedReason,
    /*
     * The checkpointed build's position. `encodedSeconds` over
     * `sourceDurationSeconds` is the video percentage the page shows;
     * `overallProgress` remains a whole-workflow figure and must never be
     * presented as how much of the film has been encoded.
     */
    epochCount: job.epochCount,
    epochIndex: job.epochIndex,
    completedEpochs: job.completedEpochs,
    protectedSeconds: job.protectedSeconds,
    encodedSeconds: job.encodedSeconds,
    sourceDurationSeconds: job.sourceDurationSeconds,
    epochStartSeconds: job.epochStartSeconds,
    epochEndSeconds: job.epochEndSeconds,
    checkpointBytes: job.checkpointBytes,
    freeBytes: job.freeBytes,
    createdAt: job.createdAt.toISOString(),
    startedAt: job.startedAt?.toISOString() ?? null,
    finishedAt: job.finishedAt?.toISOString() ?? null,
    updatedAt: job.updatedAt.toISOString(),
  };
}

/**
 * Every file the manifest claims, checked against what is actually on disk.
 *
 * Read before a source file is deleted, which is the one action here that
 * cannot be taken back. A manifest is only a record of what publishing meant
 * to leave behind: an interrupted swap or a hand-deleted rendition leaves it
 * describing files that are no longer there, and trusting it at that moment
 * would trade a recoverable package for nothing at all. Sizes are compared as
 * well as existence, because a truncated segment file still opens.
 */
async function missingPackageAssets(
  titleRoot: string,
  manifest: TitlePackageManifest,
): Promise<string[]> {
  const renditions = [
    ...manifest.video,
    ...manifest.audio,
    ...manifest.subtitle,
  ];
  const expected: Array<{ relativePath: string; sizeBytes?: number }> = [
    { relativePath: manifest.masterPlaylistPath },
    ...renditions.flatMap((rendition) => [
      { relativePath: rendition.mediaPath, sizeBytes: rendition.fileSizeBytes },
      { relativePath: rendition.playlistPath },
    ]),
  ];

  const missing: string[] = [];
  for (const entry of expected) {
    const absolutePath = path.resolve(
      titleRoot,
      ...entry.relativePath.split("/"),
    );
    // The manifest is a file on disk like any other, so its paths are treated
    // as data rather than as instructions about what to open.
    if (!isPathInsideRoot(titleRoot, absolutePath)) {
      missing.push(entry.relativePath);
      continue;
    }
    try {
      const stats = await stat(absolutePath);
      if (
        !stats.isFile() ||
        (entry.sizeBytes !== undefined && stats.size !== entry.sizeBytes)
      ) {
        missing.push(entry.relativePath);
      }
    } catch {
      missing.push(entry.relativePath);
    }
  }
  return missing;
}

export function createProcessingRoutes({
  catalogue,
  store,
  queue,
  mediaRoot,
  renditionRoot,
  ffmpegPath = process.env.SEYIRLIK_FFMPEG_PATH ?? "ffmpeg",
  ffprobePath = process.env.SEYIRLIK_FFPROBE_PATH ?? "ffprobe",
  storageAvailable = () => true,
  storageGuard = createPermissiveStorageGuard(),
  storageIncidents,
}: ProcessingRoutesOptions): RouteDefinition[] {
  const resolvedMediaRoot = path.resolve(mediaRoot);

  /**
   * The storage panel's payload.
   *
   * Deliberately says whether automatic resume is blocked as its own field
   * rather than leaving a page to infer it from the state name. "Quarantined"
   * means nothing to somebody who has just found their library stopped; "this
   * will not start again until you say so" means everything.
   */
  const describeGuard = () => ({
    root: storageGuard.health.root,
    state: storageGuard.health.state,
    summary: storageGuard.describe(),
    reason: storageGuard.health.reason,
    faultCount: storageGuard.health.faultCount,
    missingRoots: [...storageGuard.health.missingRoots],
    firstFaultAt:
      storageGuard.health.firstFaultAtMs === null
        ? null
        : new Date(storageGuard.health.firstFaultAtMs).toISOString(),
    lastFaultAt:
      storageGuard.health.lastFaultAtMs === null
        ? null
        : new Date(storageGuard.health.lastFaultAtMs).toISOString(),
    changedAt: new Date(storageGuard.health.changedAtMs).toISOString(),
    verifiedAt:
      storageGuard.health.verifiedAtMs === null
        ? null
        : new Date(storageGuard.health.verifiedAtMs).toISOString(),
    mayStartWork: storageGuard.mayStartWork(),
    automaticResumeBlocked: !storageGuard.resumesAutomatically(),
    /** True when the next step is the operator's cheap verification. */
    awaitingVerification:
      storageGuard.health.state === "quarantined" ||
      storageGuard.health.state === "suspect",
    /** True when verification has passed and only the resume press remains. */
    awaitingResume: storageGuard.health.state === "recovery-pending",
  });
  let hardwareCache: { report: HardwareReport; at: number } | null = null;

  async function hardware(): Promise<HardwareReport> {
    if (hardwareCache && Date.now() - hardwareCache.at < HARDWARE_CACHE_MS) {
      return hardwareCache.report;
    }
    const report = await detectHardware({
      ffmpegPath,
      probeWidth: 1920,
      probeHeight: 1080,
    });
    hardwareCache = { report, at: Date.now() };
    return report;
  }

  /**
   * Where an item's bytes would live, whether or not they are still there.
   *
   * Locating and reading are separate steps because a source can be deleted
   * while the package built from it stays on disk: the path is still the only
   * way to find that package, so it is resolved before the file is opened.
   */
  async function locateSource(itemId: string, mediaFileId?: string) {
    const files = await catalogue.listFilesForItem(itemId);
    const file = mediaFileId
      ? files.find((candidate) => candidate.id === mediaFileId)
      : files[0];
    if (!file) {
      throw new OwnApiError(
        "MEDIA_NOT_FOUND",
        "The requested media could not be found.",
        404,
      );
    }
    const absolutePath = path.resolve(
      resolvedMediaRoot,
      ...file.relativePath.split("/"),
    );
    if (!isPathInsideRoot(resolvedMediaRoot, absolutePath)) {
      throw new OwnApiError(
        "MEDIA_NOT_FOUND",
        "The requested media could not be found.",
        404,
      );
    }
    return { file, absolutePath };
  }

  /**
   * The source's stats, or `null` when the source is gone.
   *
   * A deleted source is an ordinary state of the library, not a fault: `stat`
   * raising ENOENT used to reach the page as a bare internal error, which said
   * nothing about the package the title still has.
   */
  async function statSource(
    file: { missingSince: Date | null },
    absolutePath: string,
  ) {
    if (file.missingSince !== null) return null;
    try {
      return await stat(absolutePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  /**
   * What the title already holds, so a preview can describe the work that is
   * actually left rather than the work a bare source would need.
   *
   * Without this the preview listed the whole ladder for a title that already
   * carried every rung of it, which reads as "all of this is about to be
   * built" when the honest answer is "nothing is".
   */
  async function existingPackage(
    absolutePath: string,
    /** `null` when the source is gone, so nothing can be compared against it. */
    fingerprint: string | null,
  ) {
    const titleRoot = path.dirname(absolutePath);
    const manifest = await readTitlePackageManifest(titleRoot).catch(
      () => undefined,
    );
    if (!manifest) return { present: false as const };

    const sourceMatches =
      fingerprint !== null && manifest.sourceFingerprint === fingerprint;
    const rungs = manifest.video
      .map((rendition) => rendition.qualityHeight)
      .sort((left, right) => right - left);
    /*
     * Whether the package is a whole ladder, judged from the package alone.
     *
     * The source is what normally decides which rungs a title should have, and
     * it can be gone by the time anyone asks. Its own top rung stands in for
     * it: the ladder always reaches the source's class, so a package holding
     * every standard rung at or below its best one is not short of anything.
     */
    const complete = RENDITION_TARGETS.map((target) => target.qualityHeight)
      .filter((height) => height <= (rungs[0] ?? 0))
      .every((height) => rungs.includes(height));
    const profileMatches = manifest.profileVersion === ADAPTIVE_PROFILE_VERSION;
    return {
      present: true as const,
      current: sourceMatches && profileMatches,
      sourceMatches,
      profileMatches,
      rungs,
      complete,
      /*
       * The package's dynamic range, which is the only record of it once the
       * source is gone. A ladder is packaged in one transfer characteristic,
       * so the first rung that is not SDR names the whole package.
       */
      hdr:
        manifest.video.find((rendition) => rendition.hdr !== "sdr")?.hdr ??
        "sdr",
      audioTracks: manifest.audio.length,
      subtitleTracks: manifest.subtitle.length,
      totalBytes: manifest.storage.totalBytes,
    };
  }

  async function analyse(
    itemId: string,
    mediaFileId?: string,
  ): Promise<{
    decision: ProcessingDecision;
    fingerprint: string;
    file: Awaited<ReturnType<typeof locateSource>>["file"];
    absolutePath: string;
    mtimeMs: number;
    /** The package on disk, plus the rungs today's ladder would add to it. */
    existing: Awaited<ReturnType<typeof existingPackage>> & {
      missingRungs: number[];
    };
  }> {
    const { file, absolutePath } = await locateSource(itemId, mediaFileId);
    const stats = await statSource(file, absolutePath);
    if (!stats) {
      throw new OwnApiError(
        "SOURCE_UNAVAILABLE",
        "The source file for this title is no longer on disk.",
        409,
      );
    }
    const probe = await probeMediaFile(absolutePath, ffprobePath);
    const report = await hardware();
    const freeBytes = await freeBytesOn(renditionRoot);
    const fingerprint = await computeSourceFingerprint(absolutePath, stats);
    const existing = await existingPackage(absolutePath, fingerprint);
    const plan = {
      probe,
      container: path.extname(absolutePath).replace(".", ""),
      sizeBytes: stats.size,
      hardware: report,
      ...(freeBytes === undefined ? {} : { freeBytes }),
    };

    /*
     * What this source would be built into today, before asking whether the
     * package on disk already satisfies it.
     *
     * The two questions are separate: the profile version says whether a
     * package is still *readable*, and the ladder says whether it is still
     * *complete*. Deciding completeness from the profile version alone means a
     * title that predates a new rung reports "nothing to do" — and moving the
     * profile version to force the issue is worse, because a mismatch resolves
     * the package to `missing` and withdraws a perfectly playable title from
     * delivery. So the ladder is compared directly. `decideProcessing` reads
     * only the values above, so asking it twice costs nothing.
     */
    const planned = decideProcessing(plan);
    const missingRungs = planned.ladder
      .map((rung) => rung.qualityHeight)
      .filter(
        (height) => !existing.present || !existing.rungs.includes(height),
      );
    const isCurrent =
      existing.present && existing.current && missingRungs.length === 0;

    /*
     * Re-decided once the outstanding work is known, so the estimate and the
     * disk preflight describe this job rather than the finished package. A
     * one-rung job otherwise reported the whole package's size as its own
     * output and reserved space for seven renditions it was not making.
     */
    const incremental =
      !isCurrent &&
      existing.present &&
      existing.current &&
      missingRungs.length > 0;
    const decision = isCurrent
      ? decideProcessing({ ...plan, alreadyCurrent: true })
      : incremental
        ? decideProcessing({
            ...plan,
            renditionsToEncode: missingRungs,
            // Existing audio is reused whenever the package is otherwise
            // current, so this run encodes none of it.
            audioTracksToEncode: 0,
          })
        : planned;

    return {
      decision,
      fingerprint,
      file,
      absolutePath,
      mtimeMs: stats.mtimeMs,
      existing: { ...existing, missingRungs },
    };
  }

  return [
    {
      method: "GET",
      path: "/processing/hardware",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        sendData(context.response, context.requestId, await hardware());
      },
    },

    {
      method: "GET",
      path: "/processing/overview",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        await store.reconcileTerminalQueueJobs();
        const [counts, report, jobs] = await Promise.all([
          store.counts(),
          hardware(),
          store.list({ limit: 50 }),
        ]);
        sendData(context.response, context.requestId, {
          counts,
          hardware: report,
          jobs: jobs.map(toJobDto),
          stages: PROCESSING_STAGES,
          profile: ADAPTIVE_PROFILE_VERSION,
          /*
           * Carried on the overview rather than left to a second request. A
           * page that lists a dozen paused jobs and cannot say why is the page
           * an operator was looking at while the drive was being attacked; the
           * reason has to arrive with the jobs, not after them.
           */
          storage: describeGuard(),
        });
      },
    },

    {
      /**
       * The storage panel, and its history.
       *
       * Read-only and free: everything it reports is memory or a database row.
       * Nothing here touches the volume, which is the point — an operator
       * refreshing the page that tells them their drive is failing must not be
       * the thing that sends another read at it.
       */
      method: "GET",
      path: "/processing/storage",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        sendData(context.response, context.requestId, {
          storage: describeGuard(),
          open: (await storageIncidents?.listOpen()) ?? [],
          recent: (await storageIncidents?.listRecent(20)) ?? [],
        });
      },
    },

    {
      /**
       * "Storage repaired — verify".
       *
       * The whole of the check is the watchdog's own poll: stat the roots, list
       * them, compare the device against the one last seen. It reads no media,
       * takes no checksum and runs no benchmark, because a verification that
       * exercises a suspect drive is simply the next outage with a friendlier
       * label on it.
       *
       * Passing does not start anything. It moves the storage to
       * `recovery-pending`, and the operator presses resume separately — two
       * steps, so that reconnecting a drive is never on its own the thing that
       * restarts a multi-hour encode against it.
       */
      method: "POST",
      path: "/processing/storage/verify",
      access: "admin",
      handle: async (context) => {
        const principal = context.requirePrincipal();
        const outcome = await storageGuard.verify(principal.userId);
        sendData(context.response, context.requestId, {
          ok: outcome.ok,
          detail: outcome.detail,
          /*
           * The page must be able to say *which* thing happened. A drive that
           * was genuinely recovered and a replacement that was adopted are
           * different facts about what is in the machine, and presenting them
           * identically would be the interface lying.
           */
          outcome: outcome.outcome,
          storage: describeGuard(),
        });
      },
    },

    {
      /**
       * "This is replacement storage — adopt it."
       *
       * Its own endpoint rather than a flag on verify, because it is a different
       * act: verification asks whether this is the same disk, adoption declares
       * that a different disk is now the one that counts. It requires a volume
       * that can identify itself and refuses otherwise, so it is never a way to
       * switch fail-closed off.
       */
      method: "POST",
      path: "/processing/storage/adopt",
      access: "admin",
      handle: async (context) => {
        const principal = context.requirePrincipal();
        const outcome = await storageGuard.adopt(principal.userId);
        if (!outcome.ok) {
          throw new OwnApiError(
            "PROCESSING_STORAGE_NOT_ADOPTABLE",
            outcome.detail,
            409,
          );
        }
        sendData(context.response, context.requestId, {
          detail: outcome.detail,
          adoptedVolumeUuid: outcome.adopted?.volumeUuid ?? null,
          storage: describeGuard(),
        });
      },
    },

    {
      /**
       * The second press. The only thing in this system that lifts a
       * quarantine.
       *
       * Refuses unless a verification has passed, so the cheap safe check has
       * definitely been run against the hardware as it is now rather than as it
       * was when somebody last looked.
       */
      method: "POST",
      path: "/processing/storage/resume",
      access: "admin",
      handle: async (context) => {
        const principal = context.requirePrincipal();
        if (storageGuard.health.state !== "recovery-pending") {
          throw new OwnApiError(
            "PROCESSING_STORAGE_NOT_VERIFIED",
            "Verify the storage before resuming it.",
            409,
          );
        }
        await storageGuard.resume(principal.userId);
        /*
         * Jobs are not requeued from here. Whoever owns the encoders owns that
         * decision, and in a split deployment that is the worker process — the
         * one place `requeueStorageInterruptedJobs` lives. Its watchdog sees a
         * healthy guard within a poll and picks the work up, which is also what
         * keeps two runtimes from requeueing the same job twice.
         */
        sendData(context.response, context.requestId, {
          storage: describeGuard(),
        });
      },
    },

    {
      /** The decision, without queueing anything. */
      method: "POST",
      path: "/processing/preview",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        const body = asObjectBody(await context.readJson(8 * 1024), [
          "itemId",
          "mediaFileId",
        ]);
        const itemId = requireUuid(
          optionalBodyString(body, "itemId"),
          "itemId",
        );
        const mediaFileId = body.mediaFileId
          ? requireUuid(optionalBodyString(body, "mediaFileId"), "mediaFileId")
          : undefined;
        /*
         * A title whose source has been deleted still has a package worth
         * describing, so the preview reports the absent source rather than
         * failing on it. There is no decision to make without the bytes: the
         * page shows what is on disk and offers no way to start a job.
         */
        const located = await locateSource(itemId, mediaFileId);
        const stats = await statSource(located.file, located.absolutePath);
        if (!stats) {
          const existing = await existingPackage(located.absolutePath, null);
          const activeJob = await store.findActiveForFile(located.file.id);
          sendData(context.response, context.requestId, {
            itemId,
            mediaFileId: located.file.id,
            relativePath: located.file.relativePath,
            sourceAvailable: false,
            sourceFingerprint: null,
            decision: null,
            existing: { ...existing, missingRungs: [] },
            activeJobId: activeJob?.id ?? null,
          });
          return;
        }

        const { decision, file, fingerprint, existing } = await analyse(
          itemId,
          mediaFileId,
        );
        const active = await store.findActiveForFile(file.id);
        sendData(context.response, context.requestId, {
          itemId,
          mediaFileId: file.id,
          relativePath: file.relativePath,
          sourceAvailable: true,
          sourceFingerprint: fingerprint,
          decision,
          existing,
          activeJobId: active?.id ?? null,
        });
      },
    },

    {
      /**
       * Deletes the source file of a title whose package already holds every
       * rendition it would ever be given.
       *
       * The bytes are gone for good, so nothing the page believes is taken on
       * trust: the source is re-fingerprinted, the ladder is re-decided from
       * it, and every file the package claims is checked before the source is
       * unlinked. A page can be looking at a preview minutes old, and in that
       * time the file can have been replaced or the package half-removed.
       */
      method: "POST",
      path: "/processing/source/delete",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        const body = asObjectBody(await context.readJson(8 * 1024), [
          "itemId",
          "mediaFileId",
        ]);
        const itemId = requireUuid(
          optionalBodyString(body, "itemId"),
          "itemId",
        );
        const mediaFileId = body.mediaFileId
          ? requireUuid(optionalBodyString(body, "mediaFileId"), "mediaFileId")
          : undefined;

        /*
         * A volume that has gone away reads as "every file is missing", which
         * is the one reading under which this route must do nothing at all.
         */
        if (!storageAvailable()) {
          throw new OwnApiError(
            "PROCESSING_STORAGE_UNAVAILABLE",
            "The media volume is not available, so the source file cannot be removed.",
            409,
          );
        }

        const located = await locateSource(itemId, mediaFileId);
        const active = await store.findActiveForFile(located.file.id);
        if (active) {
          throw new OwnApiError(
            "PROCESSING_JOB_EXISTS",
            "This file has a processing job that has not finished, and that job is still reading it.",
            409,
          );
        }

        const stats = await statSource(located.file, located.absolutePath);
        if (!stats) {
          /*
           * The state being asked for is already the state on disk. Reporting
           * that is more useful than failing: a double submission, or a page
           * that lost the response, must not read as a problem.
           */
          sendData(context.response, context.requestId, {
            deleted: false,
            alreadyAbsent: true,
            freedBytes: 0,
          });
          return;
        }
        if (!stats.isFile()) {
          throw new OwnApiError(
            "SOURCE_NOT_A_FILE",
            "The source path is not a regular file.",
            409,
          );
        }

        const { existing } = await analyse(itemId, mediaFileId);
        if (
          !existing.present ||
          !existing.sourceMatches ||
          !existing.profileMatches ||
          existing.missingRungs.length > 0
        ) {
          throw new OwnApiError(
            "PROCESSING_PACKAGE_INCOMPLETE",
            "This title still needs its source: its package is missing renditions, was built from different bytes, or was built by an older profile.",
            409,
          );
        }

        const titleRoot = path.dirname(located.absolutePath);
        const manifest = await readTitlePackageManifest(titleRoot).catch(
          () => undefined,
        );
        if (!manifest) {
          throw new OwnApiError(
            "PROCESSING_PACKAGE_INCOMPLETE",
            "This title's package manifest could not be read, so its renditions cannot be confirmed.",
            409,
          );
        }
        const missing = await missingPackageAssets(titleRoot, manifest);
        if (missing.length > 0) {
          throw new OwnApiError(
            "PROCESSING_PACKAGE_INCOMPLETE",
            `This title's package is incomplete on disk: ${missing.length} of its files are missing or the wrong size.`,
            409,
          );
        }

        await unlink(located.absolutePath);
        sendData(context.response, context.requestId, {
          deleted: true,
          alreadyAbsent: false,
          freedBytes: stats.size,
        });
      },
    },

    {
      method: "POST",
      path: "/processing/jobs",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        /*
         * Refused before the source is even located. Queueing new work against
         * guarded storage is how a backlog gets built that the moment the
         * quarantine lifts is thrown at the drive all at once.
         */
        if (!storageGuard.mayStartWork()) {
          throw new OwnApiError(
            "PROCESSING_STORAGE_GUARDED",
            `${storageGuard.describe()} Verify and resume the storage before queueing new work.`,
            409,
          );
        }
        const body = asObjectBody(await context.readJson(8 * 1024), [
          "itemId",
          "mediaFileId",
        ]);
        const itemId = requireUuid(
          optionalBodyString(body, "itemId"),
          "itemId",
        );
        const mediaFileId = body.mediaFileId
          ? requireUuid(optionalBodyString(body, "mediaFileId"), "mediaFileId")
          : undefined;
        const { decision, file, fingerprint, absolutePath, mtimeMs, existing } =
          await analyse(itemId, mediaFileId);

        if (decision.action.startsWith("reject")) {
          throw new OwnApiError("PROCESSING_REJECTED", decision.summary, 422);
        }
        if (!decision.estimate.sufficient) {
          throw new OwnApiError(
            "INSUFFICIENT_DISK_SPACE",
            "There is not enough free space for this package and its staging copy.",
            507,
          );
        }

        let job: ProcessingJobRecord;
        try {
          job = await store.create({
            itemId,
            mediaFileId: file.id,
            sourceFingerprint: fingerprint,
            profile: ADAPTIVE_PROFILE_VERSION,
            /*
             * The job records the rungs it is actually going to build, not
             * only the ladder the finished package will hold. Without it a
             * one-rung job is indistinguishable from a full rebuild in the
             * history, which is exactly the confusion that hid this bug.
             */
            /*
             * `decision.renditionsToEncode` already states the work; the flag
             * only records whether this was an addition to a package that was
             * otherwise complete, which is what the history reads back.
             */
            decision: {
              ...decision,
              incremental:
                existing.present &&
                decision.renditionsToEncode.length > 0 &&
                decision.renditionsToEncode.length < decision.ladder.length,
            } as unknown as Record<string, unknown>,
            streamDecisions: {
              audio: decision.streams.audio,
              subtitles: decision.streams.subtitles,
            } as unknown as Record<string, unknown>,
            estimatedOutputBytes: decision.estimate.outputBytes,
            estimatedStagingBytes: decision.estimate.stagingBytes,
            hardwareAdapter: decision.hardwareAdapter,
            videoEncoder: decision.videoEncoder,
            warnings: decision.warnings,
          });
        } catch (error) {
          if (error instanceof DuplicateProcessingJobError) {
            throw new OwnApiError(
              "PROCESSING_JOB_EXISTS",
              "This file already has a processing job that has not finished.",
              409,
            );
          }
          throw error;
        }

        const queueJobId = await queue.enqueue({
          jobType: PROCESSING_JOB_TYPE,
          payload: {
            processingJobId: job.id,
            sourcePath: absolutePath,
            relativePath: file.relativePath,
            sizeBytes: Number(file.sizeBytes),
            mtimeMs,
          },
          dedupeKey: `processing:${file.id}`,
        });
        await store.attachQueueJob(job.id, queueJobId);
        await store.appendEvent({
          processingJobId: job.id,
          stage: "waiting",
          message: "Queued for processing.",
        });

        sendData(
          context.response,
          context.requestId,
          { job: toJobDto((await store.get(job.id))!) },
          202,
        );
      },
    },

    {
      method: "GET",
      path: "/processing/jobs",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        await store.reconcileTerminalQueueJobs();
        const stateParam = context.url.searchParams.get("state");
        const limit = parseLimit(
          context.url.searchParams.get("limit"),
          50,
          200,
        );
        const jobs = await store.list({
          ...(stateParam ? { state: stateParam as ProcessingState } : {}),
          limit,
        });
        sendData(context.response, context.requestId, jobs.map(toJobDto));
      },
    },

    {
      method: "GET",
      path: "/processing/jobs/:jobId",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        const id = requireUuid(context.params.jobId, "jobId");
        const job = await store.get(id);
        if (!job) {
          throw new OwnApiError(
            "PROCESSING_JOB_NOT_FOUND",
            "The processing job could not be found.",
            404,
          );
        }
        const after = Number(
          context.url.searchParams.get("afterSequence") ?? 0,
        );
        /*
         * The snapshot carries the live sample too. A page that has just
         * reconnected must not have to wait for the next encoder tick before it
         * can show where the encode is — that wait is what made a refresh look
         * like a stall.
         */
        const live = await readLiveProgress(id);
        sendData(context.response, context.requestId, {
          job: toJobDto(job),
          live: live && liveProgressIsFresh(live) ? live : null,
          streamDecisions: job.streamDecisions,
          events: (
            await store.listEvents(id, Number.isFinite(after) ? after : 0)
          ).map((event) => ({
            sequence: event.sequence,
            stage: event.stage,
            level: event.level,
            message: event.message,
            createdAt: event.createdAt.toISOString(),
          })),
        });
      },
    },

    {
      method: "DELETE",
      path: "/processing/jobs/:jobId",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        const id = requireUuid(context.params.jobId, "jobId");
        const job = await store.get(id);
        if (!job) {
          throw new OwnApiError(
            "PROCESSING_JOB_NOT_FOUND",
            "The processing job could not be found.",
            404,
          );
        }
        if (["pending", "queued", "running", "paused"].includes(job.state)) {
          throw new OwnApiError(
            "PROCESSING_JOB_ACTIVE",
            "An active processing job cannot be removed from history.",
            409,
          );
        }
        const removed = await store.deleteFinished(id);
        if (!removed) {
          throw new OwnApiError(
            "PROCESSING_JOB_ACTIVE",
            "An active processing job cannot be removed from history.",
            409,
          );
        }
        sendData(context.response, context.requestId, { removed: true });
      },
    },

    {
      /**
       * Live progress, as Server-Sent Events.
       *
       * SSE rather than a WebSocket: this is one-way, the server already speaks
       * HTTP with the same session cookie, and a dropped connection reconnects
       * on its own. Every event carries the job's own sequence number as the
       * SSE id, so a browser reconnecting with `Last-Event-ID` resumes exactly
       * where it stopped instead of replaying the timeline or skipping part of
       * it.
       */
      method: "GET",
      path: "/processing/jobs/:jobId/stream",
      access: "admin",
      skipCsrf: true,
      handle: async (context) => {
        context.requirePrincipal();
        const id = requireUuid(context.params.jobId, "jobId");
        const job = await store.get(id);
        if (!job) {
          throw new OwnApiError(
            "PROCESSING_JOB_NOT_FOUND",
            "The processing job could not be found.",
            404,
          );
        }

        const lastEventId = Number(
          context.request.headers["last-event-id"] ??
            context.url.searchParams.get("lastEventId") ??
            0,
        );
        let sequence =
          Number.isFinite(lastEventId) && lastEventId > 0 ? lastEventId : 0;

        const { response } = context;
        response.statusCode = 200;
        response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
        response.setHeader("Cache-Control", "no-store");
        response.setHeader("Connection", "keep-alive");
        response.setHeader("X-Accel-Buffering", "no");
        response.flushHeaders?.();

        let closed = false;
        const send = (event: string, data: unknown, eventId?: number) => {
          if (closed || response.writableEnded) return;
          const lines = [
            ...(eventId === undefined ? [] : [`id: ${eventId}`]),
            `event: ${event}`,
            `data: ${JSON.stringify(data)}`,
            "",
            "",
          ];
          response.write(lines.join("\n"));
        };

        const tick = async () => {
          if (closed) return;
          try {
            const current = await store.get(id);
            if (!current) {
              send("error", { message: "The job no longer exists." });
              finish();
              return;
            }
            send("progress", toJobDto(current));
            const events = await store.listEvents(id, sequence);
            for (const entry of events) {
              sequence = entry.sequence;
              send(
                "stage",
                {
                  sequence: entry.sequence,
                  stage: entry.stage,
                  level: entry.level,
                  message: entry.message,
                  createdAt: entry.createdAt.toISOString(),
                },
                entry.sequence,
              );
            }
            if (["succeeded", "failed", "cancelled"].includes(current.state)) {
              await liveTick();
              send("done", toJobDto(current));
              finish();
            }
          } catch {
            // A transient database error must not kill the stream; the next
            // tick tries again.
          }
        };

        /*
         * The fast lane.
         *
         * The encoder reports four times a second and writes each sample to a
         * small file; the job row is written about once a second. Reading the
         * file here is what lets the page move at the encoder's rate without
         * asking the database to absorb four writes a second per job for hours.
         *
         * Only a sample newer than the last one is sent, so a stalled encoder
         * produces silence rather than a bar that keeps moving.
         */
        let lastRevision = 0;
        const liveTick = async () => {
          if (closed) return;
          const snapshot = await readLiveProgress(id);
          if (!snapshot) return;
          if (snapshot.revision <= lastRevision) return;
          if (!liveProgressIsFresh(snapshot)) return;
          lastRevision = snapshot.revision;
          send("live", snapshot satisfies LiveProgressSnapshot);
        };

        const liveInterval = setInterval(() => void liveTick(), 250);
        const interval = setInterval(() => void tick(), 1000);
        // Keeps intermediaries from closing an idle connection between stages.
        const keepAlive = setInterval(() => {
          if (!closed && !response.writableEnded)
            response.write(": keep-alive\n\n");
        }, 15_000);

        function finish() {
          if (closed) return;
          closed = true;
          clearInterval(interval);
          clearInterval(liveInterval);
          clearInterval(keepAlive);
          response.end();
        }

        context.request.on("close", finish);
        await tick();
        await liveTick();

        // Held open until the client disconnects or the job finishes.
        await new Promise<void>((resolve) => {
          const settle = () => resolve();
          context.request.once("close", settle);
          const poll = setInterval(() => {
            if (closed) {
              clearInterval(poll);
              settle();
            }
          }, 500);
        });
      },
    },

    {
      method: "POST",
      path: "/processing/jobs/:jobId/cancel",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        const id = requireUuid(context.params.jobId, "jobId");
        const job = await store.get(id);
        if (!job) {
          throw new OwnApiError(
            "PROCESSING_JOB_NOT_FOUND",
            "The processing job could not be found.",
            404,
          );
        }
        await store.requestCancellation(id);
        if (job.jobId) await queue.requestCancellation(job.jobId);
        await store.appendEvent({
          processingJobId: id,
          stage: job.stage,
          level: "warning",
          message: "Cancellation requested.",
        });
        sendData(context.response, context.requestId, {
          job: toJobDto((await store.get(id))!),
        });
      },
    },

    /**
     * Suspends an encode without losing it.
     *
     * Cancelling a two-hour 4K ladder throws away every frame it has produced.
     * Pausing stops the encoder where it stands and keeps the work, which is
     * what an operator actually wants when they need the machine back for a
     * while.
     */
    {
      method: "POST",
      path: "/processing/jobs/:jobId/pause",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        const id = requireUuid(context.params.jobId, "jobId");
        const job = await store.get(id);
        if (!job) {
          throw new OwnApiError(
            "PROCESSING_JOB_NOT_FOUND",
            "The processing job could not be found.",
            404,
          );
        }
        await store.requestPause(id, "operator");
        sendData(context.response, context.requestId, {
          job: toJobDto((await store.get(id))!),
        });
      },
    },

    {
      method: "POST",
      path: "/processing/jobs/:jobId/resume",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        const id = requireUuid(context.params.jobId, "jobId");
        const job = await store.get(id);
        if (!job) {
          throw new OwnApiError(
            "PROCESSING_JOB_NOT_FOUND",
            "The processing job could not be found.",
            404,
          );
        }
        /*
         * A job the storage paused cannot be resumed by hand while the volume
         * is still missing: it would wake straight into the same I/O failure
         * and be marked failed, which is exactly the outcome the auto-pause
         * exists to prevent.
         */
        if (job.pausedReason === "storage-unavailable" && !storageAvailable()) {
          throw new OwnApiError(
            "PROCESSING_STORAGE_UNAVAILABLE",
            "The media volume is not available. This job resumes on its own once the volume is back.",
            409,
          );
        }
        /*
         * A guarded volume refuses the per-job resume outright, whatever the
         * volume currently says about itself. Letting an operator resume one
         * job at a time would route straight around the quarantine — and it is
         * the natural thing to try, because the job looks fine and the drive
         * looks mounted. The way back is the storage panel, and it is two
         * deliberate presses.
         */
        if (!storageGuard.mayStartWork()) {
          throw new OwnApiError(
            "PROCESSING_STORAGE_GUARDED",
            `${storageGuard.describe()} Verify and resume the storage before resuming this job.`,
            409,
          );
        }
        await store.resume(id);
        sendData(context.response, context.requestId, {
          job: toJobDto((await store.get(id))!),
        });
      },
    },

    {
      method: "POST",
      path: "/processing/jobs/:jobId/retry",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        const id = requireUuid(context.params.jobId, "jobId");
        const job = await store.get(id);
        if (!job) {
          throw new OwnApiError(
            "PROCESSING_JOB_NOT_FOUND",
            "The processing job could not be found.",
            404,
          );
        }
        if (!storageGuard.mayStartWork()) {
          throw new OwnApiError(
            "PROCESSING_STORAGE_GUARDED",
            `${storageGuard.describe()} Verify and resume the storage before retrying this job.`,
            409,
          );
        }
        if (["queued", "running", "pending"].includes(job.state)) {
          throw new OwnApiError(
            "PROCESSING_JOB_ACTIVE",
            "This job has not finished yet.",
            409,
          );
        }
        const { decision, file, absolutePath, fingerprint, mtimeMs, existing } =
          await analyse(job.itemId, job.mediaFileId);
        /*
         * The whole attempt is reset in one place, and the estimate is taken
         * from the decision made *now*. Resetting a handful of fields by hand
         * here is what left a retry showing the previous attempt's 89%, its
         * finish time and its far larger full-ladder estimate.
         */
        await store.beginAttempt(id, {
          estimatedOutputBytes: decision.estimate.outputBytes,
          estimatedStagingBytes: decision.estimate.stagingBytes,
          decision: {
            ...decision,
            incremental:
              existing.present &&
              decision.renditionsToEncode.length > 0 &&
              decision.renditionsToEncode.length < decision.ladder.length,
          } as unknown as Record<string, unknown>,
          streamDecisions: {
            audio: decision.streams.audio,
            subtitles: decision.streams.subtitles,
          } as unknown as Record<string, unknown>,
          hardwareAdapter: decision.hardwareAdapter,
          videoEncoder: decision.videoEncoder,
          warnings: decision.warnings,
        });
        const queueJobId = await queue.enqueue({
          jobType: PROCESSING_JOB_TYPE,
          payload: {
            processingJobId: id,
            sourcePath: absolutePath,
            relativePath: file.relativePath,
            sizeBytes: Number(file.sizeBytes),
            mtimeMs,
          },
          dedupeKey: `processing:${file.id}:retry:${Date.now()}`,
        });
        await store.attachQueueJob(id, queueJobId);
        await store.appendEvent({
          processingJobId: id,
          stage: "waiting",
          message: "Re-queued after a retry.",
          detail: { sourceFingerprint: fingerprint },
        });
        sendData(
          context.response,
          context.requestId,
          { job: toJobDto((await store.get(id))!) },
          202,
        );
      },
    },
  ];
}
