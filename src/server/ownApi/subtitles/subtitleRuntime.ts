import type { DatabasePool } from "../database/databasePool";
import type { PlaybackRefreshBoundary } from "../playback/playbackRefresh";
import type { SubtitleConfig } from "./subtitleConfig";
import { createSubtitleExecutionRepository } from "./subtitleExecution";
import { createSubtitleJobHandlers, SUBTITLE_JOB_TYPES } from "./subtitleJobs";
import type {
  ProviderSessionManager,
  SubtitleProvider,
} from "./subtitleProvider";
import { createSubtitleRepository } from "./subtitleRepository";
import { createSubtitleService } from "./subtitleService";

/**
 * What to answer when no interactive session host is wired in.
 *
 * A provider needing a browser session, on a server with nowhere to show one,
 * is not a failure and not an error — it is a request that cannot proceed until
 * somebody attends to it. Answering `needs-authentication` keeps the attempt in
 * the resumable state, so wiring a session host in later resumes the work
 * rather than requiring it to be started again.
 *
 * The alternative — throwing, or pretending a session exists — would turn every
 * such provider into a permanent failure on a headless deployment.
 */
export function unattendedSessionManager(): ProviderSessionManager {
  return {
    acquire: async (providerId) => ({
      outcome: "needs-authentication",
      providerId,
      reason: "Interactive authentication is not configured.",
      authenticateAt: null,
    }),
    invalidate: async () => {},
  };
}

export function disabledSubtitleJobTypes(
  config: SubtitleConfig | undefined,
): string[] {
  return config ? [] : Object.values(SUBTITLE_JOB_TYPES);
}

/** No configuration means no construction, database queries, handlers or I/O. */
export function createSubtitleRuntime(options: {
  config?: SubtitleConfig;
  pool: DatabasePool;
  providers?: readonly SubtitleProvider[];
  sessions?: ProviderSessionManager;
  playback?: PlaybackRefreshBoundary;
}) {
  if (!options.config) return undefined;
  const providers = options.providers ?? [];
  if (
    options.config.providerIds.some(
      (id) => !providers.some((provider) => provider.id === id),
    )
  )
    throw new Error("A configured subtitle provider is not registered.");
  const sessions: ProviderSessionManager =
    options.sessions ?? unattendedSessionManager();
  const repository = createSubtitleRepository(options.pool);
  const service = createSubtitleService({
    config: options.config,
    execution: createSubtitleExecutionRepository(options.pool),
    providers,
    sessions,
    playback: options.playback,
  });
  return {
    repository,
    service,
    handlers: createSubtitleJobHandlers(service, repository),
  };
}
