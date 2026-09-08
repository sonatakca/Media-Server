// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  createProviderSession,
  type SubtitleCandidate,
  type ProviderSessionManager,
  type SubtitleProvider,
  type SubtitleQuery,
} from "./subtitleProvider";
import { runSubtitlePipeline } from "./subtitlePipeline";
import { validateSubtitle } from "./subtitlePayload";
import { assessCandidate, orderCandidates } from "./subtitleSelection";
import { normalizeWant } from "./subtitleState";

const query: SubtitleQuery = {
  title: "Example",
  year: 2026,
  season: null,
  episode: null,
  language: "tur",
  wantForced: false,
  releaseTitle: "Example.2026.1080p.WEB-DL-GROUP",
  releaseGroup: null,
  source: null,
  resolution: null,
  videoHash: null,
  durationSeconds: 100,
};
const want = normalizeWant({ language: "tr" });
const candidate: SubtitleCandidate = {
  identity: query,
  providerId: "mock",
  candidateId: "one",
  language: "tr",
  format: "srt",
  releaseTitle: query.releaseTitle,
  releaseGroup: null,
  source: null,
  resolution: null,
  hashMatched: false,
  providerRating: null,
  forced: false,
  hearingImpaired: false,
};
const payload = {
  bytes: new TextEncoder().encode(
    "1\n00:00:01,000 --> 00:00:02,000\nMerhaba\n",
  ),
  declaredFormat: "srt" as const,
  declaredFileName: "../../ignored.srt",
};
function setup() {
  const provider: SubtitleProvider = {
    id: "mock",
    label: "Mock",
    requiresSession: false,
    rank: 1,
    languages: null,
    search: vi.fn(async () => ({ outcome: "ok" as const, value: [candidate] })),
    download: vi.fn(async () => ({ outcome: "ok" as const, value: payload })),
  };
  return {
    mediaFileId: "media-id",
    query,
    want,
    embeddedTracks: [],
    providers: [provider],
    sessions: {
      acquire: vi.fn<ProviderSessionManager["acquire"]>(async () => ({
        outcome: "needs-authentication" as const,
        providerId: "mock",
        reason: "secret",
        authenticateAt: null,
      })),
      invalidate: vi.fn(async () => {}),
    },
    storage: {
      inspect: vi.fn(async () => []),
      install: vi.fn(async () => ({
        outcome: "installed" as const,
        relativePath: "Example.tur.srt",
        sha256: "digest",
        cueCount: 3,
      })),
    },
    timeoutMs: 30,
  };
}

