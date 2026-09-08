// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createReleaseRoutes } from "./releaseRoutes";
import { profileFromIds } from "./qualityProfile";
import { HEVC_PREFERENCE } from "./preferences";
import type { PolicyRepository } from "./policyRepository";
import type { RouteContext, RouteDefinition } from "../api/router";
import type { IndexerRelease } from "../indexers/indexerTypes";
import type { IndexerSearchService } from "../indexers/searchService";

const SECRET = "0123456789abcdef0123456789abcdef";

let counter = 0;
function release(
  title: string,
  extra: Partial<IndexerRelease> = {},
): IndexerRelease {
  counter += 1;
  return {
    indexerId: "nzbgeek",
    indexerName: "NZBgeek",
    protocol: "usenet",
    guid: `g-${counter}`,
    title,
    downloadUrl: `https://api.invalid/api?t=get&id=1&apikey=${SECRET}`,
    categoryIds: [2000],
    attributes: {},
    ...extra,
  };
}

const policies: PolicyRepository = {
  listProfiles: async () => [{ id: "p1", name: "HD-1080p" }],
  load: async (id) =>
    id === "p1"
      ? {
          profile: profileFromIds(
            "p1",
            "HD-1080p",
            ["hdtv-1080p", "webdl-1080p", "bluray-1080p"],
            { cutoffQualityId: "bluray-1080p" },
          ),
          preferences: [{ ...HEVC_PREFERENCE, id: "r1" }],
        }
      : null,
};

function routes(releases: readonly IndexerRelease[]): RouteDefinition[] {
  const search: IndexerSearchService = {
    search: vi.fn(async () => ({
      releases,
      outcomes: [
        {
          indexerId: "nzbgeek",
          indexerName: "NZBgeek",
          ok: true,
          returned: releases.length,
        },
      ],
      partial: false,
    })),
  };
  return createReleaseRoutes({ search, policies });
}

function invoke(
  route: RouteDefinition,
  body?: unknown,
): Promise<{ status: number; payload: unknown }> {
  const captured = { status: 0, payload: undefined as unknown };
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
      writeHead: (status: number) => {
        captured.status = status;
      },
    },
    requestId: "req",
    url: new URL("http://localhost/ownAPI/v1/releases/evaluate"),
    params: {},
    method: "POST",
    principal: { userId: "u", isAdministrator: true },
    requirePrincipal: () => ({ userId: "u", isAdministrator: true }),
    readJson: async () => body,
  } as unknown as RouteContext;
  return route.handle(context).then(() => captured);
}

const evaluate = (releases: readonly IndexerRelease[]) => routes(releases)[1]!;

interface EvaluateBody {
  data: {
    winner: { title: string; quality: string; score: number } | null;
    candidates: Array<{
      title: string;
      accepted: boolean;
      rejection?: string;
      reasons: Array<{ code: string; detail: string }>;
    }>;
    profile: { id: string; name: string };
  };
}

