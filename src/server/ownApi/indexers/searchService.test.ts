// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createIndexerRegistry } from "./indexerRegistry";
import { createIndexerSearchService } from "./searchService";
import { IndexerError } from "./indexerTypes";
import type { IndexerConfigEntry } from "./indexerConfig";

const KEY = "0123456789abcdef0123456789abcdef";

const CAPS = `<caps><limits max="100" default="50"/><searching>
  <search available="yes" supportedParams="q"/></searching>
  <categories><category id="2000" name="Movies"/></categories></caps>`;

const rss = (titles: readonly string[], dates: readonly string[] = []) =>
  `<rss version="2.0"><channel><newznab:response offset="0" total="${titles.length}"/>` +
  titles
    .map(
      (title, index) =>
        `<item><title>${title}</title><guid>g-${title}</guid>` +
        `<link>https://x.invalid/get?id=${title}</link>` +
        (dates[index] ? `<pubDate>${dates[index]}</pubDate>` : "") +
        `</item>`,
    )
    .join("") +
  `</channel></rss>`;

function entry(id: string, keyEnv: string): IndexerConfigEntry {
  return {
    id,
    name: id.toUpperCase(),
    type: "newznab",
    baseUrl: `https://${id}.invalid`,
    apiPath: "/api",
    protocol: "usenet",
    enabled: true,
    apiKeyEnv: keyEnv,
    categories: { movie: [2000, 2045], tv: [5000] },
  };
}

function registryOf(
  entries: readonly IndexerConfigEntry[],
  handler: (host: string, params: URLSearchParams) => Response,
) {
  const fetchImpl = vi.fn(async (input: URL | RequestInfo) => {
    const url = new URL(String(input));
    return handler(url.hostname, url.searchParams);
  }) as unknown as typeof fetch;
  const environment: NodeJS.ProcessEnv = {};
  for (const item of entries) environment[item.apiKeyEnv] = KEY;
  return createIndexerRegistry({ entries, environment, fetchImpl });
}

const ok = (body: string) => new Response(body, { status: 200 });