describe("subtitle pipeline", () => {
  it("normalizes, scores and installs by media ID, with real phase counters", async () => {
    const input = setup();
    const progress = vi.fn();
    expect(await runSubtitlePipeline({ ...input, progress })).toMatchObject({
      outcome: "installed",
    });
    expect(input.storage.install).toHaveBeenCalledWith(
      expect.objectContaining({
        mediaFileId: "media-id",
        language: "tur",
        flags: expect.objectContaining({ candidateId: "one" }),
        payload,
        replace: false,
      }),
    );
    expect(progress).toHaveBeenLastCalledWith({
      phase: "installing",
      completed: 1,
      total: 1,
    });
  });
  it("keeps an existing embedded subtitle without contacting providers", async () => {
    const input = setup();
    expect(
      await runSubtitlePipeline({
        ...input,
        embeddedTracks: [
          {
            origin: "embedded",
            language: "tur",
            forced: false,
            hearingImpaired: false,
            managed: false,
            format: "srt",
            relativePath: null,
            streamIndex: 2,
          },
        ],
      }),
    ).toEqual({ outcome: "existing" });
    expect(input.providers[0]!.search).not.toHaveBeenCalled();
  });
  it("reports no candidate and does not write", async () => {
    const input = setup();
    input.providers[0]!.search = async () => ({ outcome: "empty" });
    expect(await runSubtitlePipeline(input)).toEqual({
      outcome: "unavailable",
    });
    expect(input.storage.install).not.toHaveBeenCalled();
  });
  it("bounds an uncooperative provider and aborts its signal", async () => {
    const input = setup();
    let signal: AbortSignal | undefined;
    input.providers[0]!.search = async (_q, _s, s) => {
      signal = s;
      return new Promise(() => {});
    };
    expect(await runSubtitlePipeline(input)).toMatchObject({
      outcome: "error",
      failure: "provider-timeout",
    });
    expect(signal?.aborted).toBe(true);
    expect(input.storage.install).not.toHaveBeenCalled();
  });
  it("cancels mid-download and ignores late payloads", async () => {
    const input = setup();
    const controller = new AbortController();
    input.providers[0]!.download = async () => {
      controller.abort();
      return { outcome: "ok", value: payload };
    };
    expect(
      await runSubtitlePipeline({ ...input, signal: controller.signal }),
    ).toEqual({ outcome: "cancelled" });
    expect(input.storage.install).not.toHaveBeenCalled();
  });
  it("returns authentication as resumable state, without exposing provider text", async () => {
    const input = setup();
    input.providers[0] = { ...input.providers[0]!, requiresSession: true };
    expect(await runSubtitlePipeline(input)).toEqual({
      outcome: "needs-authentication",
      providerId: "mock",
    });
    expect(input.providers[0]!.search).not.toHaveBeenCalled();
    input.sessions.acquire = vi.fn(async () => ({
      outcome: "ready",
      session: createProviderSession({
        providerId: "mock",
        cookie: "secret",
        userAgent: "browser",
      }),
    }));
    expect(await runSubtitlePipeline(input)).toMatchObject({
      outcome: "installed",
    });
  });
  it("invalidates a rejected session and does not turn it into a job failure", async () => {
    const input = setup();
    input.providers[0] = { ...input.providers[0]!, requiresSession: true };
    const sessions = {
      ...input.sessions,
      acquire: async () => ({
        outcome: "ready" as const,
        session: createProviderSession({
          providerId: "mock",
          cookie: "secret",
          userAgent: "browser",
        }),
      }),
    };
    input.providers[0]!.download = async () => ({
      outcome: "needs-authentication",
      reason: "secret cookie",
      authenticateAt: "secret url",
    });
    expect(await runSubtitlePipeline({ ...input, sessions })).toEqual({
      outcome: "needs-authentication",
      providerId: "mock",
    });
    expect(sessions.invalidate).toHaveBeenCalledWith(
      "mock",
      "Session rejected.",
    );
  });
  it("does not pass expired or mismatched sessions to a provider", async () => {
    for (const over of [{ expiresAtMs: 1 }, { providerId: "another" }]) {
      const input = setup();
      input.providers[0] = { ...input.providers[0]!, requiresSession: true };
      const sessions = {
        ...input.sessions,
        acquire: async () => ({
          outcome: "ready" as const,
          session: createProviderSession({
            providerId: "mock",
            cookie: "secret",
            userAgent: "browser",
            ...over,
          }),
        }),
      };
      expect(await runSubtitlePipeline({ ...input, sessions })).toMatchObject({
        outcome: "needs-authentication",
      });
      expect(input.providers[0]!.search).not.toHaveBeenCalled();
    }
  });
  it("sanitizes thrown provider errors", async () => {
    const input = setup();
    input.providers[0]!.search = async () => {
      throw new Error("cookie=secret; cf_clearance=LEAKED");
    };
    const result = await runSubtitlePipeline(input);
    expect(result).toMatchObject({
      outcome: "error",
      failure: "provider-error",
    });
    /*
     * The whole result, not just the field that was checked before. A provider
     * throwing with its own session material in the message is the likeliest
     * way a cookie reaches a log, and the classification carrying a reason now
     * means there is somewhere new for it to hide.
     */
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(JSON.stringify(result)).not.toContain("LEAKED");
  });
  it("rejects invalid payloads before storage and tries another candidate", async () => {
    const input = setup();
    input.providers[0]!.search = async () => ({
      outcome: "ok",
      value: [candidate, { ...candidate, candidateId: "two" }],
    });
    input.providers[0]!.download = async (c) => ({
      outcome: "ok",
      value:
        c.candidateId === "one"
          ? {
              ...payload,
              bytes: new TextEncoder().encode("<html>login</html>"),
            }
          : payload,
    });
    expect(await runSubtitlePipeline(input)).toMatchObject({
      outcome: "installed",
    });
    expect(input.storage.install).toHaveBeenCalledTimes(1);
  });
  it("preserves storage failures and duplicate outcomes", async () => {
    for (const result of [
      {
        outcome: "error",
        failure: "destination-locked",
        reason: "The destination is held open.",
      },
      {
        outcome: "duplicate",
        relativePath: "Example.tur.srt",
        sha256: "digest",
      },
    ] as const) {
      const input = setup();
      expect(
        await runSubtitlePipeline({
          ...input,
          storage: { ...input.storage, install: async () => result },
        }),
      ).toMatchObject(result);
    }
  });
});

