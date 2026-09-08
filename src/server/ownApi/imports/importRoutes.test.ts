// @vitest-environment node
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createImportRoutes,
  type ImportSourceResolution,
} from "./importRoutes";
import { IMPORT_JOB_TYPES } from "./importJobs";
import { createMemoryRepository } from "./importTestHarness";
import type { ImportService } from "./importService";
import type { JobQueue } from "../tasks/jobQueue";
import type { RouteContext, RouteDefinition } from "../api/router";
import { OwnApiError } from "../ownApiHandler";

const DOWNLOAD_ROOT = path.resolve("/downloads/seyirlik");
const LIBRARY_ROOT = path.resolve("/media/Movies");
const ACQUISITION = "11111111-1111-4111-8111-111111111111";

interface Harness {
  routes: RouteDefinition[];
  repository: ReturnType<typeof createMemoryRepository>;
  enqueued: Array<Record<string, unknown>>;
  service: ImportService;
}

function harness(
  resolution: ImportSourceResolution | null = {
    downloadPath: path.join(DOWNLOAD_ROOT, "Dune.2021.1080p"),
    target: { kind: "movie", title: "Dune", year: 2021 },
  },
  /** `null` means no library is configured; a default supplies one. */
  libraryRoot: string | null = LIBRARY_ROOT,
): Harness {
  const repository = createMemoryRepository();
  const enqueued: Array<Record<string, unknown>> = [];
  const service: ImportService = {
    plan: vi.fn(async () => ({ state: "staging", committed: 0, failed: 0 })),
    execute: vi.fn(async () => ({
      state: "committed",
      committed: 1,
      failed: 0,
    })),
    reconcile: vi.fn(async () => ({
      state: "committed",
      committed: 1,
      failed: 0,
    })),
    cleanup: vi.fn(async () => ({
      state: "complete",
      committed: 1,
      failed: 0,
    })),
  };
  const queue = {
    enqueue: vi.fn(async (options: Record<string, unknown>) => {
      enqueued.push(options);
      return "job-1";
    }),
  } as unknown as JobQueue;

  return {
    routes: createImportRoutes({
      repository,
      service,
      queue,
      downloadRoot: DOWNLOAD_ROOT,
      libraryRootFor: () => libraryRoot ?? undefined,
      resolveAcquisition: async () => resolution,
    }),
    repository,
    enqueued,
    service,
  };
}

function route(h: Harness, method: string, p: string): RouteDefinition {
  const found = h.routes.find((r) => r.method === method && r.path === p);
  if (!found) throw new Error(`No route for ${method} ${p}`);
  return found;
}

interface Captured {
  status: number;
  payload: { data?: Record<string, unknown> } | undefined;
}

function invoke(
  definition: RouteDefinition,
  options: { body?: unknown; params?: Record<string, string> } = {},
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
      set statusCode(status: number) {
        captured.status = status;
      },
      get statusCode() {
        return captured.status;
      },
    },
    requestId: "req",
    url: new URL("http://localhost/ownAPI/v1/imports"),
    params: options.params ?? {},
    method: definition.method,
    principal: { userId: "u", isAdministrator: true },
    requirePrincipal: () => ({ userId: "u", isAdministrator: true }),
    readJson: async () => options.body,
  } as unknown as RouteContext;
  return definition.handle(context).then(() => captured);
}

describe("every import endpoint is administrative", () => {
  it("exposes nothing to an ordinary viewer", () => {
    for (const definition of harness().routes) {
      expect(definition.access).toBe("admin");
    }
  });
});

