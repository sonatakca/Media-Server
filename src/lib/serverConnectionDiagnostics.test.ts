import { describe, expect, it, vi } from "vitest";
import {
  classifyServerConnection,
  diagnoseServerConnection,
  getFailedDependencies,
  probeIsOnline,
  type HealthChecks,
  type HealthProbe,
} from "./serverConnectionDiagnostics";

const HEALTHY_CHECKS: HealthChecks = {
  database: "available",
  jobs: "disabled",
  ffmpeg: "available",
  ffprobe: "available",
  mediaStorage: "available",
  generatedStorage: "writable",
};

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

/** The urls a mocked fetch was asked for, in order. */
function requestedUrls(fetchImpl: { mock: { calls: unknown[][] } }): string[] {
  return fetchImpl.mock.calls.map((call) => String(call[0]));
}

function healthBody(overrides: Record<string, unknown> = {}) {
  return {
    status: "ok",
    alive: true,
    ready: true,
    checks: HEALTHY_CHECKS,
    ...overrides,
  };
}

describe("native health diagnosis", () => {
  it("reports no problem when the server is alive and ready", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(healthBody()));

    const result = await diagnoseServerConnection({ fetchImpl });

    expect(result.problem).toBe("none");
    expect(result.probe.kind).toBe("healthy");
    expect(result.failedDependencies).toEqual([]);
  });

  it("asks only the native health endpoint", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(healthBody()));

    await diagnoseServerConnection({ fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(requestedUrls(fetchImpl)).toEqual(["/ownAPI/v1/health"]);
  });

  it("never probes a Jellyfin endpoint or its default port", async () => {
    // The previous diagnostics probed /System/Info/Public and localhost:8096.
    // Both are gone, and neither may come back through this path.
    const fetchImpl = vi.fn(async () => jsonResponse(healthBody()));

    await diagnoseServerConnection({ fetchImpl });

    const requested = requestedUrls(fetchImpl).join(" ");

    expect(requested).not.toMatch(/System\/Info\/Public/i);
    expect(requested).not.toContain("8096");
    expect(requested).not.toMatch(/jellyfin|emby/i);
  });

  it("treats a dead network as unreachable", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });

    const result = await diagnoseServerConnection({ fetchImpl });

    expect(result.problem).toBe("unreachable");
    expect(result.probe.reachable).toBe(false);
  });

  it("separates a gateway failure from the server being down", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("bad gateway", { status: 502 }),
    );

    const result = await diagnoseServerConnection({ fetchImpl });

    expect(result.problem).toBe("proxy-error");
    expect(result.probe.reachable).toBe(true);
  });

  it("flags a response that is not the health payload", async () => {
    // A captive portal answering 200 with HTML looks like success otherwise.
    const fetchImpl = vi.fn(
      async () =>
        new Response("<html>sign in to the network</html>", { status: 200 }),
    );

    const result = await diagnoseServerConnection({ fetchImpl });

    expect(result.problem).toBe("unexpected-response");
  });

  it("flags JSON that is not the health payload", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ hello: "world" }));

    const result = await diagnoseServerConnection({ fetchImpl });

    expect(result.problem).toBe("unexpected-response");
  });

  it("names the dependency that is unavailable", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        healthBody({
          ready: false,
          checks: { ...HEALTHY_CHECKS, database: "unavailable" },
        }),
      ),
    );

    const result = await diagnoseServerConnection({ fetchImpl });

    expect(result.problem).toBe("dependency-unavailable");
    expect(result.failedDependencies).toEqual(["database"]);
  });

  it("does not treat a disabled dependency as a failure", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        healthBody({ checks: { ...HEALTHY_CHECKS, jobs: "disabled" } }),
      ),
    );

    const result = await diagnoseServerConnection({ fetchImpl });

    expect(result.failedDependencies).toEqual([]);
    expect(result.problem).toBe("none");
  });

  it("reports a server that is alive but still starting", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(healthBody({ ready: false })),
    );

    const result = await diagnoseServerConnection({ fetchImpl });

    expect(result.problem).toBe("starting-up");
  });

  it("reports a server that says it is not alive", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(healthBody({ alive: false, ready: false })),
    );

    const result = await diagnoseServerConnection({ fetchImpl });

    expect(result.problem).toBe("not-alive");
  });

  it("carries the request id through for log correlation", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response("nope", {
          status: 500,
          headers: { "x-request-id": "req-42" },
        }),
    );

    const result = await diagnoseServerConnection({ fetchImpl });

    expect(result.probe.requestId).toBe("req-42");
  });

  it("falls back to a recorded failure when health cannot be reached", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });

    const result = await diagnoseServerConnection({
      fetchImpl,
      failure: {
        requestUrl: "/ownAPI/v1/items/abc",
        status: 504,
        statusText: "Gateway Timeout",
      },
    });

    expect(result.problem).toBe("proxy-error");
    expect(result.probe.endpoint).toBe("/ownAPI/v1/items/abc");
  });

  it("exposes nothing about the server beyond coarse dependency states", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        healthBody({
          checks: { ...HEALTHY_CHECKS, database: "unavailable" },
          // A server that leaked detail must not have it forwarded.
          databaseUrl: "postgresql://user:password@127.0.0.1:5432/seyirlik",
          mediaRoot: "/srv/media",
        }),
      ),
    );

    const result = await diagnoseServerConnection({ fetchImpl });
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain("postgresql://");
    expect(serialized).not.toContain("/srv/media");
    expect(serialized).not.toContain("password");
  });
});

describe("classification helpers", () => {
  it("counts only genuinely missing dependencies", () => {
    expect(getFailedDependencies(undefined)).toEqual([]);
    expect(getFailedDependencies(HEALTHY_CHECKS)).toEqual([]);
    expect(
      getFailedDependencies({
        ...HEALTHY_CHECKS,
        generatedStorage: "unavailable",
      }),
    ).toEqual(["generatedStorage"]);
  });

  it("treats an unrecognised dependency state as a failure rather than assuming it is fine", () => {
    expect(
      getFailedDependencies({
        ...HEALTHY_CHECKS,
        mediaStorage: "unknown",
      }),
    ).toEqual(["mediaStorage"]);
  });

  it("only calls a server online when it says it is alive", () => {
    const healthy: HealthProbe = {
      endpoint: "/ownAPI/v1/health",
      kind: "healthy",
      reachable: true,
      alive: true,
      ready: true,
    };

    expect(probeIsOnline(healthy)).toBe(true);
    expect(probeIsOnline({ ...healthy, alive: false })).toBe(false);
    expect(probeIsOnline({ ...healthy, kind: "gateway-error" })).toBe(false);
    expect(probeIsOnline(null)).toBe(false);
  });

  it("maps each probe kind onto a distinct problem", () => {
    const base: HealthProbe = {
      endpoint: "/ownAPI/v1/health",
      kind: "healthy",
      reachable: true,
      alive: true,
      ready: true,
    };

    expect(
      classifyServerConnection({ ...base, kind: "network-error" }, []),
    ).toBe("unreachable");
    expect(
      classifyServerConnection({ ...base, kind: "gateway-error" }, []),
    ).toBe("proxy-error");
    expect(
      classifyServerConnection({ ...base, kind: "malformed-response" }, []),
    ).toBe("unexpected-response");
    expect(classifyServerConnection({ ...base, kind: "http-error" }, [])).toBe(
      "unknown",
    );
    expect(classifyServerConnection(base, [])).toBe("none");
  });
});
