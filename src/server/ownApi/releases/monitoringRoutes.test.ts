// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createMonitoringRoutes } from "./monitoringRoutes";
import type {
  MonitoringRepository,
  SeriesMonitoring,
} from "./monitoringRepository";
import type { RouteContext, RouteDefinition } from "../api/router";
import { OwnApiError } from "../ownApiHandler";

const ITEM = "11111111-1111-4111-8111-111111111111";

function series(): SeriesMonitoring {
  return {
    title: { itemId: ITEM, monitored: true, currentFormatScore: 0 },
    seasons: [
      {
        seasonNumber: 1,
        monitoring: "inherit",
        effective: {
          monitored: true,
          decidedBy: "series",
          reason: {
            code: "series-monitored",
            detail: "Inherited from the series.",
          },
        },
      },
      {
        seasonNumber: 2,
        monitoring: "unmonitored",
        effective: {
          monitored: false,
          decidedBy: "season",
          reason: {
            code: "season-unmonitored",
            detail: "Season 2 has its own setting.",
          },
        },
      },
    ],
    episodes: [
      {
        seasonNumber: 2,
        episodeNumber: 5,
        monitoring: "monitored",
        effective: {
          monitored: true,
          decidedBy: "episode",
          reason: {
            code: "episode-monitored",
            detail: "The episode has its own setting.",
          },
        },
      },
    ],
  };
}

interface Harness {
  routes: RouteDefinition[];
  repository: MonitoringRepository;
}

function harness(readSeries: SeriesMonitoring | null = series()): Harness {
  const repository = {
    readTitle: vi.fn(async () => null),
    readSeries: vi.fn(async () => readSeries),
    setTitle: vi.fn(async (itemId: string) => ({
      itemId,
      monitored: true,
      currentFormatScore: 0,
    })),
    setSeason: vi.fn(async () => undefined),
    setEpisode: vi.fn(async () => undefined),
    listMonitoredTitles: vi.fn(async () => [
      { itemId: ITEM, monitored: true, currentFormatScore: 0 },
    ]),
  } as unknown as MonitoringRepository;
  return { routes: createMonitoringRoutes(repository), repository };
}

const route = (h: Harness, method: string, path: string) =>
  h.routes.find((r) => r.method === method && r.path === path)!;