describe("searching across configured indexers", () => {
  it("queries every enabled indexer and merges the results", async () => {
    const registry = registryOf(
      [entry("alpha", "A_KEY"), entry("beta", "B_KEY")],
      (host, params) =>
        params.get("t") === "caps"
          ? ok(CAPS)
          : ok(rss(host === "alpha.invalid" ? ["one"] : ["two"])),
    );
    const result = await createIndexerSearchService(registry).search({
      kind: "search",
      term: "x",
    });
    expect(result.releases.map((r) => r.title).sort()).toEqual(["one", "two"]);
    expect(result.outcomes.map((o) => [o.indexerId, o.ok])).toEqual([
      ["alpha", true],
      ["beta", true],
    ]);
    expect(result.partial).toBe(false);
  });

  it("orders newest first, and breaks ties the same way every time", async () => {
    const registry = registryOf([entry("alpha", "A_KEY")], (_host, params) =>
      params.get("t") === "caps"
        ? ok(CAPS)
        : ok(
            rss(
              ["older", "newer", "undated"],
              [
                "Mon, 01 Sep 2026 00:00:00 +0000",
                "Fri, 05 Sep 2026 00:00:00 +0000",
                "",
              ],
            ),
          ),
    );
    const service = createIndexerSearchService(registry);
    const first = await service.search({ kind: "search", term: "x" });
    const second = await service.search({ kind: "search", term: "x" });
    expect(first.releases.map((r) => r.title)).toEqual([
      "newer",
      "older",
      "undated",
    ]);
    expect(second.releases.map((r) => r.title)).toEqual(
      first.releases.map((r) => r.title),
    );
  });

  it("keeps the same release from two indexers, because they are two things to acquire", async () => {
    const registry = registryOf(
      [entry("alpha", "A_KEY"), entry("beta", "B_KEY")],
      (_host, params) =>
        params.get("t") === "caps" ? ok(CAPS) : ok(rss(["same"])),
    );
    const result = await createIndexerSearchService(registry).search({
      kind: "search",
      term: "x",
    });
    expect(result.releases).toHaveLength(2);
    expect(result.releases.map((r) => r.indexerId).sort()).toEqual([
      "alpha",
      "beta",
    ]);
  });

  it("drops a duplicate identifier within one indexer", async () => {
    const registry = registryOf([entry("alpha", "A_KEY")], (_host, params) =>
      params.get("t") === "caps" ? ok(CAPS) : ok(rss(["dup", "dup", "other"])),
    );
    const result = await createIndexerSearchService(registry).search({
      kind: "search",
      term: "x",
    });
    expect(result.releases.map((r) => r.title)).toEqual(["dup", "other"]);
  });

  it("applies the configured categories when the caller names none", async () => {
    let category: string | null = null;
    const registry = registryOf([entry("alpha", "A_KEY")], (_host, params) => {
      if (params.get("t") === "caps") return ok(CAPS);
      category = params.get("cat");
      return ok(rss(["one"]));
    });
    await createIndexerSearchService(registry).search({
      kind: "movie",
      term: "x",
    });
    expect(category).toBe("2000,2045");
  });

  it("prefers the categories the caller did name", async () => {
    let category: string | null = null;
    const registry = registryOf([entry("alpha", "A_KEY")], (_host, params) => {
      if (params.get("t") === "caps") return ok(CAPS);
      category = params.get("cat");
      return ok(rss(["one"]));
    });
    await createIndexerSearchService(registry).search({
      kind: "movie",
      term: "x",
      categoryIds: [2040],
    });
    expect(category).toBe("2040");
  });

  it("returns what worked and reports what did not", async () => {
    const registry = registryOf(
      [entry("alpha", "A_KEY"), entry("beta", "B_KEY")],
      (host, params) => {
        if (params.get("t") === "caps") return ok(CAPS);
        return host === "beta.invalid"
          ? new Response("", { status: 401 })
          : ok(rss(["one"]));
      },
    );
    const result = await createIndexerSearchService(registry).search({
      kind: "search",
      term: "x",
    });
    expect(result.releases.map((r) => r.title)).toEqual(["one"]);
    expect(result.partial).toBe(true);
    const failed = result.outcomes.find((o) => !o.ok);
    expect(failed).toMatchObject({ indexerId: "beta", errorKind: "auth" });
  });

  it("fails the search only when every indexer failed", async () => {
    const registry = registryOf([entry("alpha", "A_KEY")], (_host, params) =>
      params.get("t") === "caps" ? ok(CAPS) : new Response("", { status: 401 }),
    );
    await expect(
      createIndexerSearchService(registry).search({
        kind: "search",
        term: "x",
      }),
    ).rejects.toMatchObject({ kind: "auth" });
  });

  it("searches only the indexers the caller named", async () => {
    const asked: string[] = [];
    const registry = registryOf(
      [entry("alpha", "A_KEY"), entry("beta", "B_KEY")],
      (host, params) => {
        if (params.get("t") === "caps") return ok(CAPS);
        asked.push(host);
        return ok(rss(["one"]));
      },
    );
    await createIndexerSearchService(registry).search(
      { kind: "search", term: "x" },
      { indexerIds: ["beta"] },
    );
    expect(asked).toEqual(["beta.invalid"]);
  });

  it("refuses a search that names no indexer that exists", async () => {
    const registry = registryOf([entry("alpha", "A_KEY")], () => ok(CAPS));
    await expect(
      createIndexerSearchService(registry).search(
        { kind: "search", term: "x" },
        { indexerIds: ["nope"] },
      ),
    ).rejects.toBeInstanceOf(IndexerError);
  });

  it("records the last success and the last failure per indexer", async () => {
    let fail = false;
    const registry = registryOf([entry("alpha", "A_KEY")], (_host, params) => {
      if (params.get("t") === "caps") return ok(CAPS);
      return fail ? new Response("", { status: 503 }) : ok(rss(["one"]));
    });
    const service = createIndexerSearchService(registry);
    await service.search({ kind: "search", term: "x" });
    expect(registry.list()[0]?.lastSuccessAtMs).toBeGreaterThan(0);
    fail = true;
    await service.search({ kind: "search", term: "x" }).catch(() => undefined);
    const status = registry.list()[0]!;
    expect(status.lastErrorKind).toBe("unavailable");
    expect(status.lastErrorMessage).not.toContain(KEY);
  });

  it("never puts a disabled indexer into the registry at all", () => {
    const registry = createIndexerRegistry({
      entries: [{ ...entry("alpha", "A_KEY"), enabled: false }],
      environment: {},
    });
    expect(registry.enabled()).toEqual([]);
    expect(registry.list()[0]).toMatchObject({ id: "alpha", enabled: false });
  });
});
