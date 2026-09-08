// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseSabnzbdConfig } from "./acquisitionConfig";

const KEY = "SEYIRLIK_SABNZBD_API_KEY";

/** `null` means the variable is not set at all; a default supplies a key. */
function environment(
  declaration: unknown,
  key: string | null = "k".repeat(32),
): NodeJS.ProcessEnv {
  return {
    ...(declaration === undefined
      ? {}
      : {
          SEYIRLIK_SABNZBD:
            typeof declaration === "string"
              ? declaration
              : JSON.stringify(declaration),
        }),
    ...(key === null ? {} : { [KEY]: key }),
  } as NodeJS.ProcessEnv;
}

describe("declaring the download client", () => {
  it("returns nothing when no client is configured", () => {
    // A media server with no downloader is a media server, not a broken one.
    expect(parseSabnzbdConfig(environment(undefined))).toBeUndefined();
    expect(parseSabnzbdConfig(environment("   "))).toBeUndefined();
  });

  it("reads a complete declaration", () => {
    const config = parseSabnzbdConfig(
      environment({
        baseUrl: "http://127.0.0.1:8080/sabnzbd/",
        apiKeyEnv: KEY,
        category: "Seyirlik",
        timeoutMs: 20_000,
      }),
    );
    expect(config).toEqual({
      baseUrl: "http://127.0.0.1:8080/sabnzbd",
      apiKeyEnv: KEY,
      category: "seyirlik",
      timeoutMs: 20_000,
    });
  });

  it("names the variable that holds the key, and never the key", () => {
    const config = parseSabnzbdConfig(
      environment({ baseUrl: "http://127.0.0.1:8080", apiKeyEnv: KEY }),
    );
    expect(JSON.stringify(config)).not.toContain("k".repeat(32));
    expect(config?.apiKeyEnv).toBe(KEY);
  });

  it("files jobs under its own category by default", () => {
    // The ownership marker: Radarr and Sonarr use theirs, this uses this.
    const config = parseSabnzbdConfig(
      environment({ baseUrl: "http://127.0.0.1:8080", apiKeyEnv: KEY }),
    );
    expect(config?.category).toBe("seyirlik");
  });

  it("refuses a declared client whose key is missing", () => {
    /*
     * The failure this prevents is the quiet one: a configured downloader
     * whose submissions all fail authentication would present as downloads
     * that simply never start.
     */
    expect(() =>
      parseSabnzbdConfig(
        environment({ baseUrl: "http://127.0.0.1:8080", apiKeyEnv: KEY }, null),
      ),
    ).toThrow(new RegExp(`${KEY} is empty`));
    expect(() =>
      parseSabnzbdConfig(
        environment({ baseUrl: "http://127.0.0.1:8080", apiKeyEnv: KEY }, "  "),
      ),
    ).toThrow(/is empty/);
  });

  it.each([
    ["not json", "{"],
    ["an array", "[]"],
    ["a bare string", '"http://127.0.0.1:8080"'],
  ])("refuses %s", (_name, raw) => {
    expect(() => parseSabnzbdConfig(environment(raw))).toThrow(
      /SEYIRLIK_SABNZBD is invalid/,
    );
  });

  it.each([
    ["a relative baseUrl", { baseUrl: "/sabnzbd", apiKeyEnv: KEY }],
    ["a missing baseUrl", { apiKeyEnv: KEY }],
    ["a non-http scheme", { baseUrl: "file:///etc/passwd", apiKeyEnv: KEY }],
    ["a missing apiKeyEnv", { baseUrl: "http://127.0.0.1:8080" }],
    [
      "an apiKeyEnv that is not a variable name",
      { baseUrl: "http://127.0.0.1:8080", apiKeyEnv: "my key" },
    ],
    [
      "a category with a path separator in it",
      {
        baseUrl: "http://127.0.0.1:8080",
        apiKeyEnv: KEY,
        category: "seyirlik/../radarr",
      },
    ],
    [
      "a negative timeout",
      { baseUrl: "http://127.0.0.1:8080", apiKeyEnv: KEY, timeoutMs: -1 },
    ],
    [
      "a fractional timeout",
      { baseUrl: "http://127.0.0.1:8080", apiKeyEnv: KEY, timeoutMs: 1.5 },
    ],
  ])("refuses %s at startup", (_name, declaration) => {
    expect(() => parseSabnzbdConfig(environment(declaration))).toThrow(
      /SEYIRLIK_SABNZBD is invalid/,
    );
  });
});
