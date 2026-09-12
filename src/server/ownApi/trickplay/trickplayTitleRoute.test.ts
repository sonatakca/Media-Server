import { describe, expect, it } from "vitest";
import type { RouteContext } from "../api/router";
import type {
  CatalogueRepository,
  ProcessableTitleRow,
} from "../catalogue/catalogueRepository";
import type { JobQueue } from "../tasks/jobQueue";
import { JOB_TYPES } from "../tasks/jobHandlers";
import { createTrickplayRoutes } from "./trickplayRoutes";
import type { TrickplayService } from "./trickplayService";

const SHOW = "a504de76-a209-450e-8035-10b36fa56b3e";

const episode = (
  itemId: string,
  over: Partial<ProcessableTitleRow> = {},
): ProcessableTitleRow =>
  ({
    itemId,
    mediaFileId: `file-${itemId}`,
    fileMissingSince: null,
    itemMissingSince: null,
    probeState: "probed",
    durationMs: "1000",
    width: 1920,
    height: 1080,
    ...over,
  }) as ProcessableTitleRow;

function harness(kind: string, titles: ProcessableTitleRow[]) {
  const enqueued: Array<Record<string, unknown>> = [];
  const asked: unknown[] = [];
  const catalogue = {
    getItemKind: async () => kind,
    listProcessableTitles: async (options: unknown) => {
      asked.push(options);
      return titles;
    },
  } as unknown as CatalogueRepository;
  const trickplay = {
    listGeneratedMediaFileIds: async () => new Set(["file-e2"]),
  } as unknown as TrickplayService;
  const queue = {
    enqueue: async (job: Record<string, unknown>) => {
      enqueued.push(job);
      return "task";
    },
  } as unknown as JobQueue;
  const route = createTrickplayRoutes({ trickplay, catalogue, queue }).find(
    (candidate) => candidate.path === "/admin/items/:itemId/trickplay",
  )!;
  async function call(body: unknown) {
    let payload: { data: Record<string, number> } | undefined;
    await route.handle({
      response: {
        setHeader() {},
        end(value: string) {
          payload = JSON.parse(value);
        },
      },
      requestId: "r",
      params: { itemId: SHOW },
      requirePrincipal: () => ({ userId: "u", isAdministrator: true }),
      readJson: async () => body,
    } as unknown as RouteContext);
    return payload!.data;
  }
  return { call, enqueued, asked, route };
}

describe("trickplay for one title", () => {
  it("is for administrators", () => {
    expect(harness("series", []).route.access).toBe("admin");
  });

  it("fans a show out to its episodes, skipping ones that have sheets or no probe", async () => {
    const h = harness("series", [
      episode("e1"),
      episode("e2"),
      episode("e3", { probeState: "pending" }),
    ]);
    expect(await h.call({})).toEqual({
      queued: 1,
      alreadyGenerated: 1,
      notReady: 1,
    });
    expect(h.asked).toEqual([{ kinds: ["episode"], seriesId: SHOW }]);
    expect(h.enqueued).toEqual([
      {
        jobType: JOB_TYPES.trickplayGenerate,
        payload: { itemId: "e1" },
        dedupeKey: `${JOB_TYPES.trickplayGenerate}:e1`,
        priority: 400,
      },
    ]);
  });

  it("rebuilds every episode when asked to", async () => {
    const h = harness("season", [episode("e1"), episode("e2")]);
    expect((await h.call({ force: true })).queued).toBe(2);
    expect(h.asked).toEqual([{ kinds: ["episode"], seasonId: SHOW }]);
    expect(
      h.enqueued.every((job) => (job.payload as { force?: boolean }).force),
    ).toBe(true);
  });

  it("queues a single film by itself", async () => {
    const h = harness("movie", [episode(SHOW), episode("other")]);
    expect((await h.call({})).queued).toBe(1);
    expect((h.enqueued[0]!.payload as { itemId: string }).itemId).toBe(SHOW);
  });

  it("refuses a force that is not a boolean", async () => {
    await expect(harness("movie", []).call({ force: "yes" })).rejects.toThrow();
  });
});
