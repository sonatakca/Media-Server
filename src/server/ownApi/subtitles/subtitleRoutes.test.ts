// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { RouteContext, RouteDefinition } from "../api/router";
import type { JobQueue } from "../tasks/jobQueue";
import { SUBTITLE_JOB_TYPES } from "./subtitleJobs";
import type {
  SubtitleAttemptRow,
  SubtitleRepository,
  SubtitleWantRow,
} from "./subtitleRepository";
import { createSubtitleRoutes } from "./subtitleRoutes";
import type { SubtitleWant } from "./subtitleState";

/**
 * The only surface a client can reach.
 *
 * Two things are being checked here rather than in the service: that a request
 * cannot name anything but a catalogue id and a policy — no path, no provider
 * URL, no destination — and that what comes back out carries an operator's
 * summary rather than the attempt's whole interior.
 */

const MEDIA = "22222222-3333-4444-8555-666666666666";
const ATTEMPT = "11111111-2222-4333-8444-555555555555";

function attemptRow(
  over: Partial<SubtitleAttemptRow> = {},
): SubtitleAttemptRow {
  return {
    id: ATTEMPT,
    wantId: "want-1",
    state: "wanted",
    attempt: 1,
    providerId: "synthetic",
    candidateId: "c1",
    score: 150,
    failureClass: null,
    failureDetail: null,
    awaitingProviderId: null,
    runAfter: null,
    ...over,
  };
}

function harness(over: { attempt?: SubtitleAttemptRow | null } = {}) {
  const wants: SubtitleWant[] = [];
  const enqueued: Record<string, unknown>[] = [];
  const repository = {
    ensureWant: vi.fn(async (mediaFileId: string, want: SubtitleWant) => {
      wants.push(want);
      return {
        id: "want-1",
        mediaFileId,
        language: want.language,
        forced: want.forced,
        hearingImpaired: want.hearingImpaired,
        active: true,
      } satisfies SubtitleWantRow;
    }),
    beginAttempt: vi.fn(async () => attemptRow()),
    getAttempt: vi.fn(async () =>
      over.attempt === undefined ? attemptRow() : over.attempt,
    ),
  } as unknown as SubtitleRepository;
  const queue = {
    enqueue: vi.fn(async (options: Record<string, unknown>) => {
      enqueued.push(options);
      return "job-1";
    }),
  } as unknown as JobQueue;
  return {
    routes: createSubtitleRoutes(repository, queue),
    wants,
    enqueued,
    repository,
  };
}

function route(
  routes: RouteDefinition[],
  method: string,
  path: string,
): RouteDefinition {
  const found = routes.find((r) => r.method === method && r.path === path);
  if (!found) throw new Error(`No route for ${method} ${path}`);
  return found;
}

interface Captured {
  status: number;
  payload: { data?: Record<string, unknown> } | undefined;
}