describe("asking for an import", () => {
  it("takes an acquisition and works the paths out itself", async () => {
    const h = harness();
    const { status, payload } = await invoke(route(h, "POST", "/imports"), {
      body: { acquisitionId: ACQUISITION },
    });
    expect(status).toBe(202);
    expect(h.enqueued[0]).toMatchObject({ jobType: IMPORT_JOB_TYPES.run });

    const [record] = await h.repository.list();
    expect(record).toMatchObject({
      sourceRoot: DOWNLOAD_ROOT,
      libraryRoot: LIBRARY_ROOT,
      sourceRelative: "Dune.2021.1080p",
      targetTitle: "Dune",
    });
    expect(payload?.data?.taskId).toBe("job-1");
  });

  it("refuses a body that names a path", async () => {
    /*
     * The endpoint's whole safety argument is that both roots were authorised
     * before any work began. An endpoint that accepted `{ from, to }` would
     * hand that argument to whoever sent the request.
     */
    const h = harness();
    await expect(
      invoke(route(h, "POST", "/imports"), {
        body: { acquisitionId: ACQUISITION, sourceRoot: "C:\\Windows" },
      }),
    ).rejects.toThrow();
    await expect(
      invoke(route(h, "POST", "/imports"), {
        body: { acquisitionId: ACQUISITION, downloadPath: "/etc" },
      }),
    ).rejects.toThrow();
  });

  it("refuses a download the client's acquisition puts outside the root", async () => {
    // The path came from SABnzbd rather than the caller, and is still checked.
    const h = harness({
      downloadPath: "/somewhere/else/Dune.2021",
      target: { kind: "movie", title: "Dune" },
    });
    await expect(
      invoke(route(h, "POST", "/imports"), {
        body: { acquisitionId: ACQUISITION },
      }),
    ).rejects.toThrow(/outside the configured download root/);
    expect(await h.repository.list()).toHaveLength(0);
  });

  it("refuses a download that climbs out with a parent segment", async () => {
    const h = harness({
      downloadPath: path.join(DOWNLOAD_ROOT, "..", "..", "Windows"),
      target: { kind: "movie", title: "Dune" },
    });
    await expect(
      invoke(route(h, "POST", "/imports"), {
        body: { acquisitionId: ACQUISITION },
      }),
    ).rejects.toThrow(/outside the configured download root/);
  });

  it("refuses a sibling root whose name merely starts the same way", async () => {
    const h = harness({
      downloadPath: `${DOWNLOAD_ROOT}-other/Dune.2021`,
      target: { kind: "movie", title: "Dune" },
    });
    await expect(
      invoke(route(h, "POST", "/imports"), {
        body: { acquisitionId: ACQUISITION },
      }),
    ).rejects.toThrow(/outside the configured download root/);
  });

  it("refuses an acquisition with nothing finished to import", async () => {
    const h = harness(null);
    await expect(
      invoke(route(h, "POST", "/imports"), {
        body: { acquisitionId: ACQUISITION },
      }),
    ).rejects.toThrow(/no finished download/);
  });

  it("refuses when no library is configured for that kind", async () => {
    const h = harness(undefined, null);
    await expect(
      invoke(route(h, "POST", "/imports"), {
        body: { acquisitionId: ACQUISITION },
      }),
    ).rejects.toThrow(/No library is configured/);
  });

  it("does not import inside the request", async () => {
    const h = harness();
    await invoke(route(h, "POST", "/imports"), {
      body: { acquisitionId: ACQUISITION },
    });
    expect(h.service.execute).not.toHaveBeenCalled();
  });

  it("collapses a double-clicked button onto one job", async () => {
    const h = harness();
    await invoke(route(h, "POST", "/imports"), {
      body: { acquisitionId: ACQUISITION },
    });
    const [record] = await h.repository.list();
    expect(h.enqueued[0]!.dedupeKey).toBe(`import.run:${record!.id}`);
  });

  it("only replaces library media when told the release is an upgrade", async () => {
    const h = harness();
    await invoke(route(h, "POST", "/imports"), {
      body: { acquisitionId: ACQUISITION },
    });
    expect((await h.repository.list())[0]!.isUpgrade).toBe(false);

    const upgrading = harness();
    await invoke(route(upgrading, "POST", "/imports"), {
      body: { acquisitionId: ACQUISITION, isUpgrade: true },
    });
    expect((await upgrading.repository.list())[0]!.isUpgrade).toBe(true);
  });
});

