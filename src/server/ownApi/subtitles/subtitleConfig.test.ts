import { describe, expect, it } from "vitest";
import { parseSubtitleConfig } from "./subtitleConfig";

/**
 * The declaration that turns the subsystem on.
 *
 * Absent is not an error. A server that is not fetching subtitles is a
 * perfectly good media server, and this phase is additive — so the only way to
 * reach a provider or write beside media is to have said so deliberately.
 */

const parse = (value: string | undefined) =>
  parseSubtitleConfig(value === undefined ? {} : { SEYIRLIK_SUBTITLES: value });

const root = process.platform === "win32" ? "C:\\library" : "/library";

describe("declaring the subtitle subsystem", () => {
  it("is off when nothing is declared", () => {
    expect(parse(undefined)).toBeUndefined();
    expect(parse("")).toBeUndefined();
    expect(parse("   ")).toBeUndefined();
  });

  it("reads a complete declaration", () => {
    const config = parse(
      JSON.stringify({
        libraryRoot: root,
        providerIds: ["turkcealtyazilar"],
        timeoutMs: 15_000,
      }),
    );
    expect(config).toMatchObject({
      providerIds: ["turkcealtyazilar"],
      timeoutMs: 15_000,
    });
    expect(config?.libraryRoot).toBe(root);
  });

  it("defaults the timeout rather than leaving a provider unbounded", () => {
    const config = parse(
      JSON.stringify({ libraryRoot: root, providerIds: [] }),
    );
    expect(config?.timeoutMs).toBe(30_000);
  });

  /*
   * A relative root would resolve against whatever directory the service
   * happened to start in, which is not a root anybody authorised. The same
   * reasoning as the importer's download root.
   */
  it("refuses a root that is not absolute", () => {
    expect(() =>
      parse(JSON.stringify({ libraryRoot: "library", providerIds: [] })),
    ).toThrow(/absolute libraryRoot/);
  });

  it("refuses a root carrying a null byte", () => {
    expect(() =>
      parse(JSON.stringify({ libraryRoot: `${root}\u0000x`, providerIds: [] })),
    ).toThrow();
  });

  it.each([["not json at all"], ["[]"], ["null"], ['"a string"']])(
    "refuses %s",
    (raw) => {
      expect(() => parse(raw)).toThrow();
    },
  );

  /*
   * An unknown key is refused rather than ignored. A typo in a declaration that
   * silently does nothing is how a deployment ends up believing it configured
   * something it did not.
   */
  it("refuses a key it does not recognise", () => {
    expect(() =>
      parse(
        JSON.stringify({
          libraryRoot: root,
          providerIds: [],
          providerApiKey: "secret",
        }),
      ),
    ).toThrow();
  });

  it("refuses provider ids that are not plain identifiers", () => {
    for (const providerIds of [
      ["Not Lowercase"],
      ["has space"],
      ["-leading-dash"],
      [""],
      [42],
      ["a".repeat(65)],
    ]) {
      expect(() =>
        parse(JSON.stringify({ libraryRoot: root, providerIds })),
      ).toThrow();
    }
  });

  it("refuses the same provider named twice", () => {
    expect(() =>
      parse(JSON.stringify({ libraryRoot: root, providerIds: ["one", "one"] })),
    ).toThrow();
  });

  it("refuses a timeout that is not a bounded whole number", () => {
    for (const timeoutMs of [0, -1, 1.5, 300_001, "30000", null]) {
      expect(() =>
        parse(
          JSON.stringify({ libraryRoot: root, providerIds: [], timeoutMs }),
        ),
      ).toThrow();
    }
  });

  /* Secrets are not configuration. Session material lives behind the manager. */
  it("says plainly that secrets do not belong here", () => {
    expect(() =>
      parse(
        JSON.stringify({ libraryRoot: root, providerIds: [], cookie: "x" }),
      ),
    ).toThrow(/secrets are not configuration fields/);
  });
});
