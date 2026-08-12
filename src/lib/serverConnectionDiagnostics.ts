import { type ServerUnavailableEventDetail } from "./mediaApi";

/**
 * Works out why the app cannot reach its own server.
 *
 * Seyirlik serves its API from the page's origin, so there is nothing to
 * configure and nothing to choose: the only question is which layer between
 * the browser and the server is failing. `/ownAPI/v1/health` answers that in
 * one request, because it reports liveness, readiness, and the state of each
 * dependency the server needs.
 *
 * Nothing here reports a filesystem path, a connection string, or any other
 * server detail. The health endpoint deliberately returns coarse states, and
 * this module passes those through without enriching them.
 */

const HEALTH_ENDPOINT = "/ownAPI/v1/health";
const DIAGNOSTIC_TIMEOUT_MS = 3500;

/** Mirrors the health payload, minus anything the UI has no use for. */
export type DependencyState =
  | "available"
  | "unavailable"
  | "writable"
  | "disabled"
  | "unknown";

export interface HealthChecks {
  database: DependencyState;
  jobs: DependencyState;
  ffmpeg: DependencyState;
  ffprobe: DependencyState;
  mediaStorage: DependencyState;
  generatedStorage: DependencyState;
}

export type HealthProbeKind =
  /** The server answered with a health payload we understood. */
  | "healthy"
  /** Answered, but the body was not the health payload — usually a proxy. */
  | "malformed-response"
  /** A gateway answered on the server's behalf: 502, 503, 504. */
  | "gateway-error"
  /** Some other HTTP failure. */
  | "http-error"
  /** Nothing answered: DNS, TLS, connection refused, timeout, offline. */
  | "network-error";

export interface HealthProbe {
  endpoint: string;
  kind: HealthProbeKind;
  /** True when the server answered at all, even with an error. */
  reachable: boolean;
  alive: boolean;
  ready: boolean;
  status?: number;
  statusText?: string;
  message?: string;
  checks?: HealthChecks;
  /** Correlates this failure with the server's own logs, when it sent one. */
  requestId?: string;
}

export type ServerConnectionProblem =
  | "none"
  /** Nothing answered at this origin. */
  | "unreachable"
  /** A proxy answered but could not reach the server behind it. */
  | "proxy-error"
  /** The server answered but reports it is not alive. */
  | "not-alive"
  /** Alive, but a dependency it needs is missing. */
  | "dependency-unavailable"
  /** Alive and dependencies fine, but still finishing startup work. */
  | "starting-up"
  /** Something answered, but it was not the API. */
  | "unexpected-response"
  | "unknown";

export interface ServerConnectionDiagnosis {
  problem: ServerConnectionProblem;
  checkedAt: string;
  probe: HealthProbe;
  /** Dependency names that are not in a usable state, for display. */
  failedDependencies: Array<keyof HealthChecks>;
}

interface DiagnoseServerConnectionOptions {
  failure?: ServerUnavailableEventDetail | null;
  fetchImpl?: typeof fetch;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toDependencyState(value: unknown): DependencyState {
  return value === "available" ||
    value === "unavailable" ||
    value === "writable" ||
    value === "disabled"
    ? value
    : "unknown";
}

function toHealthChecks(value: unknown): HealthChecks | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const checks = value as Record<string, unknown>;

  return {
    database: toDependencyState(checks.database),
    jobs: toDependencyState(checks.jobs),
    ffmpeg: toDependencyState(checks.ffmpeg),
    ffprobe: toDependencyState(checks.ffprobe),
    mediaStorage: toDependencyState(checks.mediaStorage),
    generatedStorage: toDependencyState(checks.generatedStorage),
  };
}

/** A dependency is a problem only when it is actually missing. */
function isDependencyUsable(state: DependencyState): boolean {
  return state === "available" || state === "writable" || state === "disabled";
}

export function getFailedDependencies(
  checks: HealthChecks | undefined,
): Array<keyof HealthChecks> {
  if (!checks) return [];

  return (Object.keys(checks) as Array<keyof HealthChecks>).filter(
    (name) => !isDependencyUsable(checks[name]),
  );
}

function createAbortController(timeoutMs: number): {
  controller: AbortController;
  cancel: () => void;
} {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  return { controller, cancel: () => clearTimeout(timeoutId) };
}

function readRequestId(response: Response): string | undefined {
  return response.headers.get("x-request-id") ?? undefined;
}