describe("searching and judging in one request", () => {
  const candidates = [
    release("Blade.Runner.2049.2017.1080p.WEB-DL.x265-A"),
    release("Blade.Runner.2049.2017.1080p.BluRay.x264-B"),
    release("Blade.Runner.2049.2017.720p.HDTV-C"),
    release("Some.Other.Film.2020.1080p.BluRay-D"),
  ];

  it("returns a winner and a verdict for every candidate", async () => {
    const { payload } = await invoke(evaluate(candidates), {
      kind: "movie",
      title: "Blade Runner 2049",
      year: 2017,
      profileId: "p1",
    });
    const data = (payload as EvaluateBody).data;
    expect(data.winner?.title).toContain("BluRay");
    expect(data.winner?.quality).toBe("BluRay 1080p");
    expect(data.candidates).toHaveLength(4);
    expect(data.profile).toEqual({ id: "p1", name: "HD-1080p" });
  });

  it("explains each rejection", async () => {
    const { payload } = await invoke(evaluate(candidates), {
      kind: "movie",
      title: "Blade Runner 2049",
      year: 2017,
      profileId: "p1",
    });
    const rejections = (payload as EvaluateBody).data.candidates
      .filter((c) => !c.accepted)
      .map((c) => c.rejection);
    expect(rejections).toContain("quality-not-allowed");
    expect(rejections).toContain("title-mismatch");
    for (const candidate of (payload as EvaluateBody).data.candidates) {
      expect(candidate.reasons.length).toBeGreaterThan(0);
    }
  });

  it("reports no winner rather than inventing one", async () => {
    const { payload } = await invoke(
      evaluate([release("Nothing.Relevant.2020.720p.HDTV-X")]),
      {
        kind: "movie",
        title: "Blade Runner 2049",
        profileId: "p1",
      },
    );
    expect((payload as EvaluateBody).data.winner).toBeNull();
  });

  it("judges an episode target", async () => {
    const { payload } = await invoke(
      evaluate([release("The.Expanse.S05E03.1080p.WEB-DL.x265-NTb")]),
      {
        kind: "episode",
        title: "The Expanse",
        season: 5,
        episode: 3,
        profileId: "p1",
      },
    );
    const data = (payload as EvaluateBody).data;
    expect(data.winner?.title).toContain("S05E03");
    expect(data.winner?.score).toBe(100);
  });

  it("takes what is already held into account", async () => {
    const { payload } = await invoke(evaluate(candidates), {
      kind: "movie",
      title: "Blade Runner 2049",
      year: 2017,
      profileId: "p1",
      currentQualityId: "webdl-1080p",
    });
    // The profile does not upgrade, so nothing can replace what is held.
    const data = (payload as EvaluateBody).data;
    expect(data.winner).toBeNull();
    expect(
      data.candidates.some((c) => c.rejection === "upgrade-not-wanted"),
    ).toBe(true);
  });
});

describe("what the route will not do", () => {
  it("offers no route that fetches or grabs anything", () => {
    const paths = routes([]).map((route) => `${route.method} ${route.path}`);
    expect(paths).toEqual([
      "GET /releases/profiles",
      "POST /releases/evaluate",
    ]);
    expect(paths.join(" ")).not.toMatch(/grab|download|nzb|queue/i);
  });

  it("requires an administrator", () => {
    for (const route of routes([])) expect(route.access).toBe("admin");
  });

  it("never returns the credential-bearing download URL", async () => {
    const { payload } = await invoke(
      evaluate([release("Blade.Runner.2049.2017.1080p.BluRay-A")]),
      {
        kind: "movie",
        title: "Blade Runner 2049",
        profileId: "p1",
      },
    );
    const serialised = JSON.stringify(payload);
    expect(serialised).not.toContain(SECRET);
    expect(serialised).not.toContain("apikey");
    expect(serialised).not.toContain("downloadUrl");
  });

  it.each([
    ["no title", { profileId: "p1" }],
    ["an unknown kind", { kind: "boxset", title: "X", profileId: "p1" }],
    [
      "an episode with no season",
      { kind: "episode", title: "X", episode: 1, profileId: "p1" },
    ],
    [
      "an episode with no episode number",
      { kind: "episode", title: "X", season: 1, profileId: "p1" },
    ],
    ["no profile", { kind: "movie", title: "X" }],
    [
      "an unexpected field",
      { kind: "movie", title: "X", profileId: "p1", grab: true },
    ],
    [
      "a current quality that is not one",
      { kind: "movie", title: "X", profileId: "p1", currentQualityId: "nope" },
    ],
  ])("refuses %s", async (_label, body) => {
    await expect(invoke(evaluate([]), body)).rejects.toMatchObject({
      statusCode: 422,
    });
  });

  it("answers 404 for a profile that does not exist", async () => {
    await expect(
      invoke(evaluate([]), { kind: "movie", title: "X", profileId: "missing" }),
    ).rejects.toMatchObject({ code: "PROFILE_NOT_FOUND", statusCode: 404 });
  });
});
