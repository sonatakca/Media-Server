import { describe, expect, it } from "vitest";
import {
  createProviderSession,
  providerCoversLanguage,
  providersFor,
  sessionIsExpired,
  type ProviderSession,
  type SubtitleProvider,
} from "./subtitleProvider";

/**
 * The provider boundary, and in particular the promise that session material
 * cannot be logged by accident.
 */

const session = (
  over: Partial<Parameters<typeof createProviderSession>[0]> = {},
) =>
  createProviderSession({
    providerId: "turkcealtyazilar",
    cookie: "cf_clearance=SUPER-SECRET-VALUE; session=ANOTHER-SECRET",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    ...over,
  });

describe("a provider session cannot be logged by accident", () => {
  /*
   * A leaked cookie is somebody's account. Every one of these is a real way
   * session material reaches a log file, and each has to be closed separately:
   * a structured logger reaches for `toJSON`, a template string reaches for
   * `toString`, and a spread reaches for enumerable properties.
   */
  it("does not appear in a template string", () => {
    expect(`${session()}`).toBe("[provider session withheld]");
    expect(`${session()}`).not.toContain("SUPER-SECRET-VALUE");
  });

  it("does not appear in JSON", () => {
    const json = JSON.stringify({ auth: session() });
    expect(json).not.toContain("SUPER-SECRET-VALUE");
    expect(json).not.toContain("ANOTHER-SECRET");
    expect(json).toContain("[provider session withheld]");
  });

  it("does not appear in a spread or in the object's own keys", () => {
    const spread = JSON.stringify({ ...session() });
    expect(spread).not.toContain("SUPER-SECRET-VALUE");
    expect(Object.keys(session())).not.toContain("cookie");
  });

  it("does not appear in the array or nested forms a logger produces", () => {
    expect(JSON.stringify([session()])).not.toContain("SUPER-SECRET-VALUE");
    expect(JSON.stringify({ a: { b: [session()] } })).not.toContain(
      "ANOTHER-SECRET",
    );
  });

  /* And it is still usable — a secret nothing can read is not a session. */
  it("yields its headers only through the method that says so", () => {
    const headers = session().revealHeaders();
    expect(headers.cookie).toContain("SUPER-SECRET-VALUE");
    expect(headers["user-agent"]).toContain("Mozilla/5.0");
  });

  /*
   * Cookie and user agent travel together because sending one without the
   * other is what makes a far end decide this is a different client and
   * challenge again.
   */
  it("always carries the user agent alongside the cookie", () => {
    const headers = session().revealHeaders();
    expect(Object.keys(headers).sort()).toContain("user-agent");
    expect(Object.keys(headers).sort()).toContain("cookie");
  });

  it("hands back a copy, so a caller cannot mutate the session's headers", () => {
    const live = session();
    const first = live.revealHeaders();
    (first as Record<string, string>).cookie = "tampered";
    expect(live.revealHeaders().cookie).toContain("SUPER-SECRET-VALUE");
  });

  it("lets extra headers be carried without displacing the two that matter", () => {
    const headers = session({
      extraHeaders: { referer: "https://example.invalid/", cookie: "ignored" },
    }).revealHeaders();
    expect(headers.referer).toBe("https://example.invalid/");
    expect(headers.cookie).toContain("SUPER-SECRET-VALUE");
  });
});

describe("when a session has aged out", () => {
  it("is not expired when the provider named no expiry", () => {
    expect(sessionIsExpired(session(), Date.now())).toBe(false);
  });

  it("is expired once the clock passes the stated time", () => {
    const s: ProviderSession = session({ expiresAtMs: 1_000 });
    expect(sessionIsExpired(s, 999)).toBe(false);
    expect(sessionIsExpired(s, 1_000)).toBe(true);
    expect(sessionIsExpired(s, 5_000)).toBe(true);
  });
});

describe("choosing which providers to ask", () => {
  const provider = (
    id: string,
    rank: number,
    languages: readonly string[] | null,
  ): SubtitleProvider =>
    ({
      id,
      label: id,
      requiresSession: false,
      rank,
      languages,
      search: async () => ({ outcome: "empty" }),
      download: async () => ({ outcome: "empty" }),
    }) satisfies SubtitleProvider;

  it("asks a provider only about languages it carries", () => {
    expect(providerCoversLanguage({ languages: ["tur"] }, "tur")).toBe(true);
    expect(providerCoversLanguage({ languages: ["tur"] }, "deu")).toBe(false);
    expect(providerCoversLanguage({ languages: null }, "deu")).toBe(true);
  });

  it("orders by rank, highest first", () => {
    const ordered = providersFor(
      [provider("low", 1, null), provider("high", 9, null)],
      "tur",
    );
    expect(ordered.map((p) => p.id)).toEqual(["high", "low"]);
  });

  /*
   * A stable order matters more than it looks: two runs of the same search
   * returning different subtitles reads as a scoring bug, and is not one.
   */
  it("breaks ties by id, so two runs agree", () => {
    const ordered = providersFor(
      [provider("zeta", 5, null), provider("alpha", 5, null)],
      "tur",
    );
    expect(ordered.map((p) => p.id)).toEqual(["alpha", "zeta"]);
  });

  it("leaves out a provider that cannot answer for the language at all", () => {
    const ordered = providersFor(
      [provider("turkish-only", 9, ["tur"]), provider("everything", 1, null)],
      "deu",
    );
    expect(ordered.map((p) => p.id)).toEqual(["everything"]);
  });
});