function invoke(
  definition: RouteDefinition,
  options: { body?: unknown; params?: Record<string, string> } = {},
): Promise<Captured> {
  const captured: Captured = { status: 0, payload: undefined };
  const context = {
    request: { once: () => undefined, off: () => undefined },
    response: {
      setHeader: () => undefined,
      end: (chunk?: string) => {
        captured.payload = chunk ? JSON.parse(chunk) : undefined;
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
    url: new URL("http://localhost/ownAPI/v1/subtitles"),
    params: options.params ?? {},
    method: definition.method,
    principal: { userId: "u", isAdministrator: true },
    requirePrincipal: () => ({ userId: "u", isAdministrator: true }),
    readJson: async () => options.body,
  } as unknown as RouteContext;
  return definition.handle(context).then(() => captured);
}

describe("asking for a subtitle", () => {
  it("is administrator-only, on every route", () => {
    for (const definition of harness().routes)
      expect(definition.access).toBe("admin");
  });

  it("queues the work and answers with the task, not the subtitle", async () => {
    const h = harness();
    const captured = await invoke(route(h.routes, "POST", "/subtitles"), {
      body: { mediaFileId: MEDIA, language: "tur" },
    });
    expect(captured.status).toBe(202);
    expect(h.enqueued).toEqual([
      {
        jobType: SUBTITLE_JOB_TYPES.run,
        payload: { attemptId: ATTEMPT, replace: false },
        dedupeKey: `subtitle:${ATTEMPT}`,
      },
    ]);
  });

  /*
   * The same request twice must not become two searches against a provider
   * that is already rate-limiting us.
   */
  it("keys the task on the attempt, so a repeat does not double the search", async () => {
    const h = harness();
    const post = route(h.routes, "POST", "/subtitles");
    await invoke(post, { body: { mediaFileId: MEDIA, language: "tur" } });
    await invoke(post, { body: { mediaFileId: MEDIA, language: "tur" } });
    expect(new Set(h.enqueued.map((e) => e.dedupeKey)).size).toBe(1);
  });

  it("normalises the language before anything downstream sees it", async () => {
    const h = harness();
    await invoke(route(h.routes, "POST", "/subtitles"), {
      body: {
        mediaFileId: MEDIA,
        language: "TR-tr",
        hearingImpaired: "prefer",
      },
    });
    expect(h.wants).toEqual([
      { language: "tur", forced: false, hearingImpaired: "prefer" },
    ]);
  });

  it("carries an explicit replacement request onto the task", async () => {
    const h = harness();
    await invoke(route(h.routes, "POST", "/subtitles"), {
      body: { mediaFileId: MEDIA, language: "tur", replace: true },
    });
    expect(h.enqueued[0]!.payload).toMatchObject({ replace: true });
  });

  it.each([
    ["no media file", { language: "tur" }],
    [
      "a media file that is not a catalogue id",
      { mediaFileId: "../../etc", language: "tur" },
    ],
    [
      "a path where a language belongs",
      { mediaFileId: MEDIA, language: "../../etc/passwd" },
    ],
    ["a language nothing speaks", { mediaFileId: MEDIA, language: "zz" }],
    ["no language at all", { mediaFileId: MEDIA }],
    [
      "a hearing-impaired policy of its own invention",
      { mediaFileId: MEDIA, language: "tur", hearingImpaired: "maybe" },
    ],
    [
      "a string where a flag belongs",
      { mediaFileId: MEDIA, language: "tur", forced: "yes" },
    ],
    [
      "a field this route does not have",
      { mediaFileId: MEDIA, language: "tur", destination: "/etc/passwd" },
    ],
  ])("refuses a request with %s", async (_label, body) => {
    const h = harness();
    await expect(
      invoke(route(h.routes, "POST", "/subtitles"), { body }),
    ).rejects.toThrow();
    expect(h.enqueued).toEqual([]);
  });
});

describe("looking at an attempt", () => {
  it("says where it got to, and no more than that", async () => {
    const h = harness({
      attempt: attemptRow({
        state: "needs-authentication",
        awaitingProviderId: "synthetic",
        failureClass: "authentication-required",
        failureDetail: "The provider returned: cf_clearance=SECRET rejected.",
      }),
    });
    const captured = await invoke(
      route(h.routes, "GET", "/subtitles/:attemptId"),
      {
        params: { attemptId: ATTEMPT },
      },
    );
    expect(captured.payload?.data).toEqual({
      attemptId: ATTEMPT,
      state: "needs-authentication",
      awaitingProviderId: "synthetic",
      failureClass: "authentication-required",
    });
    // The detail can carry a provider's own words, so it does not leave here.
    expect(JSON.stringify(captured.payload)).not.toContain("SECRET");
  });

  it("refuses an attempt id that is not one", async () => {
    const h = harness();
    await expect(
      invoke(route(h.routes, "GET", "/subtitles/:attemptId"), {
        params: { attemptId: "..%2Fetc" },
      }),
    ).rejects.toThrow();
  });

  it("does not distinguish a missing attempt from a malformed one", async () => {
    const h = harness({ attempt: null });
    await expect(
      invoke(route(h.routes, "GET", "/subtitles/:attemptId"), {
        params: { attemptId: ATTEMPT },
      }),
    ).rejects.toThrow();
  });
});

describe("resuming after somebody has signed in", () => {
  it("queues the resume task when the attempt is actually waiting", async () => {
    const h = harness({
      attempt: attemptRow({ state: "needs-authentication" }),
    });
    const captured = await invoke(
      route(h.routes, "POST", "/subtitles/:attemptId/resume"),
      { params: { attemptId: ATTEMPT } },
    );
    expect(captured.status).toBe(202);
    expect(h.enqueued).toEqual([
      {
        jobType: SUBTITLE_JOB_TYPES.resume,
        payload: { attemptId: ATTEMPT },
        dedupeKey: `subtitle:${ATTEMPT}`,
      },
    ]);
  });

  /*
   * Resuming an attempt that is not paused would re-enter the pipeline from
   * whatever state it is really in, which is how a finished install gets
   * searched for again.
   */
  it.each([["wanted"], ["searching"], ["installed"], ["failed"]] as const)(
    "refuses to resume an attempt in %s",
    async (state) => {
      const h = harness({ attempt: attemptRow({ state }) });
      await expect(
        invoke(route(h.routes, "POST", "/subtitles/:attemptId/resume"), {
          params: { attemptId: ATTEMPT },
        }),
      ).rejects.toThrow();
      expect(h.enqueued).toEqual([]);
    },
  );
});

describe("subtitles for a whole title", () => {
  const ITEM = "33333333-4444-4555-8666-777777777777";

  it("asks once per episode file, skipping files already being searched", async () => {
    const h = harness();
    const repository = h.repository as unknown as Record<string, unknown>;
    repository.titleMediaFiles = vi.fn(async () => ["f1", "f2", "f3"]);
    repository.openAttempt = vi.fn(async () => null);
    (repository.openAttempt as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      "already-running",
    );
    const captured = await invoke(
      route(h.routes, "POST", "/subtitles/items/:itemId"),
      { params: { itemId: ITEM }, body: { language: "tr" } },
    );
    expect(captured.payload?.data).toEqual({ files: 3, queued: 2 });
    expect(h.wants.every((want) => want.language === "tur")).toBe(true);
    expect(h.enqueued).toHaveLength(2);
  });

  it("refuses a request that names no known language", async () => {
    const h = harness();
    await expect(
      invoke(route(h.routes, "POST", "/subtitles/items/:itemId"), {
        params: { itemId: ITEM },
        body: { language: "zz-nothing" },
      }),
    ).rejects.toThrow();
  });
});

describe("a provider sign-in", () => {
  function sessionHarness() {
    const h = harness();
    const stored: unknown[] = [];
    const repository = h.repository as unknown as Record<string, unknown>;
    repository.attemptsAwaiting = vi.fn(async () => ["a1", "a2"]);
    const vault = {
      store: vi.fn(async (_id: string, material: unknown) => {
        stored.push(material);
      }),
      clear: vi.fn(async () => undefined),
      status: vi.fn(async (providerId: string) => ({
        providerId,
        state: "active",
        updatedAt: null,
        reason: null,
      })),
    };
    const routes = createSubtitleRoutes(
      h.repository,
      {
        enqueue: (options: Record<string, unknown>) => (
          h.enqueued.push(options),
          Promise.resolve("job")
        ),
      } as unknown as JobQueue,
      {
        providers: [
          {
            id: "turkcealtyazi",
            label: "TürkçeAltyazı",
            requiresSession: true,
            languages: ["tur"],
          },
        ],
        vault: vault as never,
      },
    );
    return { ...h, routes, stored, vault };
  }

  it("stores the pasted session, answers without it, and resumes what was waiting", async () => {
    const h = sessionHarness();
    const captured = await invoke(
      route(h.routes, "PUT", "/subtitles/providers/:providerId/session"),
      {
        params: { providerId: "turkcealtyazi" },
        body: { cookie: "cf_clearance=secret", userAgent: "Mozilla/5.0" },
      },
    );
    expect(h.stored).toEqual([
      { cookie: "cf_clearance=secret", userAgent: "Mozilla/5.0" },
    ]);
    expect(JSON.stringify(captured.payload)).not.toContain("secret");
    expect(captured.payload?.data).toMatchObject({ resumed: 2 });
    expect(h.enqueued.map((job) => job.jobType)).toEqual([
      SUBTITLE_JOB_TYPES.resume,
      SUBTITLE_JOB_TYPES.resume,
    ]);
  });

  it("refuses a paste that would inject a header, and stores nothing", async () => {
    const h = sessionHarness();
    await expect(
      invoke(
        route(h.routes, "PUT", "/subtitles/providers/:providerId/session"),
        {
          params: { providerId: "turkcealtyazi" },
          body: { cookie: "a=1\r\nX-Evil: 1", userAgent: "Mozilla/5.0" },
        },
      ),
    ).rejects.toThrow();
    expect(h.stored).toEqual([]);
  });

  it("does not accept a session for a provider it does not ask", async () => {
    const h = sessionHarness();
    await expect(
      invoke(
        route(h.routes, "PUT", "/subtitles/providers/:providerId/session"),
        {
          params: { providerId: "elsewhere" },
          body: { cookie: "a=1", userAgent: "UA" },
        },
      ),
    ).rejects.toThrow();
  });
});
