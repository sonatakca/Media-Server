// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { ServerResponse } from "node:http";
import { createStartupGate, startupHealthChecks } from "./startupGate";
import {
  createStartupState,
  type StartupPhaseId,
  type StartupStateMachine,
} from "./startupState";
import {
  buildOwnApiHealthStatus,
  type OwnApiHealthChecks,
  type OwnApiRouteContext,
  type OwnApiRouteHandler,
} from "../ownApi/ownApiHandler";

const EVERY_PHASE: StartupPhaseId[] = [
  "configuration",
  "listener",
  "media-storage",
  "generated-storage",
  "database",
  "processing",
  "routes",
];

function responseDouble() {
  const headers = new Map<string, string>();
  let statusCode = 0;
  let body = "";

  return {
    response: {
      set statusCode(value: number) {
        statusCode = value;
      },
      get statusCode() {
        return statusCode;
      },
      setHeader(name: string, value: string | number | readonly string[]) {
        headers.set(name.toLowerCase(), String(value));
      },
      end(value?: string) {
        body = value ?? "";
      },
    } as unknown as ServerResponse,
    result: () => ({
      headers,
      statusCode,
      body,
      json: () => JSON.parse(body) as Record<string, unknown>,
    }),
  };
}

function context(pathname: string): OwnApiRouteContext {
  return {
    requestId: "gate-test-request",
    url: new URL(`http://localhost${pathname}`),
  };
}

const HEALTHY_CHECKS: OwnApiHealthChecks = {
  database: "available",
  jobs: "available",
  ffmpeg: "available",
  ffprobe: "available",
  mediaStorage: "available",
  generatedStorage: "writable",
};

function installedRuntime(handled = true) {
  const calls: string[] = [];
  return {
    calls,
    runtime: {
      routeHandler: (async (_request, _response, routeContext) => {
        calls.push(routeContext.url.pathname);
        return handled;
      }) satisfies OwnApiRouteHandler,
      resolveRouteTemplate: () => "/ownAPI/v1/catalogue/items",
      healthService: {
        getStatus: async () => buildOwnApiHealthStatus(HEALTHY_CHECKS),
      },
    },
  };
}

function reachRoutes(state: StartupStateMachine): void {
  state.markLive();
  for (const id of EVERY_PHASE) {
    state.begin(id);
    state.complete(id);
  }
}

describe("the startup gate", () => {
  it("refuses an ordinary route while startup is incomplete", async () => {
    const state = createStartupState();
    state.markLive();
    state.begin("media-storage", {
      operation: "stat",
      resource: "/Volumes/Expansion/media",
    });
    const gate = createStartupGate({ snapshot: () => state.snapshot() });
    const { response, result } = responseDouble();

    const handled = await gate.gateHandler(
      undefined as never,
      response,
      context("/ownAPI/v1/catalogue/items"),
    );

    const output = result();
    expect(handled).toBe(true);
    expect(output.statusCode).toBe(503);
    expect(output.headers.get("retry-after")).toBe("5");
    expect(output.json().error).toMatchObject({
      code: "SERVER_STARTING",
      requestId: "gate-test-request",
    });
  });

  it("tells the caller what it is waiting on, without saying where", async () => {
    const state = createStartupState();
    state.markLive();
    state.begin("media-storage", {
      operation: "stat",
      resource: "/Volumes/Expansion/media",
    });
    const gate = createStartupGate({ snapshot: () => state.snapshot() });
    const { response, result } = responseDouble();

    await gate.gateHandler(
      undefined as never,
      response,
      context("/ownAPI/v1/auth/me"),
    );

    const body = result().body;
    expect(body).not.toContain("/Volumes");
    const startup = result().json().startup as Record<string, unknown>;
    expect(startup).toMatchObject({
      live: true,
      ready: false,
      state: "starting",
      phase: "media-storage",
    });
  });

  it("distinguishes a failed startup from a slow one and from a shutdown", async () => {
    const cases: Array<[() => StartupStateMachine, string]> = [
      [
        () => {
          const state = createStartupState();
          state.begin("database");
          state.fail("database", new Error("The database is unavailable."));
          return state;
        },
        "SERVER_STARTUP_FAILED",
      ],
      [
        () => {
          const state = createStartupState();
          state.begin("media-storage");
          state.degrade("media-storage", "No answer yet.");
          return state;
        },
        "SERVER_STARTING",
      ],
      [
        () => {
          const state = createStartupState();
          state.stop();
          return state;
        },
        "SERVER_STOPPING",
      ],
    ];

    for (const [build, code] of cases) {
      const state = build();
      const gate = createStartupGate({ snapshot: () => state.snapshot() });
      const { response, result } = responseDouble();
      await gate.gateHandler(
        undefined as never,
        response,
        context("/ownAPI/v1/catalogue/items"),
      );
      expect(result().json().error).toMatchObject({ code });
    }
  });

  it("never refuses the health route, whatever the route order becomes", async () => {
    const state = createStartupState();
    const gate = createStartupGate({ snapshot: () => state.snapshot() });
    const { response } = responseDouble();

    expect(
      await gate.gateHandler(
        undefined as never,
        response,
        context("/ownAPI/v1/health"),
      ),
    ).toBe(false);
  });

  it("lets ordinary routes through once startup is ready", async () => {
    const state = createStartupState();
    const gate = createStartupGate({ snapshot: () => state.snapshot() });
    const { runtime, calls } = installedRuntime();
    gate.install(runtime);
    reachRoutes(state);

    const { response } = responseDouble();
    const routeContext = context("/ownAPI/v1/catalogue/items");

    expect(
      await gate.gateHandler(undefined as never, response, routeContext),
    ).toBe(false);
    expect(
      await gate.runtimeHandler(undefined as never, response, routeContext),
    ).toBe(true);
    expect(calls).toEqual(["/ownAPI/v1/catalogue/items"]);
  });

  it("refuses even after installation if readiness was withdrawn", async () => {
    const state = createStartupState();
    const gate = createStartupGate({ snapshot: () => state.snapshot() });
    gate.install(installedRuntime().runtime);
    reachRoutes(state);
    // SIGTERM. The routes exist; they must stop being served all the same.
    state.stop();

    const { response, result } = responseDouble();
    expect(
      await gate.gateHandler(
        undefined as never,
        response,
        context("/ownAPI/v1/catalogue/items"),
      ),
    ).toBe(true);
    expect(result().json().error).toMatchObject({ code: "SERVER_STOPPING" });
  });

  it("reaches nothing before a runtime is installed", async () => {
    const state = createStartupState();
    const gate = createStartupGate({ snapshot: () => state.snapshot() });
    const { response } = responseDouble();

    expect(gate.installed).toBe(false);
    expect(
      await gate.runtimeHandler(
        undefined as never,
        response,
        context("/ownAPI/v1/catalogue/items"),
      ),
    ).toBe(false);
    expect(gate.resolveRouteTemplate("/ownAPI/v1/catalogue/items")).toBe(
      undefined,
    );
  });
});

