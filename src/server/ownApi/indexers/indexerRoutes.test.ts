// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createIndexerRoutes } from "./indexerRoutes";
import { createIndexerRegistry } from "./indexerRegistry";
import { createIndexerSearchService } from "./searchService";
import type { RouteContext, RouteDefinition } from "../api/router";
import type { IndexerConfigEntry } from "./indexerConfig";

const KEY = "0123456789abcdef0123456789abcdef";
const CAPS = `<caps><limits max="100" default="50"/><searching>
  <search available="yes" supportedParams="q"/></searching>
  <categories><category id="2000" name="Movies"/></categories></caps>`;
const RSS =
  `<rss version="2.0"><channel><newznab:response offset="0" total="1"/>` +
  `<item><title>A Film 2160p</title><guid>g1</guid>` +
  `<link>https://api.invalid/api?t=get&amp;id=1&amp;apikey=${KEY}</link>` +
  `<comments>https://site.invalid/details/1</comments>` +
  `<enclosure length="1024" /><newznab:attr name="category" value="2000"/>` +
  `</channel></rss>`.replace("</channel>", "</item></channel>");

const ENTRY: IndexerConfigEntry = {
  id: "nzbgeek",
  name: "NZBgeek",
  type: "newznab",
  baseUrl: "https://api.invalid",
  apiPath: "/api",
  protocol: "usenet",
  enabled: true,
  apiKeyEnv: "IX_KEY",
  categories: { movie: [2000], tv: [5000] },
};

function routes(
  handler: (params: URLSearchParams) => Response,
  entries: readonly IndexerConfigEntry[] = [ENTRY],
) {
  const fetchImpl = vi.fn(async (input: URL | RequestInfo) =>
    handler(new URL(String(input)).searchParams),
  ) as unknown as typeof fetch;
  const registry = createIndexerRegistry({
    entries,
    environment: { IX_KEY: KEY },
    fetchImpl,
  });
  return createIndexerRoutes({
    registry,
    search: createIndexerSearchService(registry),
  });
}

interface Captured {
  status: number;
  payload: unknown;
}

function invoke(
  route: RouteDefinition,
  {
    body,
    params = {},
  }: { body?: unknown; params?: Record<string, string> } = {},
): Promise<Captured> {
  const captured: Captured = { status: 0, payload: undefined };
  const listeners = new Map<string, () => void>();
  const context = {
    request: {
      once: (event: string, fn: () => void) => listeners.set(event, fn),
      off: () => undefined,
    },
    response: {
      statusCode: 0,
      setHeader: () => undefined,
      end: (chunk?: string) => {
        captured.payload = chunk ? JSON.parse(chunk) : undefined;
      },
      get headersSent() {
        return false;
      },
      writeHead: (status: number) => {
        captured.status = status;
      },
    },
    requestId: "req-1",
    url: new URL("http://localhost/ownAPI/v1/indexers/search"),
    params,
    method: "POST",
    principal: { userId: "u1", isAdministrator: true },
    requirePrincipal: () => ({ userId: "u1", isAdministrator: true }),
    readJson: async () => body,
  } as unknown as RouteContext;
  return route.handle(context).then(() => captured);
}

const ok = (body: string) => new Response(body, { status: 200 });
const respond = (params: URLSearchParams) =>
  params.get("t") === "caps" ? ok(CAPS) : ok(RSS);