describe("selection", () => {
  it("requires exact identity, language and forced status even with a hash match", () => {
    for (const over of [
      { identity: undefined },
      { identity: { ...query, episode: 2 } },
      { identity: { ...query, year: 2025 } },
      { language: "eng" },
      { forced: true },
      { providerId: "other" },
    ]) {
      const assessment = assessCandidate(
        query,
        want,
        { ...candidate, hashMatched: true, ...over },
        setup().providers[0]!,
      );
      expect(assessment.accepted).toBe(false);
      // Every rejection says why, so a search that installs nothing explains it.
      if (!assessment.accepted) expect(assessment.reason).toBeTruthy();
    }
  });
  it("uses release facts and returns explainable deterministic scores", () => {
    const provider = setup().providers[0]!;
    const goodAssessment = assessCandidate(query, want, candidate, provider);
    const worseAssessment = assessCandidate(
      query,
      want,
      { ...candidate, candidateId: "two", releaseTitle: null },
      provider,
    );
    expect(goodAssessment.accepted && worseAssessment.accepted).toBe(true);
    if (!goodAssessment.accepted || !worseAssessment.accepted) return;
    const good = goodAssessment.scored;
    const worse = worseAssessment.scored;
    expect(good.score.total).toBeGreaterThan(worse.score.total);
    expect(good.score.reasons).toContain("The same release group.");
    expect(orderCandidates([worse, good])[0]).toBe(good);
  });
});

describe("payload validation", () => {
  it("accepts UTF-8 SRT and VTT without using the supplied filename", () => {
    expect(validateSubtitle(payload).format).toBe("srt");
    expect(
      validateSubtitle({
        ...payload,
        declaredFormat: "vtt",
        bytes: new TextEncoder().encode(
          "WEBVTT\n\n00:01.000 --> 00:02.000\nMerhaba",
        ),
      }).format,
    ).toBe("vtt");
  });
  it.each([
    "<html>error</html>",
    "1\n00:00:03,000 --> 00:00:02,000\nBad",
    "1\n00:60:01,000 --> 00:61:02,000\nBad",
    "1\n00:00:01,000 --> 00:00:02,000\n<script>bad</script>",
    "1\n00:00:01,000 --> 00:00:02,000\n",
    "{garbage}",
  ])("rejects malformed or active content: %s", (text) => {
    expect(() =>
      validateSubtitle({ ...payload, bytes: new TextEncoder().encode(text) }),
    ).toThrow();
  });
  it("rejects binary, oversized and unsupported payloads", () => {
    for (const bytes of [
      new Uint8Array([0xff]),
      new Uint8Array(4 * 1024 * 1024 + 1),
    ])
      expect(() => validateSubtitle({ ...payload, bytes })).toThrow();
    expect(() =>
      validateSubtitle({ ...payload, declaredFormat: "ass" }),
    ).toThrow();
  });
});
