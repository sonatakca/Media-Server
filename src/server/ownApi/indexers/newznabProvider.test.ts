// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { IndexerError } from "./indexerTypes";
import { createNewznabProvider } from "./newznabProvider";

const KEY = "0123456789abcdef0123456789abcdef";
const CAPS = `<caps><server title="Test"/><limits max="100" default="50"/>
  <searching><search available="yes" supportedParams="q"/><movie-search available="yes" supportedParams="q,imdbid"/></searching>
  <categories><category id="2000" name="Movies"><subcat id="2040" name="HD"/></category></categories></caps>`;
const RSS = `<rss version="2.0"><channel><newznab:response offset="0" total="1"/>
  <item><title>A Film</title><guid>g1</guid><link>https://x.invalid/get?id=1</link>
  <newznab:attr name="category" value="2040"/></item></channel></rss>`;

const ok = (body: string) =>
  new Response(body, {
    status: 200,
    headers: { "content-type": "application/xml" },
  });

function provider(
  fetchImpl: typeof fetch,
  overrides: Record<string, unknown> = {},
) {
  return createNewznabProvider({
    id: "ix-1",
    name: "Test Indexer",
    baseUrl: "https://api.example.invalid",
    apiPath: "/api",
    apiKey: KEY,
    fetchImpl,
    sleep: async () => undefined,
    ...overrides,
  });
}

