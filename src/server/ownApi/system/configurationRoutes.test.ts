// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  createConfigurationRoutes,
  describeHost,
  type IntegrationStatus,
} from "./configurationRoutes";
import type { DatabasePool } from "../database/databasePool";
import type { RouteContext, RouteDefinition } from "../api/router";
import type { BackupRepository } from "./backupRepository";

function invoke(definition: RouteDefinition): Promise<{
  status: number;
  payload: { data?: Record<string, unknown> } | undefined;
}> {
  const captured = { status: 0, payload: undefined as never };
  const context = {
    request: { once: () => undefined, off: () => undefined },
    response: {
      setHeader: () => undefined,
      end: (chunk?: string) => {
        (captured as { payload: unknown }).payload = chunk
          ? JSON.parse(chunk)
          : undefined;
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
    url: new URL("http://localhost/ownAPI/v1/admin/configuration"),
    params: {},
    method: definition.method,
    principal: { userId: "u", isAdministrator: true },
    requirePrincipal: () => ({ userId: "u", isAdministrator: true }),
    readJson: async () => undefined,
  } as unknown as RouteContext;
  return definition.handle(context).then(() => captured);
}

const pool = {
  query: vi.fn(async () => ({
    rows: [{ version: "001_native_identity" }],
  })),
} as unknown as DatabasePool;

const backups = {
  record: vi.fn(),
  list: vi.fn(async () => []),
  latest: vi.fn(async () => null),
  latestVerified: vi.fn(async () => null),
} as unknown as BackupRepository;

function routes(integrations: IntegrationStatus[]): RouteDefinition[] {
  return createConfigurationRoutes({
    pool,
    backups,
    integrations: () => integrations,
  });
}

const route = (list: RouteDefinition[], path: string) =>
  list.find((entry) => entry.path === path)!;

describe("reporting what is configured", () => {
  it("is administrative only", () => {
    for (const definition of routes([])) {
      expect(definition.access).toBe("admin");
    }
  });

  it("says configured or not, with something recognisable", async () => {
    const { payload } = await invoke(
      route(
        routes([
          {
            id: "downloadClient",
            configured: true,
            detail: "127.0.0.1:8080 · seyirlik",
          },
          { id: "subtitles", configured: false },
        ]),
        "/admin/configuration",
      ),
    );
    expect(payload?.data?.integrations).toEqual([
      {
        id: "downloadClient",
        configured: true,
        detail: "127.0.0.1:8080 · seyirlik",
      },
      { id: "subtitles", configured: false },
    ]);
  });

  it("never returns a stored secret", async () => {
    /*
     * The rule the whole endpoint exists to enforce. A key that has been
     * written is never read back out — an operator replaces it, they do not
     * read it.
     */
    const { payload } = await invoke(
      route(
        routes([{ id: "indexers", configured: true, detail: "NZBgeek" }]),
        "/admin/configuration",
      ),
    );
    const body = JSON.stringify(payload);
    expect(body).not.toMatch(/apikey/i);
    expect(body).not.toMatch(/secret/i);
    expect(body).not.toMatch(/password/i);
  });
});

describe("describing a host without its query string", () => {
  it("keeps the authority and drops everything else", () => {
    // An indexer's base URL can carry its API key; only the host is shown.
    expect(describeHost("https://api.nzbgeek.info/api?apikey=deadbeef")).toBe(
      "api.nzbgeek.info",
    );
    expect(describeHost("http://127.0.0.1:8080/sabnzbd")).toBe(
      "127.0.0.1:8080",
    );
  });

  it("says nothing rather than guessing at a malformed URL", () => {
    expect(describeHost("not a url")).toBeUndefined();
    expect(describeHost(undefined)).toBeUndefined();
  });
});

describe("reporting what a backup proved", () => {
  it("does not call an absent backup healthy", async () => {
    /*
     * Never-run and verified must not look the same. A panel that went green
     * on the presence of a file would read as reassurance and carry none.
     */
    const { payload } = await invoke(route(routes([]), "/admin/backups"));
    expect(payload?.data?.health).toEqual({
      healthy: false,
      reason: "never-run",
    });
    expect(payload?.data?.latest).toBeNull();
  });
});

describe("reporting the schema", () => {
  it("asks the table that exists and reports what is missing", async () => {
    const { payload } = await invoke(route(routes([]), "/admin/schema"));
    expect(
      (pool.query as unknown as { mock: { calls: string[][] } }).mock
        .calls[0]![0],
    ).toContain("seyirlik_migrations");
    expect(payload?.data).toMatchObject({
      applied: 1,
      latest: "001_native_identity",
    });
    // The code ships more migrations than this database has recorded.
    expect(payload?.data?.current).toBe(false);
    expect(Array.isArray(payload?.data?.pending)).toBe(true);
  });
});
