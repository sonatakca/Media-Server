/**
 * What the operations dashboard asks the server.
 *
 * Every subsystem is fetched independently and allowed to fail on its own. A
 * dashboard that threw when one of five requests failed would show nothing at
 * all in exactly the situation it exists for, so each answer is either the data
 * or an explicit absence, and the health model turns absence into `unknown`
 * rather than into silence.
 */
import { ownApiClient } from "../api/ownApi/client";
import type { HealthInput } from "./operationsHealth";

interface DownloadClientStatus {
  reachable: boolean;
  version?: string;
  reason?: string;
  detail?: string;
}

interface ImportSummary {
  id: string;
  state: string;
  target: { kind: string; title: string };
  failureClass?: string;
}

/** Anything the dashboard could not learn, kept as a reason rather than a gap. */
export interface OperationsSnapshot {
  readonly input: HealthInput;
  readonly downloadClientVersion?: string;
  readonly importsNeedingAttention: ImportSummary[];
  /** Subsystems whose request failed, by name, so the page can say so. */
  readonly unreachable: string[];
}

async function attempt<T>(
  name: string,
  request: () => Promise<T>,
  unreachable: string[],
): Promise<T | null> {
  try {
    return await request();
  } catch {
    // The reason is deliberately not surfaced: a fetch failure message can
    // carry a URL, and these are shown to a browser.
    unreachable.push(name);
    return null;
  }
}

export async function fetchOperationsSnapshot(): Promise<OperationsSnapshot> {
  const unreachable: string[] = [];

  const [health, client, imports] = await Promise.all([
    attempt("health", () => ownApiClient.getHealth(), unreachable),
    attempt(
      "downloadClient",
      () =>
        ownApiClient.request<DownloadClientStatus>(
          "/acquisitions/client/status",
        ),
      unreachable,
    ),
    attempt(
      "imports",
      () =>
        ownApiClient.request<{ imports: ImportSummary[] }>(
          "/imports/needs-attention",
        ),
      unreachable,
    ),
  ]);

  /*
   * A 404 from the acquisition status endpoint means no download client is
   * configured — the routes are not mounted at all in that case — which is a
   * different thing from a client that is configured and refusing. The two are
   * told apart by whether the request produced an answer.
   */
  const configured = client !== null;

  return {
    input: {
      health: health
        ? {
            alive: health.alive,
            ready: health.ready,
            checks: health.checks as unknown as Record<string, string>,
            ...(health.startup ? { startup: health.startup } : {}),
          }
        : null,
      downloadClient: {
        configured,
        reachable: client?.reachable === true,
        ...(client?.detail ? { reason: client.detail } : {}),
      },
      ...(imports ? { attention: { imports: imports.imports.length } } : {}),
    },
    ...(client?.version ? { downloadClientVersion: client.version } : {}),
    importsNeedingAttention: imports?.imports ?? [],
    unreachable,
  };
}