describe("talking to a Newznab provider", () => {
  it("sends the key as a request parameter and nothing else about it", async () => {
    const seen: URL[] = [];
    const fetchImpl = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      seen.push(url);
      return ok(url.searchParams.get("t") === "caps" ? CAPS : RSS);
    }) as unknown as typeof fetch;
    const result = await provider(fetchImpl).search({
      kind: "movie",
      term: "a film",
    });
    expect(result.releases).toHaveLength(1);
    const search = seen.find((u) => u.searchParams.get("t") === "movie")!;
    expect(search.pathname).toBe("/api");
    expect(search.searchParams.get("apikey")).toBe(KEY);
    expect(search.searchParams.get("q")).toBe("a film");
    // The provider stated 50; asking for nothing must not become "all of it".
    expect(search.searchParams.get("limit")).toBe("50");
  });

  it("asks for capabilities once and reuses them", async () => {
    let caps = 0;
    const fetchImpl = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      if (url.searchParams.get("t") === "caps") caps += 1;
      return ok(url.searchParams.get("t") === "caps" ? CAPS : RSS);
    }) as unknown as typeof fetch;
    const p = provider(fetchImpl);
    await p.search({ kind: "search", term: "one" });
    await p.search({ kind: "search", term: "two" });
    await p.capabilities();
    expect(caps).toBe(1);
  });

  it("re-reads capabilities once the cache has expired", async () => {
    let caps = 0;
    let clock = 1_000;
    const fetchImpl = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      if (url.searchParams.get("t") === "caps") caps += 1;
      return ok(url.searchParams.get("t") === "caps" ? CAPS : RSS);
    }) as unknown as typeof fetch;
    const p = provider(fetchImpl, {
      now: () => clock,
      capabilitiesTtlMs: 1_000,
    });
    await p.capabilities();
    clock += 5_000;
    await p.capabilities();
    expect(caps).toBe(2);
  });

  it("collapses concurrent capability requests into one flight", async () => {
    let caps = 0;
    const fetchImpl = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      if (url.searchParams.get("t") === "caps") {
        caps += 1;
        await new Promise((r) => setTimeout(r, 10));
      }
      return ok(url.searchParams.get("t") === "caps" ? CAPS : RSS);
    }) as unknown as typeof fetch;
    const p = provider(fetchImpl);
    await Promise.all([p.capabilities(), p.capabilities(), p.capabilities()]);
    expect(caps).toBe(1);
  });

  it("searches even when capabilities cannot be read", async () => {
    const fetchImpl = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      if (url.searchParams.get("t") === "caps")
        return new Response("nope", { status: 500 });
      return ok(RSS);
    }) as unknown as typeof fetch;
    const result = await provider(fetchImpl).search({
      kind: "search",
      term: "x",
    });
    expect(result.releases).toHaveLength(1);
  });

  it("passes offset and limit through for paging", async () => {
    let searchUrl: URL | undefined;
    const fetchImpl = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      if (url.searchParams.get("t") === "caps") return ok(CAPS);
      searchUrl = url;
      return ok(RSS);
    }) as unknown as typeof fetch;
    const result = await provider(fetchImpl).search({
      kind: "search",
      term: "x",
      limit: 25,
      offset: 50,
    });
    expect(searchUrl?.searchParams.get("limit")).toBe("25");
    expect(searchUrl?.searchParams.get("offset")).toBe("50");
    expect(result.offset).toBe(50);
    expect(result.limit).toBe(25);
  });

  describe("failures", () => {
    const failing = (status: number) =>
      provider(
        vi.fn(async (input: URL | RequestInfo) =>
          new URL(String(input)).searchParams.get("t") === "caps"
            ? ok(CAPS)
            : new Response("body", { status }),
        ) as unknown as typeof fetch,
      );

    it.each([
      [401, "auth"],
      [403, "auth"],
      [404, "not-found"],
      [400, "bad-request"],
      [429, "rate-limited"],
      [500, "unavailable"],
      [503, "unavailable"],
    ])("classifies HTTP %s as %s", async (status, kind) => {
      await expect(
        failing(status).search({ kind: "search", term: "x" }),
      ).rejects.toMatchObject({ kind });
    });

    it("retries what can pass and gives up bounded", async () => {
      let searches = 0;
      const fetchImpl = vi.fn(async (input: URL | RequestInfo) => {
        const url = new URL(String(input));
        if (url.searchParams.get("t") === "caps") return ok(CAPS);
        searches += 1;
        return new Response("", { status: 503 });
      }) as unknown as typeof fetch;
      await expect(
        provider(fetchImpl, { maxAttempts: 3 }).search({
          kind: "search",
          term: "x",
        }),
      ).rejects.toMatchObject({ kind: "unavailable" });
      expect(searches).toBe(3);
    });

    it("does not retry a refusal that repeating cannot fix", async () => {
      let searches = 0;
      const fetchImpl = vi.fn(async (input: URL | RequestInfo) => {
        const url = new URL(String(input));
        if (url.searchParams.get("t") === "caps") return ok(CAPS);
        searches += 1;
        return new Response("", { status: 401 });
      }) as unknown as typeof fetch;
      await expect(
        provider(fetchImpl).search({ kind: "search", term: "x" }),
      ).rejects.toMatchObject({
        kind: "auth",
      });
      expect(searches).toBe(1);
    });

    it("succeeds when a retry succeeds", async () => {
      let searches = 0;
      const fetchImpl = vi.fn(async (input: URL | RequestInfo) => {
        const url = new URL(String(input));
        if (url.searchParams.get("t") === "caps") return ok(CAPS);
        searches += 1;
        return searches === 1 ? new Response("", { status: 503 }) : ok(RSS);
      }) as unknown as typeof fetch;
      const result = await provider(fetchImpl).search({
        kind: "search",
        term: "x",
      });
      expect(result.releases).toHaveLength(1);
      expect(searches).toBe(2);
    });

    it("carries a Retry-After the provider supplied", async () => {
      const fetchImpl = vi.fn(async (input: URL | RequestInfo) =>
        new URL(String(input)).searchParams.get("t") === "caps"
          ? ok(CAPS)
          : new Response("", {
              status: 429,
              headers: { "retry-after": "120" },
            }),
      ) as unknown as typeof fetch;
      await expect(
        provider(fetchImpl, { maxAttempts: 1 }).search({
          kind: "search",
          term: "x",
        }),
      ).rejects.toMatchObject({
        kind: "rate-limited",
        providerCode: "retry-after:120",
      });
    });

    it("reports a timeout as a timeout", async () => {
      const fetchImpl = vi.fn(
        (_input: URL | RequestInfo, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(
                Object.assign(new Error("aborted"), { name: "AbortError" }),
              ),
            );
          }),
      ) as unknown as typeof fetch;
      await expect(
        provider(fetchImpl, { timeoutMs: 20, maxAttempts: 1 }).capabilities(),
      ).rejects.toMatchObject({ kind: "timeout" });
    });

    it("reports a caller's cancellation as cancellation, not as a timeout", async () => {
      const controller = new AbortController();
      const fetchImpl = vi.fn(
        (_input: URL | RequestInfo, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(
                Object.assign(new Error("aborted"), { name: "AbortError" }),
              ),
            );
          }),
      ) as unknown as typeof fetch;
      const pending = provider(fetchImpl, { maxAttempts: 1 }).capabilities(
        controller.signal,
      );
      controller.abort();
      await expect(pending).rejects.toMatchObject({ kind: "cancelled" });
    });

    it("never lets the key reach the error a caller sees", async () => {
      /*
       * A fetch rejection stringifies to a message containing the request URL,
       * and for Newznab that URL contains the credential. Nothing from the
       * original is carried through, so this holds for causes not listed here.
       */
      const fetchImpl = vi.fn(async (input: URL | RequestInfo) => {
        throw new Error(`connect ECONNREFUSED for ${String(input)}`);
      }) as unknown as typeof fetch;
      const error: unknown = await provider(fetchImpl, { maxAttempts: 1 })
        .search({ kind: "search", term: "x" })
        .then(
          () => undefined,
          (e: unknown) => e,
        );
      expect(error).toBeInstanceOf(IndexerError);
      const failure = error as IndexerError;
      expect(
        JSON.stringify({ m: failure.message, s: failure.stack }),
      ).not.toContain(KEY);
    });

    it("refuses an implausibly large response", async () => {
      const fetchImpl = vi.fn(async (input: URL | RequestInfo) =>
        new URL(String(input)).searchParams.get("t") === "caps"
          ? ok(CAPS)
          : ok("x".repeat(9 * 1024 * 1024)),
      ) as unknown as typeof fetch;
      await expect(
        provider(fetchImpl).search({ kind: "search", term: "x" }),
      ).rejects.toMatchObject({
        kind: "malformed-response",
      });
    });

    it("refuses to exist without a key at all", () => {
      expect(() =>
        provider(vi.fn() as unknown as typeof fetch, { apiKey: "  " }),
      ).toThrow(/API key/);
    });
  });
});
