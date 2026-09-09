// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createAcquisitionRoutes } from "./acquisitionRoutes";
import { ACQUISITION_JOB_TYPES } from "./acquisitionJobs";
import { SabError } from "./sabnzbd";
import type { SabnzbdClient } from "./sabnzbd";
import type {
  AcquisitionRepository,
  AcquisitionSummary,
  CreateAcquisitionInput,
} from "./acquisitionRepository";
import type { AcquisitionService } from "./acquisitionService";
import type { IndexerRegistry } from "../indexers/indexerRegistry";
import type { JobQueue } from "../tasks/jobQueue";
import type { RouteContext, RouteDefinition } from "../api/router";
import { OwnApiError } from "../ownApiHandler";

const SECRET = "0123456789abcdef0123456789abcdef";
const DOWNLOAD_URL = `https://api.invalid/api?t=get&id=1&apikey=${SECRET}`;

function summary(over: Partial<AcquisitionSummary> = {}): AcquisitionSummary {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    state: "queued",
    indexerId: "nzbgeek",
    releaseGuid: DOWNLOAD_URL,
    releaseTitle: "Big.Buck.Bunny.2008.1080p.WEB-DL",
    idempotencyKey: "seyirlik-11111111-1111-4111-8111-111111111111",
    externalId: "SABnzbd_nzo_secret",
    attempt: 1,
    targetTitle: "Big Buck Bunny",
    targetKind: "movie",
    origin: "manual",
    createdAtMs: 1_700_000_000_000,
    updatedAtMs: 1_700_000_001_000,
    ...over,
  };
}

interface Harness {
  routes: RouteDefinition[];
  created: CreateAcquisitionInput[];
  enqueued: Array<Record<string, unknown>>;
  service: AcquisitionService;
  updates: Array<{ id: string; from: string; patch: Record<string, unknown> }>;
}

function harness(
  records: AcquisitionSummary[] = [summary()],
  over: {
    service?: Partial<AcquisitionService>;
    sab?: Partial<SabnzbdClient>;
    indexerIds?: string[];
  } = {},
): Harness {
  const created: CreateAcquisitionInput[] = [];
  const enqueued: Array<Record<string, unknown>> = [];
  const updates: Harness["updates"] = [];

  const repository = {
    create: async (input: CreateAcquisitionInput) => {
      created.push(input);
      return summary({ state: "planned" });
    },
    get: async (id: string) => records.find((r) => r.id === id) ?? null,
    list: async () => records,
    listReadyForImport: async () =>
      records.filter((r) => r.state === "downloaded"),
    detail: async (id: string) => {
      const found = records.find((r) => r.id === id);
      return found
        ? {
            acquisition: found,
            decision: {
              profileName: "HD-1080p",
              score: 120,
              reasons: [{ code: "codec", detail: "Preferred codec" }],
              rejected: [
                { title: "Other.720p", reason: "quality-not-allowed" },
              ],
              decidedAtMs: 1_700_000_000_000,
            },
            events: [
              {
                fromState: null,
                toState: "planned",
                detail: "Chosen by manual decision.",
                atMs: 1_700_000_000_000,
              },
              {
                fromState: "submitting",
                toState: "queued",
                atMs: 1_700_000_001_000,
              },
            ],
          }
        : null;
    },
    update: async (
      id: string,
      from: string,
      patch: Record<string, unknown>,
    ) => {
      updates.push({ id, from, patch });
      return true;
    },
  } as unknown as AcquisitionRepository;

  const service: AcquisitionService = {
    submit: vi.fn(async () => undefined),
    reconcile: vi.fn(async () => ({ examined: 0, changed: 0 })),
    cancel: vi.fn(async () => undefined),
    ...over.service,
  };

  const ids = over.indexerIds ?? ["nzbgeek"];
  const indexers = {
    get: (id: string) => (ids.includes(id) ? ({ id } as never) : undefined),
  } as unknown as IndexerRegistry;

  const queue = {
    enqueue: vi.fn(async (options: Record<string, unknown>) => {
      enqueued.push(options);
      return "job-1";
    }),
  } as unknown as JobQueue;

  const sab = {
    version: vi.fn(async () => "4.3.3"),
    ...over.sab,
  } as unknown as SabnzbdClient;

  return {
    routes: createAcquisitionRoutes({
      repository,
      service,
      indexers,
      queue,
      sab,
    }),
    created,
    enqueued,
    service,
    updates,
  };
}

function route(h: Harness, method: string, path: string): RouteDefinition {
  const found = h.routes.find((r) => r.method === method && r.path === path);
  if (!found) throw new Error(`No route for ${method} ${path}`);
  return found;
}

