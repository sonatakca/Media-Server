// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import path from "node:path";
import { startMediaServer, type RunningMediaServer } from "./mediaServer";
import type { NativeRuntime } from "./ownApi/nativeRuntime";
import { buildOwnApiHealthStatus } from "./ownApi/ownApiHandler";
import { createStartupCoordinator } from "./startup/startupCoordinator";

/**
 * The incident, as a test.
 *
 * On the day this work came from, `node src/server/mediaServer.ts` stayed alive
 * for over nine minutes without binding port 43110, without printing a line,
 * and without any way to ask what it was doing. The cause was one call —
 * `stat("/Volumes/Expansion/media")` — blocked in the kernel on an external
 * volume that had stopped answering.
 *
 * Everything below fakes that volume rather than hanging the test runner: a
 * probe that never resolves is the same thing from the process's point of view,
 * and it is the point of view the tests are about.
 */

const HEALTHY_CHECKS = {
  database: "available",
  jobs: "available",
  ffmpeg: "available",
  ffprobe: "available",
  mediaStorage: "available",
  generatedStorage: "writable",
} as const;

function fakeRuntime(overrides: Partial<NativeRuntime> = {}): NativeRuntime {
  return {
    routeHandler: async (_request, response) => {
      response.statusCode = 200;
      response.end('{"data":"from the runtime"}');
      return true;
    },
    resolveRouteTemplate: () => undefined,
    databaseCheck: async () => "available",
    jobsCheck: async () => "available",
    close: async () => undefined,
    ...overrides,
  };
}

interface Harness {
  server: RunningMediaServer;
  origin: string;
  get(path: string): Promise<{ status: number; body: Record<string, unknown> }>;
}

const running: RunningMediaServer[] = [];

afterEach(async () => {
  while (running.length > 0) {
    await running.pop()?.close();
  }
  vi.restoreAllMocks();
});

async function start(
  options: Partial<Parameters<typeof startMediaServer>[0]> = {},
): Promise<Harness> {
  const server = await startMediaServer({
    host: "127.0.0.1",
    // The kernel picks the port, so two suites may run at once.
    port: 0,
    mediaRoot: "/Volumes/Expansion/media",
    generatedStoragePath: "/tmp/seyirlik-generated-test",
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
    probeMediaRoot: async () => "/Volumes/Expansion/media",
    prepareGeneratedStorage: async () => undefined,
    createRuntime: async ({ startup }) => {
      // The real runtime reports these two phases from inside itself.
      startup?.begin({ id: "database", operation: "connect" });
      startup?.complete("database");
      startup?.begin({ id: "processing", operation: "reconcile" });
      startup?.complete("processing");
      return fakeRuntime();
    },
    createHealthService: () => ({
      getStatus: async () => buildOwnApiHealthStatus({ ...HEALTHY_CHECKS }),
    }),
    ...options,
  });
  running.push(server);

  const address = (server.server as Server).address();
  if (typeof address === "string" || address === null) {
    throw new Error("Expected a TCP address.");
  }
  const origin = `http://127.0.0.1:${address.port}`;

  return {
    server,
    origin,
    async get(path) {
      const response = await fetch(`${origin}${path}`);
      return {
        status: response.status,
        body: (await response.json()) as Record<string, unknown>,
      };
    },
  };
}

