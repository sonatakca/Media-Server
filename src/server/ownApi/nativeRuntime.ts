import { stat } from "node:fs/promises";
import path from "node:path";
import type { IncomingMessage } from "node:http";
import type { OwnApiRouteHandler } from "./ownApiHandler";
import {
  createDatabasePool,
  checkDatabaseReadiness,
  validateDatabaseConnection,
  validateNativeIdentitySchema,
  type DatabasePool,
} from "./database/databasePool";
import { parseDatabaseConfig } from "./database/databaseConfig";
import { validateMigrationsCurrent } from "./database/migrationRunner";
import { createUserRepository } from "./users/userRepository";
import { createSessionRepository } from "./auth/sessionRepository";
import { createArgon2PasswordHasher } from "./auth/passwords";
import { createNativeAuthService } from "./auth/authService";
import { parseNativeAuthConfig } from "./auth/authConfig";
import { createNativeAuthHttpHandler } from "./auth/authHttpHandler";
import {
  createOwnApiRouter,
  type RoutePrincipal,
  type RouteDefinition,
} from "./api/router";
import { parseCookies, uniqueCookie } from "./api/http";
import { createCatalogueRepository } from "./catalogue/catalogueRepository";
import { createCatalogueScanStore } from "./catalogue/catalogueScanStore";
import { createHomeRepository } from "./catalogue/homeRepository";
import { createCatalogueService } from "./catalogue/catalogueService";
import { createCatalogueRoutes } from "./catalogue/catalogueRoutes";
import { createImageRepository } from "./images/imageRepository";
import { createImageStorage } from "./images/imageStorage";
import { createImageRoutes } from "./images/imageRoutes";
import { migrateTitleArtwork } from "./images/titleArtworkMigration";
import { createBookRoutes } from "./books/bookRoutes";
import { createMetadataRepository } from "./metadata/metadataRepository";
import { createMetadataService } from "./metadata/metadataService";
import { createMetadataRoutes } from "./metadata/metadataRoutes";
import { createArtworkRoutes } from "./metadata/artworkRoutes";
import { createTmdbClient } from "./metadata/tmdbClient";
import { createUserStateRepository } from "./progress/userStateRepository";
import { createProgressRoutes } from "./progress/progressRoutes";
import { createPlaybackSessionStore } from "./playback/playbackSessionStore";
import {
  PLAYBACK_RENDITION_ROUTE_BASE,
  createPlaybackRoutes,
} from "./playback/playbackRoutes";
import { createRenditionService } from "../renditionService";
import {
  createLibraryRepository,
  parseLibraryDefinitions,
} from "./libraries/libraryRepository";
import { createJobQueue } from "./tasks/jobQueue";
import { createWorker } from "./tasks/worker";
import { createJobHandlers } from "./tasks/jobHandlers";
import { createTaskRoutes } from "./tasks/taskRoutes";
import { createProcessingJobStore } from "./processing/jobStore";
import { createProcessingRoutes } from "./processing/processingRoutes";
import { createProcessingJobRunner } from "./processing/jobRunner";
import { pruneLiveProgress } from "./processing/liveProgress";
import {
  resolveTitleRoot,
  titleRootLayoutForKind,
} from "../../renditions/adaptive/titleRoot";
import { createStorageWatchdog } from "../../renditions/processing/storageWatchdog";
import { createStorageIncidentStore } from "./processing/storageIncidentStore";
import {
  createStorageGuard,
  shouldRereadIncident,
} from "./processing/storageGuard";
import { createDiskutilIdentityProbe } from "../../renditions/processing/storageIdentity";
import { runBoundedProcess } from "../../renditions/processExecution";
import { jobRecordsStorageFault } from "./processing/recoveryPolicy";
import {
  AUTOMATIC_REQUEUE_PAUSE_REASON,
  OPERATOR_HELD_PAUSE_REASONS,
  reconcileInterruptedJobs,
} from "./processing/interruptedJobs";
import {
  checkpointCountersFor,
  describeCheckpointRecovery,
  readCheckpointRecovery,
} from "./processing/checkpointTruth";
import type { RenditionPaths } from "../../renditions/analysis";
import {
  prepareProcessingStorageRoles,
  sweepAbandonedWorkspaces,
} from "../../renditions/storageRoles";
import { createProbeService } from "./probe/probeService";
import { createTrickplayService } from "./trickplay/trickplayService";
import { createTrickplayRoutes } from "./trickplay/trickplayRoutes";
import { createUserRoutes } from "./users/userRoutes";
import { createSyncplayRepository } from "./syncplay/syncplayRepository";
import { createSyncplayRoutes } from "./syncplay/syncplayRoutes";
import { createSyncplayEventBus } from "./syncplay/eventBus";
import {
  createNodeOrganizerFileSystem,
  createNodeScannerFileSystem,
} from "./scanner/nodeFileSystem";
import { parseNfoConfig, writesFiles } from "./nfo/nfoConfig";
import { parseOrganizeMode } from "./scanner/organizeConfig";
import { createQueuedWorkRetargeter } from "./processing/retargetQueuedWork";
import { createNfoRepository } from "./nfo/nfoRepository";
import { createNfoWriter } from "./nfo/nfoWriter";
import { createNfoService } from "./nfo/nfoService";
import { createNfoJobHandlers } from "./nfo/nfoJobs";
import { createNfoRoutes } from "./nfo/nfoRoutes";
import { createSystemRoutes } from "./system/systemRoutes";
import type { RestartController } from "../restartController";
import type { PlaybackSessionManager } from "../../lib/playback-planner/playbackSessionManager";