interface Captured {
  status: number;
  payload: { data?: Record<string, unknown> } | undefined;
}

function invoke(
  definition: RouteDefinition,
  options: {
    body?: unknown;
    params?: Record<string, string>;
    query?: string;
  } = {},
): Promise<Captured> {
  const captured: Captured = { status: 0, payload: undefined };
  const context = {
    request: { once: () => undefined, off: () => undefined },
    response: {
      setHeader: () => undefined,
      end: (chunk?: string) => {
        captured.payload = chunk ? JSON.parse(chunk) : undefined;
      },
      get headersSent() {
        return false;
      },
      // The envelope assigns `statusCode` rather than calling `writeHead`.
      set statusCode(status: number) {
        captured.status = status;
      },
      get statusCode() {
        return captured.status;
      },
    },
    requestId: "req",
    url: new URL(
      `http://localhost/ownAPI/v1/acquisitions${options.query ?? ""}`,
    ),
    params: options.params ?? {},
    method: definition.method,
    principal: { userId: "u", isAdministrator: true },
    requirePrincipal: () => ({ userId: "u", isAdministrator: true }),
    readJson: async () => options.body,
  } as unknown as RouteContext;
  return definition.handle(context).then(() => captured);
}

const VALID_BODY = {
  kind: "movie",
  title: "Big Buck Bunny",
  year: 2008,
  indexerId: "nzbgeek",
  releaseGuid: "abc123",
  releaseTitle: "Big.Buck.Bunny.2008.1080p.WEB-DL",
};

describe("every acquisition endpoint is administrative", () => {
  it("exposes nothing to an ordinary viewer", () => {
    // Acquisition is operations, not playback. A viewer has no business here.
    for (const definition of harness().routes) {
      expect(definition.access).toBe("admin");
    }
  });
});

describe("what the wire shape carries", () => {
  it("never carries the credential-bearing download URL", async () => {
    /*
     * The guid is the provider's release identifier, and for some indexers
     * that is a details URL. Whatever it is, it is not client-facing: the URL
     * that fetches an NZB carries the API key.
     */
    const { payload } = await invoke(harness().routes[0]!);
    expect(JSON.stringify(payload)).not.toContain(SECRET);
    expect(JSON.stringify(payload)).not.toContain("apikey");
  });

  it("never carries SABnzbd's job identifier", async () => {
    // A client that cannot name an nzo id cannot quote one back at cancel.
    const { payload } = await invoke(harness().routes[0]!);
    expect(JSON.stringify(payload)).not.toContain("SABnzbd_nzo_secret");
  });

  it("lists acquisitions with their state and progress facts", async () => {
    const { status, payload } = await invoke(
      harness([summary({ state: "downloading", sizeBytes: 1024 })]).routes[0]!,
    );
    expect(status).toBe(200);
    expect(payload?.data?.acquisitions).toEqual([
      expect.objectContaining({
        state: "downloading",
        sizeBytes: 1024,
        target: { kind: "movie", title: "Big Buck Bunny" },
        releaseTitle: "Big.Buck.Bunny.2008.1080p.WEB-DL",
        createdAt: "2023-11-14T22:13:20.000Z",
      }),
    ]);
  });

  it("returns the audit trail with the detail", async () => {
    const h = harness();
    const { payload } = await invoke(
      route(h, "GET", "/acquisitions/:acquisitionId"),
      {
        params: { acquisitionId: summary().id },
      },
    );
    expect(payload?.data?.events).toEqual([
      expect.objectContaining({ toState: "planned" }),
      expect.objectContaining({ fromState: "submitting", toState: "queued" }),
    ]);
  });

  it("explains why this release was chosen", async () => {
    /*
     * The evidence was recorded from Phase 4 onward and never read, so an
     * operator could see that a download happened and not why it was this
     * release. Score alone would not answer it either — the reasons are the
     * answer, and the rejections are the other half of it.
     */
    const h = harness();
    const { payload } = await invoke(
      route(h, "GET", "/acquisitions/:acquisitionId"),
      { params: { acquisitionId: summary().id } },
    );
    expect(payload?.data?.decision).toMatchObject({
      profileName: "HD-1080p",
      score: 120,
      reasons: [{ code: "codec", detail: "Preferred codec" }],
      rejected: [{ title: "Other.720p", reason: "quality-not-allowed" }],
    });
  });

  it("never carries the download path in a list or a history", async () => {
    /*
     * It names a directory on the operator's disk. The import phase reads it
     * from the repository on the server, so carrying it here disclosed a
     * filesystem layout to nobody's benefit.
     */
    const h = harness([
      summary({ state: "downloaded", downloadPath: "C:/Downloads/Dune" }),
    ]);
    const listed = await invoke(h.routes[0]!);
    expect(JSON.stringify(listed.payload)).not.toContain("C:/Downloads");

    const detail = await invoke(
      route(h, "GET", "/acquisitions/:acquisitionId"),
      { params: { acquisitionId: summary().id } },
    );
    expect(JSON.stringify(detail.payload)).not.toContain("C:/Downloads");
  });

  it("publishes the path only where handing it over is the point", async () => {
    const h = harness([
      summary({ state: "downloaded", downloadPath: "C:/Downloads/Dune" }),
    ]);
    const { payload } = await invoke(
      route(h, "GET", "/acquisitions/ready-for-import"),
    );
    const ready = payload?.data?.ready as Array<Record<string, unknown>>;
    expect(ready[0]?.downloadPath).toBe("C:/Downloads/Dune");
  });

  it("answers 404 for an acquisition that does not exist", async () => {
    const h = harness([]);
    await expect(
      invoke(route(h, "GET", "/acquisitions/:acquisitionId"), {
        params: { acquisitionId: summary().id },
      }),
    ).rejects.toBeInstanceOf(OwnApiError);
  });

  it("refuses an identifier that is not one", async () => {
    const h = harness();
    await expect(
      invoke(route(h, "GET", "/acquisitions/:acquisitionId"), {
        params: { acquisitionId: "../../etc/passwd" },
      }),
    ).rejects.toThrow();
  });
});