/** Waits for a condition without a fixed sleep, so a slow machine still passes. */
async function until(
  predicate: () => boolean,
  description: string,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error(`Timed out waiting: ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("a media volume that has stopped answering", () => {
  it("binds the port anyway, and says what it is waiting on", async () => {
    let probes = 0;
    const harness = await start({
      probeMediaRoot: () => {
        probes += 1;
        // Blocked in the kernel. Nothing resolves it, ever.
        return new Promise<string>(() => undefined);
      },
    });

    // Before this change the process had no socket at all for nine minutes.
    expect(harness.server.server.listening).toBe(true);

    const health = await harness.get("/ownAPI/v1/health");
    expect(health.status).toBe(200);
    expect(health.body.data).toMatchObject({
      alive: true,
      ready: false,
      startup: {
        live: true,
        ready: false,
        state: "starting",
        phase: "media-storage",
      },
    });

    // The exact diagnosis, available over HTTP rather than through LLDB.
    const phase = harness.server.startup
      .snapshot()
      .phases.find((entry) => entry.id === "media-storage");
    expect(phase).toMatchObject({
      state: "running",
      operation: "stat",
      resource: path.resolve("/Volumes/Expansion/media"),
    });
    expect(phase?.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(probes).toBe(1);
  });

  it("refuses ordinary routes with a structured 503 rather than crashing", async () => {
    const harness = await start({
      probeMediaRoot: () => new Promise<string>(() => undefined),
    });

    const response = await fetch(`${harness.origin}/ownAPI/v1/catalogue/items`);
    const body = (await response.json()) as Record<string, never>;

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("5");
    expect(body.error).toMatchObject({ code: "SERVER_STARTING" });
    expect(body.startup).toMatchObject({ phase: "media-storage" });
    // The endpoint is public; the media root is not.
    expect(JSON.stringify(body)).not.toContain("/Volumes");
  });

  it("never launches a second probe against a volume that has not answered", async () => {
    let probes = 0;
    const harness = await start({
      // As fast as the gate will retry, if it were going to retry at all.
      storageRetryMaxDelayMs: 1,
      probeMediaRoot: () => {
        probes += 1;
        return new Promise<string>(() => undefined);
      },
    });

    /*
     * The point of the whole design. A blocked `stat` holds a libuv worker, the
     * pool has four, and a loop that issued a fresh one every millisecond would
     * strand every thread in the process inside a second.
     */
    for (let poll = 0; poll < 5; poll += 1) {
      await harness.get("/ownAPI/v1/health");
    }
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(probes).toBe(1);
  });

  it("becomes ready by itself when the volume comes back", async () => {
    let attempts = 0;
    const harness = await start({
      storageRetryMaxDelayMs: 5,
      probeMediaRoot: async () => {
        attempts += 1;
        if (attempts < 3)
          throw new Error("ENOENT: stat '/Volumes/Expansion/media'");
        return "/Volumes/Expansion/media";
      },
    });

    await harness.server.ready;

    expect(attempts).toBe(3);
    expect(harness.server.startup.snapshot()).toMatchObject({
      live: true,
      ready: true,
      state: "ready",
    });
    const response = await fetch(`${harness.origin}/ownAPI/v1/catalogue/items`);
    expect(response.status).toBe(200);
  });

  it("waits out a media root that is simply not mounted yet", async () => {
    let mounted = false;
    const harness = await start({
      storageRetryMaxDelayMs: 5,
      probeMediaRoot: async () => {
        if (!mounted) {
          throw new Error(
            "SEYIRLIK_MEDIA_ROOT must point to an existing media directory.",
          );
        }
        return "/Volumes/Expansion/media";
      },
    });

    await until(
      () =>
        harness.server.startup
          .snapshot()
          .phases.find((phase) => phase.id === "media-storage")?.detail !==
        undefined,
      "the first failed probe to be recorded",
    );

    // Still up, still refusing, still not exiting into a relaunch loop.
    expect(harness.server.server.listening).toBe(true);
    expect(harness.server.startup.snapshot().ready).toBe(false);

    mounted = true;
    await harness.server.ready;
    expect(harness.server.startup.snapshot().ready).toBe(true);
  });
});

describe("readiness", () => {
  it("is false until every phase is done, then true", async () => {
    let release: ((root: string) => void) | undefined;
    const harness = await start({
      probeMediaRoot: () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    });

    expect(harness.server.startup.snapshot().ready).toBe(false);
    expect((await harness.get("/ownAPI/v1/health")).body.data).toMatchObject({
      alive: true,
      ready: false,
    });

    release?.("/Volumes/Expansion/media");
    await harness.server.ready;

    const health = await harness.get("/ownAPI/v1/health");
    expect(health.body.data).toMatchObject({ alive: true, ready: true });
    expect(
      harness.server.startup.snapshot().phases.map((p) => p.state),
    ).toEqual(["ready", "ready", "ready", "ready", "ready", "ready", "ready"]);
  });

  it("runs the phases in an order a person can follow", async () => {
    const entered: string[] = [];
    const harness = await start({
      startup: createStartupCoordinator({
        observer: { began: (phase) => entered.push(phase.id) },
      }),
    });
    await harness.server.ready;

    expect(entered).toEqual([
      "configuration",
      "listener",
      "media-storage",
      "generated-storage",
      "database",
      "processing",
      "routes",
    ]);
  });
});

describe("startup failures", () => {
  it("fails the listener phase when the port cannot be bound", async () => {
    const startup = createStartupCoordinator();
    const bindFailure = Object.assign(new Error("listen EACCES"), {
      code: "EACCES",
    });

    await expect(
      startMediaServer({
        mediaRoot: "/Volumes/Expansion/media",
        startup,
        bindListener: async () => {
          throw bindFailure;
        },
      }),
    ).rejects.toMatchObject({ code: "EACCES" });

    expect(startup.snapshot()).toMatchObject({ live: false, ready: false });
    expect(
      startup.snapshot().phases.find((phase) => phase.id === "listener"),
    ).toMatchObject({ state: "failed", error: "listen EACCES" });
  });

  it("gives up on a database that never comes back, and says which phase", async () => {
    const harness = await start({
      databaseWaitTimeoutMs: 0,
      databaseRetryDelayMs: 1,
      createRuntime: async ({ startup }) => {
        startup?.begin({ id: "database", operation: "connect" });
        throw new Error("The database is unavailable.");
      },
    });

    await expect(harness.server.ready).rejects.toThrow(
      "The database is unavailable.",
    );

    // Live throughout, so the failure is something a browser can be told about.
    expect(harness.server.server.listening).toBe(true);
    expect(harness.server.startup.snapshot()).toMatchObject({
      live: true,
      ready: false,
      state: "failed",
      phase: "database",
    });

    const refusal = await fetch(`${harness.origin}/ownAPI/v1/auth/me`);
    expect(refusal.status).toBe(503);
    expect(
      ((await refusal.json()) as Record<string, never>).error,
    ).toMatchObject({ code: "SERVER_STARTUP_FAILED" });
  });

  it("retries a database that is merely late", async () => {
    let attempts = 0;
    const harness = await start({
      databaseRetryDelayMs: 1,
      createRuntime: async ({ startup }) => {
        attempts += 1;
        startup?.begin({ id: "database", operation: "connect" });
        if (attempts < 3) throw new Error("The database is unavailable.");
        startup?.complete("database");
        startup?.begin({ id: "processing" });
        startup?.complete("processing");
        return fakeRuntime();
      },
    });

    await harness.server.ready;
    expect(attempts).toBe(3);
    expect(harness.server.startup.snapshot().ready).toBe(true);
  });

  it("does not retry a schema that needs migrating", async () => {
    let attempts = 0;
    const harness = await start({
      databaseRetryDelayMs: 1,
      createRuntime: async ({ startup }) => {
        attempts += 1;
        startup?.begin({ id: "database" });
        throw new Error(
          "The database schema is not current. Run `npm run db:migrate`.",
        );
      },
    });

    await expect(harness.server.ready).rejects.toThrow("db:migrate");
    expect(attempts).toBe(1);
  });

  it("reports a generated-storage directory it cannot create", async () => {
    const harness = await start({
      storageRetryMaxDelayMs: 5,
      prepareGeneratedStorage: async () => {
        throw new Error("EACCES: permission denied, mkdir '/srv/generated'");
      },
    });

    await until(
      () =>
        harness.server.startup
          .snapshot()
          .phases.find((phase) => phase.id === "generated-storage")?.detail !==
        undefined,
      "the generated-storage failure to be recorded",
    );

    const phase = harness.server.startup
      .snapshot()
      .phases.find((entry) => entry.id === "generated-storage");
    expect(phase).toMatchObject({ state: "running", operation: "mkdir" });
    expect(phase?.detail).toContain("EACCES");
    // Safe to serve: the sanitiser took the path out.
    expect(phase?.detail).not.toContain("/srv/generated");
  });
});

describe("shutting down before startup finished", () => {
  it("stops waiting, stays unready, and leaves nothing running", async () => {
    const harness = await start({
      probeMediaRoot: () => new Promise<string>(() => undefined),
    });

    await harness.server.close();

    expect(harness.server.server.listening).toBe(false);
    expect(harness.server.startup.snapshot()).toMatchObject({
      ready: false,
      state: "stopping",
    });
    // The media-storage phase was open; it is cancelled, not left running.
    expect(
      harness.server.startup
        .snapshot()
        .phases.find((phase) => phase.id === "media-storage")?.state,
    ).toBe("cancelled");
  });

  it("abandons the dependency wait as soon as the signal fires", async () => {
    const shutdown = new AbortController();
    const harness = await start({
      signal: shutdown.signal,
      storageRetryMaxDelayMs: 5,
      probeMediaRoot: async () => {
        throw new Error("not mounted");
      },
    });

    shutdown.abort();
    await expect(harness.server.ready).rejects.toThrow(/Shutdown began/);
    expect(harness.server.startup.snapshot().ready).toBe(false);
  });

  it("closes a runtime built after shutdown began rather than orphaning it", async () => {
    const shutdown = new AbortController();
    let closed = false;
    const harness = await start({
      signal: shutdown.signal,
      createRuntime: async ({ startup }) => {
        startup?.begin({ id: "database" });
        startup?.complete("database");
        startup?.begin({ id: "processing" });
        startup?.complete("processing");
        shutdown.abort();
        // A pool, a watchdog and possibly a worker; nobody would ever hold it.
        return fakeRuntime({
          close: async () => {
            closed = true;
          },
        });
      },
    });

    await expect(harness.server.ready).rejects.toThrow(/Shutdown began/);
    expect(closed).toBe(true);
  });
});

describe("the app shell", () => {
  it("is not gated, so a browser can be told what is happening", async () => {
    const harness = await start({
      probeMediaRoot: () => new Promise<string>(() => undefined),
    });

    // No static root configured here, so the fall-through 404 stands in for
    // the shell: the point is that it is not the gate's 503.
    const response = await fetch(`${harness.origin}/series/some-id`);
    expect(response.status).toBe(404);
    expect(
      ((await response.json()) as Record<string, never>).error,
    ).toMatchObject({ code: "NOT_FOUND" });
  });
});
