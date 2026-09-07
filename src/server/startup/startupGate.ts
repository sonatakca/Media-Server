/**
 * One place that decides whether an ordinary request may run yet.
 *
 * Binding the port before the dependencies are up is the point of this work,
 * and it creates a window that did not exist before: the listener answers while
 * the catalogue repository, the auth service and the job store do not yet
 * exist. Scattering `if (!ready)` through the route modules would put that
 * window in fifty places and leave the fifty-first as a `TypeError` on
 * `undefined`.
 *
 * So the runtime is reached through here or not at all. Before it is installed
 * every `/ownAPI/v1` route except `/health` answers 503 with the startup
 * snapshot, and `/health` answers 200 with `alive: true, ready: false` — which
 * is the distinction the whole design turns on, and the one a caller could not
 * previously draw, because a server that had not bound its port gave
 * `ECONNREFUSED` for both "starting" and "not running at all".
 */

import {
  OWN_API_V1_BASE_PATH,
  buildOwnApiHealthStatus,
  sendOwnApiJson,
  type OwnApiHealthChecks,
  type OwnApiHealthService,
  type OwnApiRouteHandler,
} from "../ownApi/ownApiHandler";
import {
  toPublicStartupSnapshot,
  type StartupPhaseSnapshot,
  type StartupSnapshot,
} from "./startupState";

/** Suggested to a polling client. Short: startup states change in seconds. */
const RETRY_AFTER_SECONDS = 5;

export interface InstalledRuntime {
  routeHandler: OwnApiRouteHandler;
  resolveRouteTemplate(pathname: string): string | undefined;
  healthService: OwnApiHealthService;
}

export interface StartupGate {
  /** Refuses ordinary routes while startup is incomplete. Registered first. */
  gateHandler: OwnApiRouteHandler;
  /** Reaches the runtime once there is one. Registered after the gate. */
  runtimeHandler: OwnApiRouteHandler;
  healthService: OwnApiHealthService;
  resolveRouteTemplate(pathname: string): string | undefined;
  install(runtime: InstalledRuntime): void;
  readonly installed: boolean;
}

function phaseIsReady(
  phases: readonly StartupPhaseSnapshot[],
  id: string,
): boolean {
  return phases.find((phase) => phase.id === id)?.state === "ready";
}

/**
 * What startup alone can say about the dependencies.
 *
 * Coarser than the runtime health service, which actually probes. This reports
 * only what the startup sequence has already established, and never guesses a
 * dependency is available because nothing has contradicted it yet — ffmpeg is
 * `unavailable` here because it has genuinely not been looked for.
 */
export function startupHealthChecks(
  snapshot: StartupSnapshot,
): OwnApiHealthChecks {
  const phases = snapshot.phases;
  return {
    database: phaseIsReady(phases, "database") ? "available" : "unavailable",
    jobs: phaseIsReady(phases, "processing") ? "available" : "unavailable",
    ffmpeg: "unavailable",
    ffprobe: "unavailable",
    mediaStorage: phaseIsReady(phases, "media-storage")
      ? "available"
      : "unavailable",
    generatedStorage: phaseIsReady(phases, "generated-storage")
      ? "writable"
      : "unavailable",
  };
}

function refusalCode(snapshot: StartupSnapshot): string {
  switch (snapshot.state) {
    case "failed":
      return "SERVER_STARTUP_FAILED";
    case "stopping":
      return "SERVER_STOPPING";
    default:
      return "SERVER_STARTING";
  }
}

function refusalMessage(snapshot: StartupSnapshot): string {
  switch (snapshot.state) {
    case "failed":
      return "Seyirlik could not finish starting up.";
    case "stopping":
      return "Seyirlik is shutting down.";
    case "degraded":
      return "Seyirlik is running but a dependency it needs has not answered yet.";
    default:
      return "Seyirlik is still starting up.";
  }
}

export function createStartupGate({
  snapshot,
}: {
  snapshot: () => StartupSnapshot;
}): StartupGate {
  let runtime: InstalledRuntime | undefined;

  return {
    gateHandler: async (_request, response, context) => {
      /*
       * Health is answered above this handler and is listed again here on
       * purpose: the one route whose whole job is to describe an unready server
       * must not be refused by the check for an unready server, whatever the
       * route order becomes later.
       */
      if (context.url.pathname === `${OWN_API_V1_BASE_PATH}/health`) {
        return false;
      }

      const current = snapshot();
      if (runtime && current.ready) return false;

      // Before the body: `sendOwnApiJson` ends the response.
      response.setHeader("Retry-After", String(RETRY_AFTER_SECONDS));
      sendOwnApiJson(response, 503, {
        error: {
          code: refusalCode(current),
          message: refusalMessage(current),
          requestId: context.requestId,
        },
        startup: toPublicStartupSnapshot(current),
      });
      return true;
    },

    runtimeHandler: async (request, response, context) =>
      runtime ? runtime.routeHandler(request, response, context) : false,

    healthService: {
      getStatus: async () => {
        const current = snapshot();
        const base = runtime
          ? await runtime.healthService.getStatus()
          : buildOwnApiHealthStatus(startupHealthChecks(current));

        /*
         * The startup snapshot is folded in rather than replacing the checks,
         * so an existing consumer reading `alive`, `ready` and `checks` sees
         * exactly the shape it always saw, and a new one can additionally tell
         * "still starting" from "started, and a dependency is missing".
         */
        return buildOwnApiHealthStatus(
          base.checks,
          toPublicStartupSnapshot(current),
        );
      },
    },

    resolveRouteTemplate: (pathname) => runtime?.resolveRouteTemplate(pathname),

    install(next) {
      runtime = next;
    },

    get installed() {
      return runtime !== undefined;
    },
  };
}