describe("what the wire shape carries", () => {
  it("never carries an absolute path", async () => {
    /*
     * Destinations are library-relative. The roots name the layout of the
     * operator's disks, and a client has no use for them worth the disclosure.
     */
    const h = harness();
    await invoke(route(h, "POST", "/imports"), {
      body: { acquisitionId: ACQUISITION },
    });
    const [record] = await h.repository.list();
    await h.repository.addFiles(record!.id, [
      {
        role: "media",
        sourceRelative: "Dune.2021.1080p/dune.mkv",
        destinationRelative: "Dune (2021)/src/Dune (2021).mkv",
        destinationKey: "k",
      },
    ]);

    const { payload } = await invoke(route(h, "GET", "/imports"));
    const body = JSON.stringify(payload);
    expect(body).not.toContain(DOWNLOAD_ROOT);
    expect(body).not.toContain(LIBRARY_ROOT);
    expect(body).toContain("Dune (2021)/src/Dune (2021).mkv");
  });

  it("returns the audit trail with the detail", async () => {
    const h = harness();
    await invoke(route(h, "POST", "/imports"), {
      body: { acquisitionId: ACQUISITION },
    });
    const [record] = await h.repository.list();
    const { payload } = await invoke(route(h, "GET", "/imports/:importId"), {
      params: { importId: record!.id },
    });
    expect(payload?.data?.events).toEqual([
      expect.objectContaining({ toState: "planned" }),
    ]);
  });

  it("lists what a person has to look at", async () => {
    const h = harness();
    await invoke(route(h, "POST", "/imports"), {
      body: { acquisitionId: ACQUISITION },
    });
    const [record] = await h.repository.list();
    await h.repository.update(record!.id, "planned", {
      state: "needs_attention",
      failureClass: "destination-occupied",
    });

    const { payload } = await invoke(
      route(h, "GET", "/imports/needs-attention"),
    );
    const imports = payload?.data?.imports as Array<Record<string, unknown>>;
    expect(imports).toHaveLength(1);
    expect(imports[0]).toMatchObject({ failureClass: "destination-occupied" });
  });

  it("answers 404 for an import that does not exist", async () => {
    const h = harness();
    await expect(
      invoke(route(h, "GET", "/imports/:importId"), {
        params: { importId: ACQUISITION },
      }),
    ).rejects.toBeInstanceOf(OwnApiError);
  });
});

describe("retrying and cancelling by hand", () => {
  async function importInState(state: string): Promise<Harness> {
    const h = harness();
    await invoke(route(h, "POST", "/imports"), {
      body: { acquisitionId: ACQUISITION },
    });
    const [record] = await h.repository.list();
    if (state !== "planned") {
      await h.repository.update(record!.id, "planned", {
        state: state as "failed",
      });
    }
    return h;
  }

  it.each(["failed", "needs_attention"])(
    "retries an import that is %s",
    async (state) => {
      const h = await importInState(state);
      const [record] = await h.repository.list();
      const { status } = await invoke(
        route(h, "POST", "/imports/:importId/retry"),
        { params: { importId: record!.id } },
      );
      expect(status).toBe(202);
      expect((await h.repository.get(record!.id))?.state).toBe("planned");
    },
  );

  it.each(["committing", "uncertain", "committed", "complete"])(
    "refuses to retry an import that is %s",
    async (state) => {
      /*
       * These may already have changed the library, and restarting one by hand
       * is exactly what reconciliation exists to prevent.
       */
      const h = await importInState(state);
      const [record] = await h.repository.list();
      await expect(
        invoke(route(h, "POST", "/imports/:importId/retry"), {
          params: { importId: record!.id },
        }),
      ).rejects.toMatchObject({ statusCode: 409 });
    },
  );

  it("cancels an import that has not touched the library", async () => {
    const h = await importInState("planned");
    const [record] = await h.repository.list();
    const { status } = await invoke(
      route(h, "POST", "/imports/:importId/cancel"),
      { params: { importId: record!.id } },
    );
    expect(status).toBe(204);
    expect((await h.repository.get(record!.id))?.state).toBe("cancelled");
  });

  it.each(["committing", "uncertain", "committed", "cleaning", "complete"])(
    "refuses to cancel an import that is %s",
    async (state) => {
      // Cancelling would leave a file in the library that no import claims.
      const h = await importInState(state);
      const [record] = await h.repository.list();
      await expect(
        invoke(route(h, "POST", "/imports/:importId/cancel"), {
          params: { importId: record!.id },
        }),
      ).rejects.toMatchObject({ statusCode: 409 });
    },
  );

  it("reconciles on demand rather than waiting for the timer", async () => {
    const h = await importInState("uncertain");
    const [record] = await h.repository.list();
    const { payload } = await invoke(
      route(h, "POST", "/imports/:importId/reconcile"),
      { params: { importId: record!.id } },
    );
    expect(h.service.reconcile).toHaveBeenCalledWith(record!.id);
    expect(payload?.data?.outcome).toMatchObject({ state: "committed" });
  });
});
