// @vitest-environment node
import { describe, expect, it } from "vitest";
import { IndexerError } from "./indexerTypes";
import {
  buildSearchParams,
  classifyNewznabCode,
  parseCapabilities,
  parseSearchResults,
} from "./newznab";

const CAPS = `<?xml version="1.0" encoding="UTF-8"?>
<caps>
  <server title="NZBgeek" />
  <limits max="100" default="100" />
  <searching>
    <search available="yes" supportedParams="q" />
    <movie-search available="yes" supportedParams="q,imdbid" />
    <tv-search available="yes" supportedParams="q,tvdbid,season,ep" />
  </searching>
  <categories>
    <category id="2000" name="Movies">
      <subcat id="2040" name="Movies/HD" />
      <subcat id="2045" name="Movies/UHD" />
    </category>
    <category id="5000" name="TV">
      <subcat id="5040" name="TV/HD" />
    </category>
  </categories>
</caps>`;

const options = {
  indexerId: "ix-1",
  indexerName: "NZBgeek",
  protocol: "usenet" as const,
  offset: 0,
  limit: 50,
};

const searchXml = (
  items: string,
  total = "2",
) => `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:newznab="http://www.newznab.com/DTD/2010/feeds/attributes/">
  <channel>
    <title>NZBgeek</title>
    <newznab:response offset="0" total="${total}" />
    ${items}
  </channel>
</rss>`;

const item = `<item>
  <title>Some.Film.2026.2160p.UHD.BluRay.x265-GROUP</title>
  <guid isPermaLink="true">https://api.example.invalid/details/abc123</guid>
  <link>https://api.example.invalid/api?t=get&amp;id=abc123&amp;apikey=SECRETKEYVALUE</link>
  <comments>https://example.invalid/geekseek/abc123</comments>
  <pubDate>Mon, 07 Sep 2026 21:04:21 +0000</pubDate>
  <enclosure url="https://api.example.invalid/api?t=get&amp;id=abc123" length="64424509440" type="application/x-nzb" />
  <newznab:attr name="category" value="2000" />
  <newznab:attr name="category" value="2045" />
  <newznab:attr name="size" value="64424509440" />
  <newznab:attr name="grabs" value="42" />
  <newznab:attr name="usenetdate" value="Mon, 07 Sep 2026 20:00:00 +0000" />
</item>`;

describe("reading Newznab capabilities", () => {
  it("takes limits, modes and the category tree from the provider rather than assuming them", () => {
    const caps = parseCapabilities(CAPS, () => 1_700_000_000_000);
    expect(caps.serverTitle).toBe("NZBgeek");
    expect(caps.limits).toEqual({ max: 100, default: 100 });
    expect(caps.modes.movie).toEqual({
      available: true,
      supportedParams: ["q", "imdbid"],
    });
    expect(caps.modes.tv.supportedParams).toContain("season");
    expect(caps.categories.map((c) => c.id)).toEqual([2000, 5000]);
    expect(caps.categories[0]!.subcategories.map((c) => c.id)).toEqual([
      2040, 2045,
    ]);
    expect(caps.retrievedAtMs).toBe(1_700_000_000_000);
  });

  it("falls back to a conservative limit when the provider states none", () => {
    expect(parseCapabilities(`<caps><searching/></caps>`).limits).toEqual({
      max: 100,
      default: 100,
    });
  });

  it("refuses a document that is not capabilities", () => {
    expect(() => parseCapabilities(`<rss><channel/></rss>`)).toThrow(
      /capabilities document/,
    );
  });
});