describe("health while starting", () => {
  it("answers alive and not ready, which is the distinction that was missing", async () => {
    const state = createStartupState();
    state.markLive();
    state.begin("media-storage", { operation: "stat" });
    const gate = createStartupGate({ snapshot: () => state.snapshot() });

    const status = await gate.healthService.getStatus();

    expect(status).toMatchObject({ status: "ok", alive: true, ready: false });
    expect(status.startup).toMatchObject({
      live: true,
      ready: false,
      state: "starting",
      phase: "media-storage",
    });
    // The shape existing consumers read is unchanged.
    expect(Object.keys(status.checks).sort()).toEqual([
      "database",
      "ffmpeg",
      "ffprobe",
      "generatedStorage",
      "jobs",
      "mediaStorage",
    ]);
  });

  it("reports only what startup has actually established", () => {
    const state = createStartupState();
    state.begin("media-storage");
    state.complete("media-storage");

    const checks = startupHealthChecks(state.snapshot());

    expect(checks.mediaStorage).toBe("available");
    expect(checks.database).toBe("unavailable");
    // Never looked for, so never claimed.
    expect(checks.ffmpeg).toBe("unavailable");
  });

  it("hands over to the runtime's probes once they exist", async () => {
    const state = createStartupState();
    const gate = createStartupGate({ snapshot: () => state.snapshot() });
    gate.install(installedRuntime().runtime);
    reachRoutes(state);

    const status = await gate.healthService.getStatus();

    expect(status).toMatchObject({ alive: true, ready: true });
    expect(status.checks.ffmpeg).toBe("available");
    expect(status.startup?.state).toBe("ready");
  });

  it("is not ready while a probe fails, even after startup finished", async () => {
    const state = createStartupState();
    const gate = createStartupGate({ snapshot: () => state.snapshot() });
    gate.install({
      ...installedRuntime().runtime,
      healthService: {
        getStatus: async () =>
          buildOwnApiHealthStatus({
            ...HEALTHY_CHECKS,
            mediaStorage: "unavailable",
          }),
      },
    });
    reachRoutes(state);

    const status = await gate.healthService.getStatus();

    expect(status.ready).toBe(false);
    expect(status.startup?.state).toBe("ready");
  });

  it("never carries a storage path out to a browser", async () => {
    const state = createStartupState();
    state.begin("media-storage", {
      operation: "stat",
      resource: "/Volumes/Expansion/media",
    });
    const gate = createStartupGate({ snapshot: () => state.snapshot() });

    const status = await gate.healthService.getStatus();

    expect(JSON.stringify(status)).not.toContain("/Volumes");
  });
});