async function probeHealth(fetchImpl: typeof fetch): Promise<HealthProbe> {
  const endpoint = HEALTH_ENDPOINT;
  const { controller, cancel } = createAbortController(DIAGNOSTIC_TIMEOUT_MS);

  try {
    const response = await fetchImpl(endpoint, {
      cache: "no-store",
      credentials: "include",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    const requestId = readRequestId(response);
    const bodyText = await response.text().catch(() => "");

    if (!response.ok) {
      // A gateway status means something in front of the server answered for
      // it, which is a different fix from the server itself being broken.
      const isGateway = [502, 503, 504].includes(response.status);

      return {
        endpoint,
        kind: isGateway ? "gateway-error" : "http-error",
        reachable: true,
        alive: false,
        ready: false,
        status: response.status,
        statusText: response.statusText,
        ...(requestId ? { requestId } : {}),
      };
    }

    let payload: unknown;
    try {
      payload = JSON.parse(bodyText);
    } catch {
      return {
        endpoint,
        kind: "malformed-response",
        reachable: true,
        alive: false,
        ready: false,
        status: response.status,
        statusText: response.statusText,
        ...(requestId ? { requestId } : {}),
      };
    }

    const body = payload as {
      alive?: unknown;
      ready?: unknown;
      checks?: unknown;
    };

    if (typeof body.alive !== "boolean") {
      // Answered 200 with JSON that is not the health payload. A captive
      // portal or a misrouted proxy looks exactly like this.
      return {
        endpoint,
        kind: "malformed-response",
        reachable: true,
        alive: false,
        ready: false,
        status: response.status,
        ...(requestId ? { requestId } : {}),
      };
    }

    return {
      endpoint,
      kind: "healthy",
      reachable: true,
      alive: body.alive,
      ready: body.ready === true,
      status: response.status,
      ...(toHealthChecks(body.checks)
        ? { checks: toHealthChecks(body.checks) }
        : {}),
      ...(requestId ? { requestId } : {}),
    };
  } catch (error) {
    return {
      endpoint,
      kind: "network-error",
      reachable: false,
      alive: false,
      ready: false,
      message: getErrorMessage(error),
    };
  } finally {
    cancel();
  }
}

export function classifyServerConnection(
  probe: HealthProbe,
  failedDependencies: Array<keyof HealthChecks>,
): ServerConnectionProblem {
  switch (probe.kind) {
    case "network-error":
      return "unreachable";
    case "gateway-error":
      return "proxy-error";
    case "malformed-response":
      return "unexpected-response";
    case "http-error":
      return "unknown";
    case "healthy":
      break;
  }

  if (!probe.alive) return "not-alive";
  if (failedDependencies.length > 0) return "dependency-unavailable";
  // Readiness covers background work. The interface is usable without it, so
  // this only ever appears alongside a failure the caller already saw.
  if (!probe.ready) return "starting-up";

  return "none";
}

/**
 * Turns a failure the API client already observed into a probe, so a diagnosis
 * can explain a request that failed a moment ago without re-testing it.
 */
function probeFromFailure(
  failure: ServerUnavailableEventDetail | null | undefined,
): HealthProbe | null {
  if (!failure?.status) return null;

  const isGateway = [502, 503, 504].includes(failure.status);

  return {
    endpoint: failure.requestUrl ?? HEALTH_ENDPOINT,
    kind: isGateway ? "gateway-error" : "http-error",
    reachable: true,
    alive: false,
    ready: false,
    status: failure.status,
    ...(failure.statusText ? { statusText: failure.statusText } : {}),
  };
}

export async function diagnoseServerConnection({
  failure,
  fetchImpl,
}: DiagnoseServerConnectionOptions = {}): Promise<ServerConnectionDiagnosis> {
  const resolvedFetch =
    fetchImpl ?? (typeof fetch === "function" ? fetch : undefined);

  const probe = resolvedFetch
    ? await probeHealth(resolvedFetch)
    : ({
        endpoint: HEALTH_ENDPOINT,
        kind: "network-error",
        reachable: false,
        alive: false,
        ready: false,
        message: "No fetch implementation is available.",
      } satisfies HealthProbe);

  // A live health check is the better answer. The recorded failure only stands
  // in when health itself could not be reached.
  const effectiveProbe =
    probe.kind === "network-error"
      ? (probeFromFailure(failure) ?? probe)
      : probe;
  const failedDependencies = getFailedDependencies(effectiveProbe.checks);

  return {
    problem: classifyServerConnection(effectiveProbe, failedDependencies),
    checkedAt: new Date().toISOString(),
    probe: effectiveProbe,
    failedDependencies,
  };
}

export function probeIsOnline(probe: HealthProbe | null | undefined): boolean {
  return Boolean(probe && probe.kind === "healthy" && probe.alive);
}