describe("reading Newznab search results", () => {
  it("normalises a release, keeping the title exactly as written", () => {
    const result = parseSearchResults(searchXml(item), options);
    expect(result.totalAvailable).toBe(2);
    expect(result.releases).toHaveLength(1);
    const release = result.releases[0]!;
    expect(release.title).toBe("Some.Film.2026.2160p.UHD.BluRay.x265-GROUP");
    expect(release.indexerId).toBe("ix-1");
    expect(release.guid).toBe("https://api.example.invalid/details/abc123");
    expect(release.sizeBytes).toBe(64_424_509_440);
    expect(release.categoryIds).toEqual([2000, 2045]);
    expect(release.grabs).toBe(42);
    expect(release.detailsUrl).toBe("https://example.invalid/geekseek/abc123");
    expect(release.publishedAtMs).toBe(
      Date.parse("Mon, 07 Sep 2026 21:04:21 +0000"),
    );
    // Usenet has no swarm; inventing zeroes would be a lie a later phase reads.
    expect(release.seeders).toBeUndefined();
    expect(release.leechers).toBeUndefined();
  });

  it("keeps every provider attribute in the contained extension area", () => {
    const release = parseSearchResults(searchXml(item), options).releases[0]!;
    expect(release.attributes.usenetdate).toBe(
      "Mon, 07 Sep 2026 20:00:00 +0000",
    );
    expect(release.attributes.size).toBe("64424509440");
  });

  it("reads an empty result as empty rather than as a failure", () => {
    const result = parseSearchResults(searchXml("", "0"), options);
    expect(result.releases).toEqual([]);
    expect(result.totalAvailable).toBe(0);
  });

  it("skips an item with no title, identity or link instead of inventing one", () => {
    const result = parseSearchResults(
      searchXml(`<item><title>No link</title><guid>x</guid></item>` + item),
      options,
    );
    expect(result.releases.map((r) => r.title)).toEqual([
      "Some.Film.2026.2160p.UHD.BluRay.x265-GROUP",
    ]);
  });

  it("survives a release missing every optional field", () => {
    const bare = `<item><title>Bare</title><guid>g1</guid><link>https://x.invalid/nzb</link></item>`;
    const release = parseSearchResults(searchXml(bare, "1"), options)
      .releases[0]!;
    expect(release.title).toBe("Bare");
    expect(release.sizeBytes).toBeUndefined();
    expect(release.categoryIds).toEqual([]);
    expect(release.attributes).toEqual({});
  });

  it("reads torrent swarm fields when a provider supplies them", () => {
    const torrent = `<item><title>T</title><guid>g</guid><link>https://x.invalid/t</link>
      <newznab:attr name="seeders" value="12" /><newznab:attr name="peers" value="20" /></item>`;
    const release = parseSearchResults(searchXml(torrent, "1"), {
      ...options,
      protocol: "torrent",
    }).releases[0]!;
    expect(release.seeders).toBe(12);
    expect(release.leechers).toBe(20);
  });

  it("refuses a document that is not RSS", () => {
    expect(() => parseSearchResults(`<caps/>`, options)).toThrow(
      /RSS document/,
    );
  });

  it("reports malformed XML as malformed rather than as an empty search", () => {
    const error = (() => {
      try {
        parseSearchResults("<rss><channel><item>", options);
      } catch (e) {
        return e as IndexerError;
      }
      return undefined;
    })();
    expect(error?.kind).toBe("malformed-response");
  });
});

describe("the provider's own error envelope", () => {
  it.each([
    ["100", "auth"],
    ["101", "auth"],
    ["102", "auth"],
    ["200", "bad-request"],
    ["201", "bad-request"],
    ["202", "bad-request"],
    ["203", "bad-request"],
    ["300", "not-found"],
    ["500", "rate-limited"],
    ["910", "provider-error"],
    ["", "provider-error"],
  ])("classifies code %s as %s", (code, kind) => {
    expect(classifyNewznabCode(code)).toBe(kind);
  });

  it("is raised from a search that answered HTTP 200, not treated as no results", () => {
    /*
     * Newznab reports refusal with a 200 and an <error> body. A status-only
     * check would read bad credentials as a successful empty search, which is
     * the failure that looks like "the indexer has nothing" for ever.
     */
    const body = `<?xml version="1.0"?><error code="100" description="Incorrect user credentials" />`;
    const error = (() => {
      try {
        parseSearchResults(body, options);
      } catch (e) {
        return e as IndexerError;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(IndexerError);
    expect(error?.kind).toBe("auth");
    expect(error?.providerCode).toBe("100");
    expect(error?.message).toBe("Incorrect user credentials");
  });

  it("is raised from capabilities too", () => {
    expect(() =>
      parseCapabilities(
        `<error code="500" description="Request limit reached" />`,
      ),
    ).toThrow(/Request limit reached/);
  });
});

describe("building the request", () => {
  const caps = parseCapabilities(CAPS);

  it("uses the provider's own function names", () => {
    expect(
      buildSearchParams({ kind: "search", term: "x" }, caps).get("t"),
    ).toBe("search");
    expect(buildSearchParams({ kind: "movie", term: "x" }, caps).get("t")).toBe(
      "movie",
    );
    expect(buildSearchParams({ kind: "tv", term: "x" }, caps).get("t")).toBe(
      "tvsearch",
    );
  });

  it("passes identifiers, season and episode through", () => {
    const params = buildSearchParams(
      {
        kind: "tv",
        tvdbId: "12345",
        season: 2,
        episode: 5,
        categoryIds: [5040, 5045],
      },
      caps,
    );
    expect(params.get("tvdbid")).toBe("12345");
    expect(params.get("season")).toBe("2");
    expect(params.get("ep")).toBe("5");
    expect(params.get("cat")).toBe("5040,5045");
  });

  it("strips the tt prefix an IMDb id is usually written with", () => {
    expect(
      buildSearchParams({ kind: "movie", imdbId: "tt0111161" }, caps).get(
        "imdbid",
      ),
    ).toBe("0111161");
  });

  it("clamps the limit to what the provider said it allows", () => {
    expect(
      buildSearchParams({ kind: "search", limit: 5000 }, caps).get("limit"),
    ).toBe("100");
    expect(
      buildSearchParams({ kind: "search", limit: 0 }, caps).get("limit"),
    ).toBe("1");
  });

  it("never contains the credential", () => {
    const params = buildSearchParams(
      { kind: "search", term: "anything" },
      caps,
    );
    expect([...params.keys()]).not.toContain("apikey");
  });
});