type Environment = Record<string, string | undefined>;

export interface NativeRuntime {
  routeHandler: OwnApiRouteHandler;
  resolveRouteTemplate(pathname: string): string | undefined;
  databaseCheck(): Promise<"available" | "unavailable">;
  jobsCheck(): Promise<"available" | "unavailable">;
  close(): Promise<void>;
}

export interface CreateNativeRuntimeOptions {
  environment?: Environment;
  publicOrigin?: string;
  /** Explicitly allowed browser origins; trusted for mutations as well as CORS. */
  trustedOrigins?: ReadonlySet<string>;
  mediaRoot: string;
  sessionManager: PlaybackSessionManager;
  ffmpegPath?: string;
  ffprobePath?: string;
  softwareTranscodeThreads?: number;
  /** Where cached artwork is written; defaults to the generated-storage volume. */
  generatedStoragePath: string;
  /** Set false in tests and in a dedicated worker process. */
  runWorker?: boolean;
  /**
   * Exposes the administrator restart endpoints.
   *
   * Owned by whoever owns the process, not by the runtime: the runtime can
   * close its own resources but has no business deciding that the process
   * should end. Absent in the worker and in tests, where the routes simply do
   * not exist.
   */
  restartController?: RestartController;
}

const EXPIRED_SESSION_CLEANUP_INTERVAL_MS = 15 * 60_000;
const PLAYBACK_SESSION_IDLE_MS = 5 * 60_000;

/**
 * Builds the complete native API: identity, catalogue, playback, and background
 * work, all backed by one PostgreSQL pool.
 *
 * There is no adapter to another server and no fallback path. If the database or the
 * migrations are not in the expected state the process refuses to start rather
 * than serving a partially-native surface.
 */