describe("asking for an acquisition", () => {
  it("records the decision and queues the work", async () => {
    const h = harness();
    const { status, payload } = await invoke(
      route(h, "POST", "/acquisitions"),
      { body: VALID_BODY },
    );
    expect(status).toBe(202);
    expect(h.created[0]).toMatchObject({
      indexerId: "nzbgeek",
      releaseGuid: "abc123",
      origin: "manual",
      target: { kind: "movie", title: "Big Buck Bunny", year: 2008 },
    });
    expect(h.enqueued[0]).toMatchObject({
      jobType: ACQUISITION_JOB_TYPES.submit,
    });
    expect(payload?.data?.taskId).toBe("job-1");
  });

  it("does not submit inside the request", async () => {
    // The durable queue owns the work, so a restart mid-request loses nothing.
    const h = harness();
    await invoke(route(h, "POST", "/acquisitions"), { body: VALID_BODY });
    expect(h.service.submit).not.toHaveBeenCalled();
  });

  it("collapses a double-clicked button onto one submission", async () => {
    const h = harness();
    await invoke(route(h, "POST", "/acquisitions"), { body: VALID_BODY });
    expect(h.enqueued[0]!.dedupeKey).toBe(`acquisition.submit:${summary().id}`);
  });

  it("takes an indexer it knows, never a URL to fetch from", async () => {
    /*
     * The reason the body names an indexer id: an endpoint that accepted a URL
     * would fetch whatever a client asked for, from the server's network, with
     * the server's credentials.
     */
    const h = harness();
    await expect(
      invoke(route(h, "POST", "/acquisitions"), {
        body: { ...VALID_BODY, indexerId: "somewhere-else" },
      }),
    ).rejects.toThrow(/not configured/);
    expect(h.created).toHaveLength(0);
  });

  it.each([
    ["no title", { ...VALID_BODY, title: "   " }],
    ["no indexer", { ...VALID_BODY, indexerId: undefined }],
    ["no release", { ...VALID_BODY, releaseGuid: undefined }],
    ["an unknown kind", { ...VALID_BODY, kind: "boxset" }],
    ["an unknown field", { ...VALID_BODY, downloadUrl: DOWNLOAD_URL }],
    ["a season with no number", { ...VALID_BODY, kind: "season" }],
  ])("refuses a request with %s", async (_name, body) => {
    const h = harness();
    await expect(
      invoke(route(h, "POST", "/acquisitions"), { body }),
    ).rejects.toThrow();
    expect(h.created).toHaveLength(0);
  });

  it("accepts a television acquisition that names its season", async () => {
    const h = harness();
    const { status } = await invoke(route(h, "POST", "/acquisitions"), {
      body: { ...VALID_BODY, kind: "season", season: 2 },
    });
    expect(status).toBe(202);
    expect(h.created[0]!.target).toMatchObject({ kind: "season", season: 2 });
  });
});

