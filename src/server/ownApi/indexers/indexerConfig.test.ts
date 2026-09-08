// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseIndexerConfig } from "./indexerConfig";

const KEY_ENV = "SEYIRLIK_INDEXER_APIKEY_NZBGEEK";
const entry = {
  id: "nzbgeek",
  name: "NZBgeek",
  type: "newznab",
  baseUrl: "https://api.example.invalid",
  apiPath: "/api",
  protocol: "usenet",
  apiKeyEnv: KEY_ENV,
  categories: { movie: [2000, 2045], tv: [5000] },
};

const env = (
  indexers: unknown,
  extra: NodeJS.ProcessEnv = { [KEY_ENV]: "k".repeat(32) },
): NodeJS.ProcessEnv => ({
  SEYIRLIK_INDEXERS: JSON.stringify(indexers),
  ...extra,
});

describe("reading the indexer declaration", () => {
  it("reads a complete entry", () => {
    const [parsed] = parseIndexerConfig(env([entry]));
    expect(parsed).toMatchObject({
      id: "nzbgeek",
      name: "NZBgeek",
      type: "newznab",
      baseUrl: "https://api.example.invalid",
      apiPath: "/api",
      protocol: "usenet",
      enabled: true,
      apiKeyEnv: KEY_ENV,
    });
    expect(parsed?.categories.movie).toEqual([2000, 2045]);
  });

  it("holds the variable name, never the key itself", () => {
    const [parsed] = parseIndexerConfig(env([entry]));
    expect(JSON.stringify(parsed)).not.toContain("k".repeat(32));
    expect(parsed?.apiKeyEnv).toBe(KEY_ENV);
  });

  it("treats no declaration as no indexers rather than an error", () => {
    expect(parseIndexerConfig({})).toEqual([]);
    expect(parseIndexerConfig({ SEYIRLIK_INDEXERS: "   " })).toEqual([]);
  });

  it("defaults the optional parts", () => {
    const [parsed] = parseIndexerConfig(
      env([{ id: "x", baseUrl: "https://x.invalid", apiKeyEnv: KEY_ENV }]),
    );
    expect(parsed).toMatchObject({
      name: "x",
      apiPath: "/api",
      protocol: "usenet",
      enabled: true,
    });
    expect(parsed?.categories).toEqual({ movie: [], tv: [] });
  });

  it("trims a trailing slash so the request path is not doubled", () => {
    const [parsed] = parseIndexerConfig(
      env([{ ...entry, baseUrl: "https://api.example.invalid/" }]),
    );
    expect(parsed?.baseUrl).toBe("https://api.example.invalid");
  });

  it("allows a disabled entry with no key, because it is not going to be used", () => {
    const [parsed] = parseIndexerConfig(
      env([{ ...entry, enabled: false }], {}),
    );
    expect(parsed?.enabled).toBe(false);
  });

  describe("what it refuses at startup", () => {
    it("refuses an enabled indexer whose key is missing", () => {
      /*
       * Otherwise this surfaces as an indexer that returns nothing, which
       * reads like an empty library rather than a misconfiguration.
       */
      expect(() => parseIndexerConfig(env([entry], {}))).toThrow(
        new RegExp(`enabled but ${KEY_ENV} is empty`),
      );
    });

    it.each([
      ["invalid JSON", "not json", /not valid JSON/],
      ["a non-array", JSON.stringify({}), /must be an array/],
    ])("refuses %s", (_label, raw, matcher) => {
      expect(() => parseIndexerConfig({ SEYIRLIK_INDEXERS: raw })).toThrow(
        matcher,
      );
    });

    it.each([
      [{ ...entry, id: "Has Spaces" }, /needs an id/],
      [{ ...entry, id: "" }, /needs an id/],
      [{ ...entry, baseUrl: "notaurl" }, /absolute baseUrl/],
      [{ ...entry, baseUrl: "ftp://x.invalid" }, /http or https/],
      [{ ...entry, apiKeyEnv: "lowercase" }, /apiKeyEnv/],
      [{ ...entry, apiKeyEnv: undefined }, /apiKeyEnv/],
      [{ ...entry, type: "torznab-of-the-future" }, /type this build/],
      [{ ...entry, timeoutMs: -1 }, /timeoutMs/],
      [{ ...entry, categories: { movie: ["2000"] } }, /whole category ids/],
    ])("refuses a malformed entry (%#)", (broken, matcher) => {
      expect(() => parseIndexerConfig(env([broken]))).toThrow(matcher);
    });

    it("refuses two entries sharing an id", () => {
      expect(() => parseIndexerConfig(env([entry, entry]))).toThrow(
        /appears more than once/,
      );
    });
  });
});