export async function createNativeRuntime({
  environment = process.env,
  publicOrigin,
  trustedOrigins,
  mediaRoot,
  sessionManager,
  ffmpegPath,
  ffprobePath,
  softwareTranscodeThreads,
  generatedStoragePath,
  runWorker = true,
  restartController,
}: CreateNativeRuntimeOptions): Promise<NativeRuntime> {
  const databaseConfig = parseDatabaseConfig(environment);
  const authConfig = parseNativeAuthConfig(environment);
  // Parsed before the pool opens so an invalid export policy stops the process
  // at the point the mistake was made, not on the first title it writes.
  const nfoConfig = parseNfoConfig(environment);
  // Same reason: a scan that may move files is not something to discover from
  // a typo halfway through the first library it reads.
  const organizeMode = parseOrganizeMode(environment);

  const pool: DatabasePool = createDatabasePool(databaseConfig);
  try {
    await validateDatabaseConnection(pool);
    await validateNativeIdentitySchema(pool);
    await validateMigrationsCurrent(pool);
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw new Error(
      error instanceof Error && error.message.includes("migrations")
        ? "The database schema is not current. Run `npm run db:migrate`."
        : "The database is unavailable.",
    );
  }

  const users = createUserRepository(pool);
  const sessions = createSessionRepository(pool);
  const auth = await createNativeAuthService({
    users,
    sessions,
    passwords: createArgon2PasswordHasher(),
    sessionHashSecret: authConfig.sessionHashSecret,
  });

  const libraries = createLibraryRepository(pool);
  const definitions = parseLibraryDefinitions(environment.SEYIRLIK_LIBRARIES);
  if (definitions.length > 0) {
    await libraries.provision(definitions);
  }

  const catalogue = createCatalogueRepository(pool);
  const scanStore = createCatalogueScanStore(pool);
  const queuedWorkRetargeter = createQueuedWorkRetargeter(pool);
  const home = createHomeRepository(pool);
  const images = createImageRepository(pool);
  const userState = createUserStateRepository(pool);
  const playbackSessions = createPlaybackSessionStore(pool);
  const queue = createJobQueue(pool);

  const imageStorage = createImageStorage({
    imageRoot: path.join(generatedStoragePath, "images"),
    mediaRoot,
  });
  const artworkMigration = await migrateTitleArtwork(pool, imageStorage);
  if (artworkMigration.failed > 0) {
    console.warn(
      `Could not migrate ${artworkMigration.failed} title artwork file(s); legacy storage remains active for them.`,
    );
  }
  const metadataRepository = createMetadataRepository(pool);

  // Metadata is optional: without a provider key the catalogue still scans,
  // probes and plays, it just shows the titles taken from disk.
  const tmdbApiKey = environment.SEYIRLIK_TMDB_API_KEY?.trim();
  const tmdb = tmdbApiKey
    ? createTmdbClient({ apiKey: tmdbApiKey })
    : undefined;
  const metadataService = tmdb
    ? createMetadataService({
        metadata: metadataRepository,
        images,
        imageStorage,
        tmdb,
      })
    : undefined;

  const catalogueService = createCatalogueService({
    catalogue,
    home,
    images,
    userState,
  });

  const syncplay = createSyncplayRepository(pool);
  const syncplayEvents = createSyncplayEventBus();

  /**
   * Pre-encoded renditions produced by the offline CLI.
   *
   * The media id is the media file's own id: the registry is keyed by path and
   * the serving route re-checks library visibility, so nothing here needs a
   * second opaque identifier to hand around.
   */
  const renditionRoot =
    environment.SEYIRLIK_RENDITION_ROOT?.trim() ||
    path.join(mediaRoot, ".seyirlik", "renditions");
  const renditionStateRoot =
    environment.SEYIRLIK_RENDITION_STATE_ROOT?.trim() ||
    path.join(mediaRoot, ".seyirlik", "state");
  const renditionWorkRoot =
    environment.SEYIRLIK_RENDITION_WORK_ROOT?.trim() ||
    path.join(mediaRoot, ".seyirlik", "work");
  const storageRoles = await prepareProcessingStorageRoles({
    mediaRoot,
    ...(environment.SEYIRLIK_PROCESSING_SCRATCH_ROOT?.trim()
      ? { scratchRoot: environment.SEYIRLIK_PROCESSING_SCRATCH_ROOT.trim() }
      : {}),
    legacyWorkRoot: renditionWorkRoot,
    legacyLogsRoot:
      environment.SEYIRLIK_RENDITION_LOGS_ROOT?.trim() ||
      path.join(mediaRoot, ".seyirlik", "logs"),
    allowUnavailable: !runWorker,
  });
  const processingJobs = createProcessingJobStore(pool);

  /**
   * Where a package is built before it is published, and where its FFmpeg log
   * is kept. Separate from the published root on purpose: staging is disposable
   * and is never served, so a partial package cannot be reached by a player.
   */
  const renditionPaths: RenditionPaths = {
    mediaRoot,
    renditionRoot,
    stateRoot: renditionStateRoot,
    workRoot: storageRoles.jobsRoot,
    logsRoot: storageRoles.logsRoot,
  };

  // Repair the operator-facing record before routes or the worker become
  // visible. The generic queue may have exhausted an interrupted job's lease
  // retries while the previous server process was disappearing.
  await processingJobs.reconcileTerminalQueueJobs();

  /**
   * An unplugged drive must not be discovered one failed job at a time.
   *
   * Without this the queue marches through every remaining title against a
   * volume that is not there, failing each in turn, and what an operator finds
   * afterwards is an empty queue full of failures that had nothing wrong with
   * them. Pausing instead keeps every job alive and resumable.
   */
  const storageIncidents = createStorageIncidentStore(pool);

  /*
   * Availability and health are different questions and used to be the same
   * one. The watchdog answers the first — is the root there, listable, still
   * the same device — which is everything a clean unplug needs and nothing a
   * failing drive shows. A USB bridge returning `EIO` from the block layer
   * leaves directory metadata answering instantly, so the watchdog said
   * "available" throughout the incident that took the machine down twice.
   *
   * The guard answers the second, from a row that a reboot cannot clear.
   */
  /**
   * How this deployment asks what a volume actually is.
   *
   * One probe, shared by the storage guard — which decides whether a
   * quarantined drive has really come back — and by the job runner, which
   * decides whether the disk at the configured scratch path is the one a
   * resuming job claimed. Both questions are "which volume is this", and
   * answering them two different ways is how a path comes to be mistaken for
   * an identity.
   *
   * Only on Darwin. Elsewhere there is no identity, which is handled
   * explicitly everywhere it matters: identity-dependent decisions fail closed
   * and an operator clears them with the recorded override.
   */
  const volumeIdentityProbe =
    process.platform === "darwin"
      ? createDiskutilIdentityProbe({
          run: async (command, args, timeoutMs) =>
            (
              await runBoundedProcess({
                command,
                args,
                timeoutMs,
                describe: "the volume identity probe",
              })
            ).stdout,
        })
      : undefined;

  const storageGuard = createStorageGuard({
    root: mediaRoot,
    // Assigned below: the watchdog needs the guard's callbacks and the guard
    // needs the watchdog's poll, and neither is worth a class to break.
    watchdog: {
      poll: () => storageWatchdog.poll(),
      get missingRoots() {
        return storageWatchdog.missingRoots;
      },
    },
    incidents: storageIncidents,
    /*
     * Only on Darwin. Elsewhere the guard has no identity, which is handled
     * explicitly everywhere it matters: identity-dependent decisions fail
     * closed and an operator clears them with the recorded override.
     */
    ...(volumeIdentityProbe ? { identityProbe: volumeIdentityProbe } : {}),
    logger: {
      transition: (event, detail) =>
        console.warn(`[Seyirlik] ${event}: ${detail}`),
    },
  });

  /**
   * Puts jobs back to work after their storage returns.
   *
   * Lifting the pause flag used to be the whole of this, which worked while a
   * suspended encoder was still sitting there waiting for SIGCONT. It is not
   * enough now that losing the volume ends the encoder outright: there is no
   * process left to resume, so the job has to be queued again. It comes back
   * as a fresh attempt, which is also what makes recovery rendition-level —
   * the planner looks at what is actually published, finds the interrupted
   * rendition missing, and rebuilds only that one.
   *
   * The guard is consulted first, and refusing here is the single most
   * important line in this file. This function is reachable from a watchdog
   * poll, from a server restart and from a host reboot, and on the day of the
   * incident all three would have called it against a quarantined drive.
   */
  const requeueStorageInterruptedJobs = async (): Promise<number> => {
    if (!storageGuard.mayStartWork()) return 0;
    let recovered = 0;
    /*
     * The automatic path reads exactly one reason, and that is the whole of its
     * safety.
     *
     * `storage-unavailable` means a volume went away cleanly and is expected to
     * come back; it is the only pause a poll may undo. `recovery-pending` and
     * `storage-quarantined` are held for a person and are deliberately *not*
     * visible here, so that no watchdog tick, no restart and no remount can
     * sweep them up — even if the guard's gate above were ever weakened or
     * bypassed. Releasing those is `releaseOperatorHeldJobs`, below, which only
     * runs after an operator has verified and resumed.
     *
     * An earlier version of this function read all three and leaned entirely on
     * the `mayStartWork` gate. That was safe but it was one mistake deep: a
     * single wrong edit to the gate would have made a quarantine automatically
     * resumable. Two independent mechanisms now have to fail, not one.
     */
    const held = await processingJobs.listPaused(
      AUTOMATIC_REQUEUE_PAUSE_REASON,
    );
    for (const job of held) {
      /*
       * Re-checked inside the loop. Requeueing is not instantaneous — it
       * probes the source and writes several rows per job — and a volume that
       * fails on the first title must not have the rest of the queue thrown at
       * it while the failure is still being recorded.
       */
      if (!storageGuard.mayStartWork()) break;
      /*
       * A job whose own last attempt met an I/O error is not restarted by the
       * volume coming back. It is the one job in the queue guaranteed to read
       * the bytes that failed.
       */
      /*
       * A job whose own attempt met an I/O error is held even here. The
       * operator resumed the *storage*; they have not said that this
       * particular source, which is the one that actually failed to read, is
       * repaired. Retrying it is a deliberate, separate press on the job.
       */
      if (jobRecordsStorageFault(job)) {
        await processingJobs.requestPause(job.id, "storage-quarantined");
        continue;
      }
      try {
        const file = await catalogue.getFileById(job.mediaFileId);
        if (!file) continue;
        const sourcePath = path.resolve(
          mediaRoot,
          ...file.relativePath.split("/"),
        );
        /*
         * The real modification time, not a placeholder.
         *
         * This value is written straight into the rendition registry, and the
         * quality manifest refuses to describe a title whose registered mtime
         * disagrees with the file. A zero here therefore does not merely look
         * untidy: it silently withdraws every rendition from the player, which
         * falls back to direct play and offers the source as the only quality.
         */
        const sourceStats = await stat(sourcePath);
        /*
         * What actually survived, read from the checkpoint store before
         * anything claims anything. The message this replaces asserted
         * "continues from the last durable checkpoint" unconditionally, one
         * statement after `beginAttempt` had reset the epoch counters to zero —
         * so the history said two hours were protected while the row it sat
         * beside said none, and nothing had opened a manifest to decide.
         */
        const recovery = await readCheckpointRecovery({
          paths: renditionPaths,
          workspaceId: job.id,
          relativePath: file.relativePath,
          sourceFingerprint: job.sourceFingerprint,
          sizeBytes: Number(file.sizeBytes),
          mtimeMs: sourceStats.mtimeMs,
        });

        /*
         * Cleared under the reason the job actually carries. Passing a fixed
         * `storage-unavailable` here silently did nothing for a job parked as
         * `recovery-pending`, which then went round the loop being requeued
         * while still flagged paused.
         */
        await processingJobs.resume(job.id, job.pausedReason ?? undefined);
        const record = await processingJobs.beginAttempt(job.id, {});
        if (!record) continue;
        /*
         * Written back after the reset, and only from manifests that were
         * actually read. `beginAttempt` is right to zero the epoch position —
         * those figures belonged to an attempt that ended — but the next
         * attempt does inherit whatever is genuinely on disk, and the page
         * should say so rather than showing zero until the encoder reports.
         */
        if (recovery.completedEpochs.length > 0) {
          await processingJobs.update(job.id, checkpointCountersFor(recovery));
        }
        /*
         * Where this title publishes, decided by the catalogue exactly as it
         * is when a job is first queued. Leaving it off made the destination
         * of a job depend on how it happened to be started: the first attempt
         * published into the episode's own folder and an automatic requeue
         * published into the season's, over its neighbours.
         */
        const kind = (await catalogue.getItemKind(job.itemId)) ?? "movie";
        const titleRoot = await resolveTitleRoot(
          sourcePath,
          titleRootLayoutForKind(kind),
        );
        const queueJobId = await queue.enqueue({
          jobType: "media.process",
          payload: {
            processingJobId: job.id,
            sourcePath,
            relativePath: file.relativePath,
            sizeBytes: Number(file.sizeBytes),
            mtimeMs: sourceStats.mtimeMs,
            titleRoot,
          },
          /*
           * The back of the line, exactly where a fresh queue row's timestamp
           * used to put it. A recovered job re-enters the queue; it does not
           * take the head of one an operator has arranged.
           */
          priority: await processingJobs.nextQueuePriority(),
          dedupeKey: `processing:${job.mediaFileId}:storage-recovery:${Date.now()}`,
        });
        await processingJobs.attachQueueJob(job.id, queueJobId);
        await processingJobs.appendEvent({
          processingJobId: job.id,
          stage: "waiting",
          level: "info",
          message: `Storage is available again. ${describeCheckpointRecovery(recovery)}`,
          detail: {
            completedEpochs: recovery.completedEpochs.length,
            protectedSeconds: recovery.protectedSeconds,
          },
        });
        recovered += 1;
      } catch (error) {
        console.warn(
          `[seyirlik] could not requeue ${job.id} after storage returned:`,
          error,
        );
      }
    }
    return recovered;
  };

  /*
   * Recovering interrupted work belongs to whoever runs the encoders.
   *
   * The watchdog itself runs everywhere, because the processing pages ask this
   * runtime whether the storage is there and a server that serves playback
   * still has to answer. What is gated is the acting on it: with the worker
   * split into its own process, two runtimes see the volume return, and two
   * runtimes requeueing the same job would build the same rendition twice.
   */
  const storageWatchdog = createStorageWatchdog({
    mediaRoot,
    /*
     * A job reads its source from one root and writes staging and published
     * output to others, which may be different volumes. Losing any of them
     * stops the work just as completely, so all are watched.
     */
    additionalRoots: [
      renditionRoot,
      storageRoles.scratchRoot,
      storageRoles.jobsRoot,
      renditionStateRoot,
    ],
    onLost: async () => {
      /*
       * The guard is told everywhere, worker or not, because the processing
       * page is served by the API process and has to be able to say why
       * nothing is running. Only the acting on it is gated below.
       */
      const active = await processingJobs.listActive().catch(() => []);
      if (active.length > 0) {
        /*
         * Missing at idle is a clean unmount. Missing while an encoder or
         * probe has the source open is device loss during a read, which is
         * hard evidence and must survive the first occurrence and every
         * restart. The watchdog transition is the only place that knows both
         * facts at once.
         */
        await storageGuard.reportFailure({
          kind: "storage-device-lost",
          detail: `${storageWatchdog.missingRoots.join(", ") || "The storage"} disappeared while processing was active.`,
          processingJobId: active[0]?.id,
        });
      } else {
        await storageGuard.observeAvailability(false);
      }
      if (!runWorker) return;
      for (const job of active) {
        await processingJobs.requestPause(
          job.id,
          storageGuard.health.state === "quarantined"
            ? "storage-quarantined"
            : "storage-unavailable",
        );
      }
    },
    onRestored: async () => {
      await storageGuard.observeAvailability(true);
      if (!runWorker) return;
      /*
       * Only the jobs the watchdog itself paused: a job an operator paused by
       * hand stays paused, because the drive returning does not answer why a
       * person stopped it. And only when the guard agrees — a quarantined
       * volume coming back is a quarantined volume, and the poll that noticed
       * it is exactly the poll a failing drive passes between retry storms.
       */
      if (storageGuard.resumesAutomatically() || storageGuard.mayStartWork()) {
        await requeueStorageInterruptedJobs();
      }
    },
  });
  /*
   * The persisted incident is read before the first poll, so a process that
   * starts against a quarantined volume knows it before anything can ask
   * whether work may begin. Failing to read it must not stop the server: the
   * guard then reports healthy, which is the pre-existing behaviour, and the
   * runner's own failure classification still catches the first I/O error.
   */
  await storageGuard.reload().catch((error) => {
    console.warn(
      "[Seyirlik] Could not read the storage incident record:",
      error instanceof Error ? error.message : String(error),
    );
  });
  storageWatchdog.start();

  /*
   * Nothing can still be encoding at the moment this process starts, so a job
   * the database calls `running` is the residue of a server that died or a
   * volume that vanished. The record was never reconciled — `findInterrupted`
   * existed but nothing called it — so such a job stayed `running` for ever
   * and its rendition lock was never released.
   *
   * What used to happen next was the defect. `storageWatchdog.poll()` was
   * asked whether the storage was ready, and a `true` requeued the job on the
   * spot. On the day of the incident that poll returned `true` — the mount was
   * still there and its metadata still cached — for a drive whose block layer
   * was returning `EIO`, and the encode that followed took the machine down a
   * second time.
   *
   * So the decision is made from three separate facts now: what the guard
   * remembers about the volume, what the job's own record says about how its
   * last attempt ended, and whether anybody observed the interruption at all.
   * "The path is listable" is not among them.
   */
  /**
   * Releases the jobs a person was holding, after that person let go.
   *
   * Separate from the automatic requeue on purpose, and reachable only from the
   * transition to healthy that an operator's `resume` produces. Keeping the two
   * apart is what lets the automatic query stay narrow: nothing that polls can
   * reach these rows at all, so a quarantine cannot be lifted by a remount even
   * if every other guard in the process were wrong.
   */
  const releaseOperatorHeldJobs = async (): Promise<number> => {
    if (!storageGuard.mayStartWork()) return 0;
    let released = 0;
    for (const reason of OPERATOR_HELD_PAUSE_REASONS) {
      for (const job of await processingJobs.listPaused(reason)) {
        /*
         * The operator resumed the *storage*. They have not said that this
         * particular source — the one that actually failed to read — is
         * repaired, so a job carrying its own I/O fault stays put and needs a
         * deliberate retry on the job itself.
         */
        if (jobRecordsStorageFault(job)) continue;
        /*
         * Moved onto the automatic reason rather than requeued here, so that
         * exactly one piece of code knows how to put a job back on the queue.
         * The requeue call below then picks it up with the truthful checkpoint
         * reading and the queue row it needs.
         */
        await processingJobs.requestPause(
          job.id,
          AUTOMATIC_REQUEUE_PAUSE_REASON,
        );
        released += 1;
      }
    }
    if (released > 0) await requeueStorageInterruptedJobs();
    return released;
  };

  /**
   * Noticing, from the other process, that the hold changed.
   *
   * The incident row is the truth and each process serves decisions from a
   * cached copy of it, so each one has to re-read the row in the state where
   * its copy can be wrong in the direction that does harm. The two are mirror
   * images, because raising a hold and lifting one happen in different
   * processes: only the worker raises (the `!runWorker` returns in the
   * watchdog above), and only the API server lifts, on the two recovery
   * presses.
   *
   * So the worker polls *while it is held*, to notice a lift; and the server
   * polls *while it believes work may start*, to notice a hold. Neither polls
   * in both states, and a single-process deployment covers both by being both.
   *
   * Without the worker's half the recovery button appeared to work — the
   * storage went healthy, the panel cleared — while every held job stayed
   * dormant until the worker happened to be restarted.
   *
   * Without the server's half the failure is quieter and worse. The server
   * came up healthy, the worker raised a hold afterwards, and nothing ever
   * told the server: it went on believing the volume was fine for as long as
   * it stayed up. Resuming a job was then accepted by the API and refused by
   * the worker a second later, so the job flicked to running and fell back to
   * paused with no error to show for it; and `/processing/storage/resume`,
   * which lifts the hold, refused with "verify the storage first" because the
   * guard it asked had never heard of the incident. The operator could see the
   * incident in the panel — that list is read from the database — and had no
   * press that could clear it.
   */
  const releaseTimer = setInterval(() => {
    if (
      !shouldRereadIncident({
        runWorker,
        mayStartWork: storageGuard.mayStartWork(),
      })
    ) {
      return;
    }
    void (async () => {
      const before = storageGuard.health.state;
      await storageGuard.reload();
      if (
        runWorker &&
        before !== storageGuard.health.state &&
        storageGuard.mayStartWork()
      ) {
        /*
         * The operator's resume landed in the other process. Held jobs are
         * released here, which is the only path that touches them, and only
         * the worker owns the encoders it would be starting.
         */
        await releaseOperatorHeldJobs();
      }
    })().catch((error) => {
      console.warn(
        "[Seyirlik] Could not re-read the storage incident:",
        error instanceof Error ? error.message : String(error),
      );
    });
  }, 5_000);
  releaseTimer?.unref?.();

  /**
   * Releases scratch that no job can still be waiting on.
   *
   * Only the worker sweeps, and only at startup, because this is the one
   * moment when nothing is running and the set of jobs that could still claim
   * a workspace is knowable. A workspace whose job is pending, queued, running
   * or paused is left exactly where it is however old it looks: a job parked
   * for a drive that has been unplugged for a month owns the most valuable
   * directory on the volume, and it is precisely the one an age-based sweep
   * would take.
   */
  const sweepAbandonedScratch = async (): Promise<void> => {
    const live = new Set<string>();
    for (const state of ["pending", "queued", "running", "paused"] as const) {
      for (const job of await processingJobs.list({ state, limit: 10_000 })) {
        live.add(job.id);
      }
    }
    const sweep = await sweepAbandonedWorkspaces({
      jobsRoot: storageRoles.jobsRoot,
      stillClaimed: (workspaceId) => live.has(workspaceId),
    });
    if (sweep.removed.length > 0) {
      console.info(
        `[Seyirlik] Released ${sweep.removed.length} abandoned scratch workspace(s).`,
      );
    }
  };

  // Same ownership rule: the process that will run the work is the one that
  // decides what to do with work the last run left behind.
  if (runWorker) {
    await sweepAbandonedScratch().catch((error) => {
      // Never fatal: scratch that is not released is wasted space, while a
      // worker that will not start is a library that does not process at all.
      console.warn(
        "[Seyirlik] Could not sweep abandoned scratch workspaces:",
        error instanceof Error ? error.message : String(error),
      );
    });
    await reconcileInterruptedJobs({
      store: processingJobs,
      guard: storageGuard,
      mediaRoot,
      storageAvailable: () => storageWatchdog.poll(),
      requeue: requeueStorageInterruptedJobs,
    });
  }

  /*
   * A worker killed mid-encode leaves its last live sample behind. A page that
   * found it would animate a bar from a frozen speed as though the encode were
   * still going, so anything belonging to a job that is not active goes.
   */
  void pruneLiveProgress(
    (await processingJobs.listActive()).map((job) => job.id),
  ).catch(() => undefined);

  const renditions = createRenditionService({
    mediaRoot,
    renditionRoot,
    stateRoot: renditionStateRoot,
    mediaResolver: {
      resolveMedia: () => {
        throw new Error("The native playback routes resolve media themselves.");
      },
      encodeMediaToken: (mediaId) => mediaId,
      decodeMediaToken: (token) => token,
    },
    basePath: PLAYBACK_RENDITION_ROUTE_BASE,
  });

  const trickplay = createTrickplayService({
    pool,
    catalogue,
    mediaRoot,
    generatedStoragePath,
  });

  const probeService = createProbeService({
    pool,
    mediaRoot,
    ...(ffprobePath ? { ffprobePath } : {}),
  });

  /**
   * Kodi/Jellyfin sidecar export.
   *
   * Always constructed so preview and manual repair endpoints remain available.
   * The scan handler receives it only for modes that actually write files.
   */
  const nfoService = createNfoService({
    repository: createNfoRepository(pool),
    writer: createNfoWriter({
      mode: nfoConfig.mode,
      overwritePolicy: nfoConfig.overwritePolicy,
      mediaRoot,
      generatedStoragePath,
    }),
    config: nfoConfig,
  });

  const worker = createWorker({
    queue,
    handlers: {
      ...createJobHandlers({
        libraries,
        processingRunner: createProcessingJobRunner({
          store: processingJobs,
          paths: renditionPaths,
          mediaRoot,
          // Polls rather than reading the cached flag: an encode can fail
          // within the same second the volume goes, before the watchdog's
          // next tick.
          storageAvailableFn: () => storageWatchdog.poll(),
          // Which volume, so the failure reads "Expansion became unavailable"
          // rather than leaving an operator to work out which drive is missing.
          missingRootsFn: () => storageWatchdog.missingRoots,
          /*
           * The runner refuses to start against a guarded volume and reports
           * every classified failure back into it. Both directions matter: the
           * first is what stops a queued backlog being thrown at a failing
           * drive one title at a time, and the second is what turns the first
           * `EIO` into a fact that outlives the process that saw it.
           */
          storageGuard,
          /*
           * The same probe the guard uses. A job that claimed its workspace on
           * a particular volume is held to that volume on every later attempt,
           * which is what makes recovery safe after a restart that happened
           * while the disk was absent.
           */
          ...(volumeIdentityProbe
            ? { scratchIdentityProbe: volumeIdentityProbe }
            : {}),
          ...(ffmpegPath ? { ffmpegPath } : {}),
          ...(ffprobePath ? { ffprobePath } : {}),
          ...(softwareTranscodeThreads === undefined
            ? {}
            : { softwareThreads: softwareTranscodeThreads }),
        }),
        scanStore,
        fileSystem: createNodeScannerFileSystem(mediaRoot),
        organizer: {
          mode: organizeMode,
          fileSystem: createNodeOrganizerFileSystem(mediaRoot),
          recordMoves: async (moves) => {
            const rows = await scanStore.recordMoves(moves);
            // Belt and braces: the pass already stands down while anything is
            // queued, so this normally finds nothing to do.
            await queuedWorkRetargeter.retarget(moves);
            return rows;
          },
        },
        probeService,
        queue,
        ...(metadataService ? { metadataService } : {}),
        trickplayService: trickplay,
        ...(writesFiles(nfoConfig.mode) ? { nfoService } : {}),
      }),
      ...createNfoJobHandlers(nfoService),
    },
    logger: console,
  });
  if (runWorker) worker.start();

  /**
   * Bridges the cookie session to the router's principal. Resolving it here,
   * once per request, keeps every route free of cookie handling and guarantees
   * a disabled user or revoked session is rejected uniformly.
   */
  const resolveSession = async (
    request: IncomingMessage,
  ): Promise<RoutePrincipal | null> => {
    const token = uniqueCookie(
      parseCookies(request),
      authConfig.sessionCookieName,
    );
    if (!token) return null;

    try {
      const session = await auth.getCurrentSession(token);
      return {
        userId: session.user.id,
        username: session.user.username,
        displayName: session.user.displayName,
        isAdministrator: session.user.isAdministrator,
        sessionId: session.sessionId,
        sessionTokenHash: session.tokenHash,
      };
    } catch {
      return null;
    }
  };

  const routes: RouteDefinition[] = [
    ...createCatalogueRoutes({ service: catalogueService, catalogue }),
    ...createProgressRoutes({ userState, catalogue }),
    ...createPlaybackRoutes({
      catalogue,
      sessions: playbackSessions,
      sessionManager,
      mediaRoot,
      ...(ffmpegPath ? { ffmpegPath } : {}),
      renditions,
    }),
    ...createImageRoutes({ images, imageStorage, catalogue }),
    ...createBookRoutes({ catalogue, mediaRoot }),
    ...createTrickplayRoutes({ trickplay, catalogue, queue }),
    ...createSyncplayRoutes({ syncplay, catalogue, events: syncplayEvents }),
    ...createUserRoutes({
      users,
      sessions,
      passwords: createArgon2PasswordHasher(),
    }),
    ...createTaskRoutes({
      queue,
      libraries,
      processingJobs,
      /*
       * The catalogue's own naming fields, passed on unjoined. Composing the
       * line here would put a page's presentation inside the runtime, and the
       * task endpoint is the one place that knows how a card names a title.
       */
      resolveMediaLabel: async (userId, itemId) => {
        const item = await catalogue.getItem(userId, itemId);
        return item
          ? {
              kind: item.kind,
              title: item.title,
              seriesTitle: item.seriesTitle ?? null,
              seasonNumber: item.parentIndexNumber ?? null,
              episodeNumber: item.indexNumber ?? null,
            }
          : null;
      },
    }),
    ...createNfoRoutes({ service: nfoService, queue }),
    ...(restartController
      ? createSystemRoutes({ restart: restartController })
      : []),
    ...createProcessingRoutes({
      catalogue,
      storageAvailable: () => storageWatchdog.available,
      storageGuard,
      storageIncidents,
      store: processingJobs,
      queue,
      mediaRoot,
      renditionRoot,
      ...(ffmpegPath ? { ffmpegPath } : {}),
    }),
    ...(tmdb
      ? [
          ...createMetadataRoutes({
            metadata: metadataRepository,
            tmdb,
            queue,
          }),
          ...createArtworkRoutes({
            metadata: metadataRepository,
            images,
            imageStorage,
            tmdb,
            queue,
          }),
        ]
      : []),
  ];

  const router = createOwnApiRouter({
    routes,
    resolveSession,
    csrfSecret: authConfig.csrfSecret,
    csrfCookieName: authConfig.csrfCookieName,
    ...(publicOrigin ? { publicOrigin } : {}),
    ...(trustedOrigins ? { trustedOrigins } : {}),
  });

  const authHandler = createNativeAuthHttpHandler({
    auth,
    csrfSecret: authConfig.csrfSecret,
    secureCookies: authConfig.secureCookies,
    sessionCookieName: authConfig.sessionCookieName,
    csrfCookieName: authConfig.csrfCookieName,
    ...(authConfig.cookieDomain
      ? { cookieDomain: authConfig.cookieDomain }
      : {}),
    ...(publicOrigin ? { publicOrigin } : {}),
    ...(trustedOrigins ? { trustedOrigins } : {}),
  });

  const sessionCleanupTimer = setInterval(() => {
    void auth.cleanupExpiredSessions().catch(() => undefined);
  }, EXPIRED_SESSION_CLEANUP_INTERVAL_MS);
  sessionCleanupTimer.unref();

  const playbackCleanupTimer = setInterval(() => {
    void playbackSessions
      .expireIdle(PLAYBACK_SESSION_IDLE_MS)
      .then(async (runtimeKeys) => {
        // Stopping the FFmpeg process is what actually frees the machine; the
        // row is only the record of it.
        for (const key of runtimeKeys) {
          await sessionManager.stopSession(key).catch(() => undefined);
        }
      })
      .catch(() => undefined);
  }, 60_000);
  playbackCleanupTimer.unref();

  const syncplayCleanupTimer = setInterval(() => {
    void syncplay
      .closeEmptyGroups()
      .then((closedIds) => {
        for (const groupId of closedIds) {
          syncplayEvents.publish({ type: "closed", groupId, data: {} });
        }
      })
      .catch(() => undefined);
  }, 60_000);
  syncplayCleanupTimer.unref();

  let closed = false;

  return {
    routeHandler: async (request, response, context) =>
      (await authHandler(request, response, context)) ||
      (await router.handler(request, response, context)),

    resolveRouteTemplate: router.resolveTemplate,

    databaseCheck: () => checkDatabaseReadiness(pool),

    jobsCheck: async () => {
      try {
        await pool.query("SELECT 1 FROM jobs LIMIT 1");
        return "available";
      } catch {
        return "unavailable";
      }
    },

    close: async () => {
      if (closed) return;
      closed = true;
      clearInterval(sessionCleanupTimer);
      clearInterval(playbackCleanupTimer);
      clearInterval(syncplayCleanupTimer);
      storageWatchdog.stop();
      if (releaseTimer) clearInterval(releaseTimer);
      await worker.stop();
      await pool.end();
    },
  };
}