describe("cancelling", () => {
  it("cancels through the service, which owns what may be removed", async () => {
    const h = harness();
    const { status } = await invoke(
      route(h, "POST", "/acquisitions/:acquisitionId/cancel"),
      { params: { acquisitionId: summary().id } },
    );
    expect(status).toBe(204);
    expect(h.service.cancel).toHaveBeenCalledWith(summary().id);
  });

  it("reports a refusal to cancel as a conflict, not a server fault", async () => {
    const h = harness([summary({ state: "downloaded" })], {
      service: {
        cancel: vi.fn(async () => {
          throw new Error("A finished download cannot be cancelled.");
        }),
      },
    });
    await expect(
      invoke(route(h, "POST", "/acquisitions/:acquisitionId/cancel"), {
        params: { acquisitionId: summary().id },
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("does not reach the client for an acquisition it has never heard of", async () => {
    const h = harness([]);
    await expect(
      invoke(route(h, "POST", "/acquisitions/:acquisitionId/cancel"), {
        params: { acquisitionId: summary().id },
      }),
    ).rejects.toBeInstanceOf(OwnApiError);
    expect(h.service.cancel).not.toHaveBeenCalled();
  });
});

describe("retrying by hand", () => {
  it("moves a failed acquisition back into the queue", async () => {
    const h = harness([summary({ state: "failed" })]);
    const { status, payload } = await invoke(
      route(h, "POST", "/acquisitions/:acquisitionId/retry"),
      { params: { acquisitionId: summary().id } },
    );
    expect(status).toBe(202);
    expect(payload?.data).toMatchObject({ taskId: "job-1", status: "queued" });
    expect(h.updates[0]).toMatchObject({
      from: "failed",
      patch: { state: "awaiting_retry", retryAfterMs: null },
    });
    expect(h.enqueued[0]).toMatchObject({
      jobType: ACQUISITION_JOB_TYPES.submit,
    });
  });

  it("clears the retry delay, because a person asked for it now", async () => {
    const h = harness([summary({ state: "failed" })]);
    await invoke(route(h, "POST", "/acquisitions/:acquisitionId/retry"), {
      params: { acquisitionId: summary().id },
    });
    expect(h.updates[0]!.patch.retryAfterMs).toBeNull();
  });

  it.each(["queued", "downloading", "downloaded", "cancelled"] as const)(
    "refuses to retry an acquisition that is %s",
    async (state) => {
      const h = harness([summary({ state })]);
      await expect(
        invoke(route(h, "POST", "/acquisitions/:acquisitionId/retry"), {
          params: { acquisitionId: summary().id },
        }),
      ).rejects.toMatchObject({ statusCode: 409 });
      expect(h.enqueued).toHaveLength(0);
    },
  );
});

describe("the handoff to import", () => {
  it("lists only what has finished downloading", async () => {
    const h = harness([
      summary({ state: "downloading" }),
      summary({
        id: "22222222-2222-4222-8222-222222222222",
        state: "downloaded",
        downloadPath: "C:/SeyirlikDownloads/complete/seyirlik/Big Buck Bunny",
      }),
    ]);
    const { payload } = await invoke(
      route(h, "GET", "/acquisitions/ready-for-import"),
    );
    const ready = payload?.data?.ready as Array<Record<string, unknown>>;
    expect(ready).toHaveLength(1);
    expect(ready[0]).toMatchObject({
      state: "downloaded",
      downloadPath: "C:/SeyirlikDownloads/complete/seyirlik/Big Buck Bunny",
    });
  });
});

describe("whether the download client is reachable", () => {
  it("reports the version when it answers", async () => {
    const h = harness();
    const { status, payload } = await invoke(
      route(h, "GET", "/acquisitions/client/status"),
    );
    expect(status).toBe(200);
    expect(payload?.data).toEqual({ reachable: true, version: "4.3.3" });
  });

  it("reports an unreachable client as a fact, not as a failed request", async () => {
    /*
     * A media server whose downloader is down still serves everything it has.
     * Answering 5xx here would make an operational detail look like an outage.
     */
    const h = harness([], {
      sab: {
        version: vi.fn(async () => {
          throw new SabError("unavailable", "connect ECONNREFUSED");
        }),
      },
    });
    const { status, payload } = await invoke(
      route(h, "GET", "/acquisitions/client/status"),
    );
    expect(status).toBe(200);
    expect(payload?.data).toMatchObject({
      reachable: false,
      reason: "unavailable",
    });
  });

  it("names an authentication failure as one", async () => {
    const h = harness([], {
      sab: {
        version: vi.fn(async () => {
          throw new SabError("auth", "API Key Incorrect");
        }),
      },
    });
    const { payload } = await invoke(
      route(h, "GET", "/acquisitions/client/status"),
    );
    expect(payload?.data).toMatchObject({ reachable: false, reason: "auth" });
  });
});
