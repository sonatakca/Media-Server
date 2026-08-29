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
import { createStorageWatchdog } from "../../renditions/processing/storageWatchdog";
import type { RenditionPaths } from "../../renditions/analysis";
import { createProbeService } from "./probe/probeService";
import { createTrickplayService } from "./trickplay/trickplayService";
import { createTrickplayRoutes } from "./trickplay/trickplayRoutes";
import { createUserRoutes } from "./users/userRoutes";
import { createSyncplayRepository } from "./syncplay/syncplayRepository";
import { createSyncplayRoutes } from "./syncplay/syncplayRoutes";
import { createSyncplayEventBus } from "./syncplay/eventBus";
import { createNodeScannerFileSystem } from "./scanner/nodeFileSystem";
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
  /** Where cached artwork is written; defaults to the generated-storage volume. */
  generatedStoragePath: string;
  /** Set false in tests and in a dedicated worker process. */
  runWorker?: boolean;
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
  generatedStoragePath,
  runWorker = true,
}: CreateNativeRuntimeOptions): Promise<NativeRuntime> {
  const databaseConfig = parseDatabaseConfig(environment);
  const authConfig = parseNativeAuthConfig(environment);

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
  const processingJobs = createProcessingJobStore(pool);

  /**
   * An unplugged drive must not be discovered one failed job at a time.
   *
   * Without this the queue marches through every remaining title against a
   * volume that is not there, failing each in turn, and what an operator finds
   * afterwards is an empty queue full of failures that had nothing wrong with
   * them. Pausing instead keeps every job alive and resumable.
   */
  const storageWatchdog = createStorageWatchdog({
    mediaRoot,
    onLost: async () => {
      for (const job of await processingJobs.listActive()) {
        await processingJobs.requestPause(job.id, "storage-unavailable");
      }
    },
    onRestored: async () => {
      // Only the jobs the watchdog itself paused: a job an operator paused by
      // hand stays paused, because the drive returning does not answer why a
      // person stopped it.
      for (const job of await processingJobs.listPaused(
        "storage-unavailable",
      )) {
        await processingJobs.resume(job.id, "storage-unavailable");
      }
    },
  });
  storageWatchdog.start();

  /**
   * Where a package is built before it is published, and where its FFmpeg log
   * is kept. Separate from the published root on purpose: staging is disposable
   * and is never served, so a partial package cannot be reached by a player.
   */
  const renditionPaths: RenditionPaths = {
    mediaRoot,
    renditionRoot,
    stateRoot: renditionStateRoot,
    workRoot:
      environment.SEYIRLIK_RENDITION_WORK_ROOT?.trim() ||
      path.join(mediaRoot, ".seyirlik", "work"),
    logsRoot:
      environment.SEYIRLIK_RENDITION_LOGS_ROOT?.trim() ||
      path.join(mediaRoot, ".seyirlik", "logs"),
  };
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

  const worker = createWorker({
    queue,
    handlers: createJobHandlers({
      libraries,
      processingRunner: createProcessingJobRunner({
        store: processingJobs,
        paths: renditionPaths,
        mediaRoot,
        ...(ffmpegPath ? { ffmpegPath } : {}),
        ...(ffprobePath ? { ffprobePath } : {}),
      }),
      scanStore,
      fileSystem: createNodeScannerFileSystem(mediaRoot),
      probeService,
      queue,
      ...(metadataService ? { metadataService } : {}),
      trickplayService: trickplay,
    }),
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
    ...createTaskRoutes({ queue, libraries }),
    ...createProcessingRoutes({
      catalogue,
      storageAvailable: () => storageWatchdog.available,
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
      await worker.stop();
      await pool.end();
    },
  };
}