describe("the search API", () => {
  it("requires an administrator on every route", () => {
    for (const route of routes(respond)) expect(route.access).toBe("admin");
  });

  it("offers no route that fetches or grabs anything", () => {
    /*
     * Phase 2 stops at discovery. An endpoint that fetches an NZB is one that
     * starts changing somebody's library, and it belongs with the phase that
     * owns importing.
     */
    const paths = routes(respond).map(
      (route) => `${route.method} ${route.path}`,
    );
    expect(paths).toEqual([
      "GET /indexers",
      "GET /indexers/:indexerId/capabilities",
      "POST /indexers/search",
    ]);
  });

  it("lists the configured indexers and their status", async () => {
    const list = routes(respond)[0]!;
    const { payload } = await invoke(list);
    expect(
      (payload as { data: { indexers: unknown[] } }).data.indexers,
    ).toEqual([expect.objectContaining({ id: "nzbgeek", enabled: true })]);
  });

  it("returns the provider's own capabilities", async () => {
    const caps = routes(respond)[1]!;
    const { payload } = await invoke(caps, {
      params: { indexerId: "nzbgeek" },
    });
    const data = (payload as { data: { categories: { id: number }[] } }).data;
    expect(data.categories.map((c) => c.id)).toEqual([2000]);
  });

  it("answers 404 for an indexer that is not configured", async () => {
    const caps = routes(respond)[1]!;
    await expect(
      invoke(caps, { params: { indexerId: "nope" } }),
    ).rejects.toMatchObject({ code: "INDEXER_NOT_FOUND" });
  });

  it("searches and returns normalised releases", async () => {
    const search = routes(respond)[2]!;
    const { payload } = await invoke(search, {
      body: { kind: "movie", term: "a film" },
    });
    const data = (payload as { data: { releases: { title: string }[] } }).data;
    expect(data.releases.map((r) => r.title)).toEqual(["A Film 2160p"]);
  });

  it("never returns the credential-bearing download URL", async () => {
    const search = routes(respond)[2]!;
    const { payload } = await invoke(search, {
      body: { kind: "search", term: "x" },
    });
    const serialised = JSON.stringify(payload);
    expect(serialised).not.toContain(KEY);
    expect(serialised).not.toContain("apikey");
    expect(serialised).not.toContain("t=get");
    // The details page is a public URL and is useful, so it does travel.
    expect(serialised).toContain("https://site.invalid/details/1");
  });

  describe("input validation", () => {
    const search = () => routes(respond)[2]!;

    it.each([
      ["no search terms at all", {}],
      ["an unknown kind", { kind: "everything", term: "x" }],
      ["an imdbId that is not one", { kind: "movie", imdbId: "not-an-id" }],
      ["a tvdbId that is not one", { kind: "tv", tvdbId: "abc" }],
      ["a category that is not a number", { term: "x", categoryIds: ["2000"] }],
      ["a limit past the maximum", { term: "x", limit: 5000 }],
      ["an unexpected field", { term: "x", grab: true }],
    ])("refuses %s", async (_label, body) => {
      // 422 is this API's validation status, not 400.
      await expect(invoke(search(), { body })).rejects.toMatchObject({
        code: "VALIDATION_FAILED",
        statusCode: 422,
      });
    });

    it("accepts an identifier search with no free-text term", async () => {
      const { payload } = await invoke(search(), {
        body: { kind: "movie", imdbId: "tt0111161" },
      });
      expect(payload).toBeDefined();
    });
  });

  describe("provider failures", () => {
    it.each([
      [401, "INDEXER_AUTH_FAILED", 502],
      [429, "INDEXER_RATE_LIMITED", 503],
      [500, "INDEXER_UNAVAILABLE", 503],
    ])("maps HTTP %s to %s", async (status, code, apiStatusCode) => {
      const search = routes((params) =>
        params.get("t") === "caps" ? ok(CAPS) : new Response("", { status }),
      )[2]!;
      await expect(
        invoke(search, { body: { kind: "search", term: "x" } }),
      ).rejects.toMatchObject({ code, statusCode: apiStatusCode });
    });

    it("reports a provider refusal that arrived as HTTP 200", async () => {
      const search = routes((params) =>
        params.get("t") === "caps"
          ? ok(CAPS)
          : ok(`<error code="100" description="Incorrect user credentials"/>`),
      )[2]!;
      await expect(
        invoke(search, { body: { kind: "search", term: "x" } }),
      ).rejects.toMatchObject({ code: "INDEXER_AUTH_FAILED" });
    });

    it("says so when nothing is configured rather than returning an empty page", async () => {
      const search = routes(respond, [])[2]!;
      await expect(
        invoke(search, { body: { kind: "search", term: "x" } }),
      ).rejects.toMatchObject({ code: "INDEXER_NOT_FOUND" });
    });
  });
});
