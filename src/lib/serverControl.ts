import { ownApiClient } from "../api/ownApi/client";

/**
 * Asking the server to restart, and knowing when it is back.
 *
 * The awkward part is not the request, it is the waiting. The server answers
 * the restart before it stops, so for a moment afterwards it is still healthy —
 * reloading then would reload against a process that is about to disappear and
 * land the operator on a broken page. So the wait has two halves: watch it go,
 * then watch it come back.
 */

export type ServerRestartMode = "disabled" | "respawn" | "supervisor";

export interface ServerRestartStatus {
  mode: ServerRestartMode;
  available: boolean;
  inProgress: boolean;
}

export interface ServerRestartAcknowledgement {
  status: "restarting";
  mode: ServerRestartMode;
}

const MODES: ServerRestartMode[] = ["disabled", "respawn", "supervisor"];

function asMode(value: unknown): ServerRestartMode {
  return MODES.find((mode) => mode === value) ?? "disabled";
}

export async function getServerRestartStatus(options?: {
  signal?: AbortSignal;
}): Promise<ServerRestartStatus> {
  const data = await ownApiClient.request<{
    mode?: unknown;
    available?: unknown;
    inProgress?: unknown;
  }>("/admin/system/restart", {
    ...(options?.signal ? { signal: options.signal } : {}),
  });

  return {
    mode: asMode(data?.mode),
    available: data?.available === true,
    inProgress: data?.inProgress === true,
  };
}

export async function requestServerRestart(): Promise<ServerRestartAcknowledgement> {
  const data = await ownApiClient.request<{ mode?: unknown }>(
    "/admin/system/restart",
    { method: "POST", csrf: true },
  );

  return { status: "restarting", mode: asMode(data?.mode) };
}

/** What the wait is doing, so the page can say so rather than just spin. */
export type ServerRestartPhase = "stopping" | "starting" | "ready" | "timeout";

export interface WaitForServerRestartOptions {
  onPhase?(phase: ServerRestartPhase): void;
  /** Overridable for tests; defaults to the health endpoint. */
  probe?(): Promise<boolean>;
  delay?(ms: number): Promise<void>;
  now?(): number;
  pollIntervalMs?: number;
  /** How long to wait for the old process to stop answering. */
  shutdownTimeoutMs?: number;
  /** How long to wait for the replacement to become ready. */
  startupTimeoutMs?: number;
}

const DEFAULT_POLL_INTERVAL_MS = 700;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 15_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 90_000;

async function probeHealth(): Promise<boolean> {
  const health = await ownApiClient.getHealth();
  return health.ready;
}

/**
 * Any failure means "not serving".
 *
 * Connection refused, a 502 from a proxy still pointing at a dead upstream, a
 * malformed body from a half-started process — every one of them is the server
 * not being there, which is exactly what the wait needs to know. Catching here
 * rather than inside the probe means a caller-supplied probe gets the same
 * treatment and cannot break the wait by throwing.
 */
async function isServing(probe: () => Promise<boolean>): Promise<boolean> {
  try {
    return await probe();
  } catch {
    return false;
  }
}

/**
 * Waits for the server to go away and come back.
 *
 * The shutdown phase has a timeout of its own rather than being required: a
 * restart fast enough to complete between two polls never looks down from here,
 * and treating that as a failure would be wrong. When the shutdown window
 * passes with the server still healthy, the wait moves on and reports ready.
 */
export async function waitForServerRestart({
  onPhase,
  probe = probeHealth,
  delay = (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    }),
  now = () => Date.now(),
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  shutdownTimeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
  startupTimeoutMs = DEFAULT_STARTUP_TIMEOUT_MS,
}: WaitForServerRestartOptions = {}): Promise<"ready" | "timeout"> {
  onPhase?.("stopping");

  const shutdownDeadline = now() + shutdownTimeoutMs;
  let observedShutdown = false;

  while (now() < shutdownDeadline) {
    await delay(pollIntervalMs);
    if (!(await isServing(probe))) {
      observedShutdown = true;
      break;
    }
  }

  if (!observedShutdown) {
    // It never stopped answering. Either the restart was quicker than the poll
    // interval or it did not happen; either way the server is up and reloading
    // is safe, which is the only thing the caller is waiting to be told.
    onPhase?.("ready");
    return "ready";
  }

  onPhase?.("starting");
  const startupDeadline = now() + startupTimeoutMs;

  while (now() < startupDeadline) {
    await delay(pollIntervalMs);
    if (await isServing(probe)) {
      onPhase?.("ready");
      return "ready";
    }
  }

  onPhase?.("timeout");
  return "timeout";
}