function invoke(
  definition: RouteDefinition,
  options: { body?: unknown; params?: Record<string, string> } = {},
): Promise<{
  status: number;
  payload: { data?: Record<string, unknown> } | undefined;
}> {
  const captured = { status: 0, payload: undefined as never };
  const context = {
    request: { once: () => undefined, off: () => undefined },
    response: {
      setHeader: () => undefined,
      end: (chunk?: string) => {
        (captured as { payload: unknown }).payload = chunk
          ? JSON.parse(chunk)
          : undefined;
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
    url: new URL("http://localhost/ownAPI/v1/monitoring"),
    params: options.params ?? {},
    method: definition.method,
    principal: { userId: "u", isAdministrator: true },
    requirePrincipal: () => ({ userId: "u", isAdministrator: true }),
    readJson: async () => options.body,
  } as unknown as RouteContext;
  return definition.handle(context).then(() => captured);
}

describe("the monitoring API", () => {
  it("is administrative throughout", () => {
    for (const definition of harness().routes) {
      expect(definition.access).toBe("admin");
    }
  });

  it("separates what was set from what it works out to, and says who decided", async () => {
    /*
     * The whole reason the effective state carries its source: "monitored" on
     * its own leaves an operator unable to tell a season they set from one
     * that is merely following its series.
     */
    const h = harness();
    const { payload } = await invoke(route(h, "GET", "/monitoring/:itemId"), {
      params: { itemId: ITEM },
    });
    const seasons = payload?.data?.seasons as Array<Record<string, unknown>>;
    expect(seasons[0]).toMatchObject({
      choice: "inherit",
      monitored: true,
      decidedBy: "series",
      reason: "Inherited from the series.",
    });
    expect(seasons[1]).toMatchObject({
      choice: "unmonitored",
      monitored: false,
      decidedBy: "season",
    });
  });

  it("reports an episode that overrides its season", async () => {
    const h = harness();
    const { payload } = await invoke(route(h, "GET", "/monitoring/:itemId"), {
      params: { itemId: ITEM },
    });
    const episodes = payload?.data?.episodes as Array<Record<string, unknown>>;
    expect(episodes[0]).toMatchObject({
      choice: "monitored",
      monitored: true,
      decidedBy: "episode",
    });
  });

  it("carries no filesystem path in any response", async () => {
    // Monitoring is a statement about a title, not about a file.
    const h = harness();
    const { payload } = await invoke(route(h, "GET", "/monitoring/:itemId"), {
      params: { itemId: ITEM },
    });
    const body = JSON.stringify(payload);
    expect(body).not.toMatch(/[A-Za-z]:\\\\/);
    expect(body).not.toMatch(/\/media\//);
  });

  it("answers 404 for an item the catalogue does not have", async () => {
    const h = harness(null);
    await expect(
      invoke(route(h, "GET", "/monitoring/:itemId"), {
        params: { itemId: ITEM },
      }),
    ).rejects.toBeInstanceOf(OwnApiError);
  });

  it("sets a title's own state", async () => {
    const h = harness();
    const { payload } = await invoke(route(h, "PUT", "/monitoring/:itemId"), {
      params: { itemId: ITEM },
      body: { monitored: true },
    });
    expect(h.repository.setTitle).toHaveBeenCalledWith(ITEM, {
      monitored: true,
    });
    expect(payload?.data?.title).toMatchObject({ monitored: true });
  });

  it("refuses a title state that is not a boolean", async () => {
    const h = harness();
    await expect(
      invoke(route(h, "PUT", "/monitoring/:itemId"), {
        params: { itemId: ITEM },
        body: { monitored: "yes" },
      }),
    ).rejects.toThrow();
  });

  it.each(["inherit", "monitored", "unmonitored"])(
    "accepts %s as a season choice",
    async (choice) => {
      const h = harness();
      const { status } = await invoke(
        route(h, "PUT", "/monitoring/:itemId/seasons/:seasonNumber"),
        { params: { itemId: ITEM, seasonNumber: "2" }, body: { choice } },
      );
      expect(status).toBe(204);
      expect(h.repository.setSeason).toHaveBeenCalledWith(ITEM, 2, choice);
    },
  );

  it("refuses a choice outside the three the model has", async () => {
    const h = harness();
    await expect(
      invoke(route(h, "PUT", "/monitoring/:itemId/seasons/:seasonNumber"), {
        params: { itemId: ITEM, seasonNumber: "2" },
        body: { choice: "maybe" },
      }),
    ).rejects.toThrow();
  });

  it("refuses a season number that is not one", async () => {
    const h = harness();
    for (const seasonNumber of ["-1", "abc", "99999"]) {
      await expect(
        invoke(route(h, "PUT", "/monitoring/:itemId/seasons/:seasonNumber"), {
          params: { itemId: ITEM, seasonNumber },
          body: { choice: "monitored" },
        }),
      ).rejects.toThrow();
    }
  });

  it("sets an episode override", async () => {
    const h = harness();
    const { status } = await invoke(
      route(
        h,
        "PUT",
        "/monitoring/:itemId/seasons/:seasonNumber/episodes/:episodeNumber",
      ),
      {
        params: { itemId: ITEM, seasonNumber: "3", episodeNumber: "5" },
        body: { choice: "monitored" },
      },
    );
    expect(status).toBe(204);
    expect(h.repository.setEpisode).toHaveBeenCalledWith(
      ITEM,
      3,
      5,
      "monitored",
    );
  });

  it("lists what is being watched by id", async () => {
    const h = harness();
    const { payload } = await invoke(route(h, "GET", "/monitoring"));
    expect(payload?.data?.monitored).toEqual([{ itemId: ITEM }]);
  });
});
