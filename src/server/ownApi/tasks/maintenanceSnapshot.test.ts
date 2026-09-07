import { describe, expect, it, vi } from "vitest";
import { createTaskRoutes } from "./taskRoutes";
import type { JobQueue, JobRecord } from "./jobQueue";
import type { LibraryRepository } from "../libraries/libraryRepository";
import { toMaintenanceTaskDto } from "./maintenanceTaskDto";
import type { MaintenanceTaskDto } from "../../../lib/maintenance/maintenanceTasks";

/**
 * The canonical snapshot, and the line the server actually holds.
 *
 * These two routes are the whole contract the Library Scan page reads. What is
 * asserted is that the page is told the truth and nothing else: positions the
 * worker will really claim in, a queue the client applies verbatim rather than
 * re-deriving, and — on a reorder — the arrangement the database ended up with
 * rather than the one it was asked for.
 */

function job(over: Partial<JobRecord> & { id: string }): JobRecord {
  return {
    jobType: "library.scan",
    payload: {},
    status: "queued",
    attempts: 0,
    maxAttempts: 3,
    progress: 0,
    progressMessage: null,
    progressDetail: null,
    safeError: null,
    result: null,
    cancellationRequested: false,
    priority: 100,
    queuedAt: new Date("2026-09-06T10:00:00.000Z"),
    runAfter: new Date("2026-09-06T10:00:00.000Z"),
    startedAt: null,
    finishedAt: null,
    ...over,
  };
}

const libraries = {
  listAll: async () => [
    { id: "films", name: "Films", kind: "movies" },
    { id: "shows", name: "Shows", kind: "series" },
  ],
  getById: async (id: string) =>
    id === "films"
      ? { name: "Films" }
      : id === "shows"
        ? { name: "Shows" }
        : null,
} as unknown as LibraryRepository;

function harness(options: {
  included?: JobRecord[];
  active?: JobRecord[];
  concluded?: JobRecord[];
  reorder?: (ids: readonly string[]) => Promise<string[]>;
  /** What the server counts, as distinct from what a page returns. */
  totals?: { active: number; concluded: number };
}) {
  type ListOptions = {
    excludeJobTypes?: string[];
    limit: number;
    offset?: number;
  };
  const listActive = vi.fn(
    async (_options: ListOptions) => options.active ?? [],
  );
  const listConcluded = vi.fn(
    async (_options: ListOptions) => options.concluded ?? [],
  );
  const countTasks = vi.fn(async (_options: { excludeJobTypes?: string[] }) =>
    options.totals ?? { active: 0, concluded: 0 },
  );
  const reorderQueue = vi.fn(
    async (
      ids: readonly string[],
      _options?: { excludeJobTypes?: string[] },
    ) => (options.reorder ? options.reorder(ids) : [...ids]),
  );
  const queue = {
    get: async (id: string) =>
      options.included?.find((row) => row.id === id) ?? null,
    listActive,
    listConcluded,
    countTasks,
    reorderQueue,
  } as unknown as JobQueue;
  const routes = createTaskRoutes({ queue, libraries });

  const call = async (
    path: string,
    body: unknown = {},
    search = "",
  ): Promise<Record<string, unknown>> => {
    const route = routes.find((candidate) => candidate.path === path);
    if (!route) throw new Error(`no route at ${path}`);
    let payload: Record<string, unknown> = {};
    await route.handle({
      params: {},
      requestId: "request",
      response: {
        statusCode: 200,
        setHeader: () => undefined,
        writeHead: () => undefined,
        end: (text: string) => {
          payload = JSON.parse(text).data;
        },
      },
      url: new URL(`http://host/${search}`),
      method: "POST",
      principal: null,
      requirePrincipal: () => ({ userId: "admin" }),
      readJson: async () => body,
      request: {} as never,
    } as never);
    return payload;
  };

  return { call, listActive, listConcluded, countTasks, reorderQueue };
}

describe("the canonical maintenance snapshot", () => {
  it("reads the running work and the history in one request", async () => {
    const { call, listActive, listConcluded } = harness({
      active: [
        job({ id: "running", status: "running", startedAt: new Date() }),
        job({ id: "waiting" }),
      ],
      concluded: [job({ id: "done", status: "succeeded" })],
    });

    const snapshot = (await call("/admin/maintenance/tasks")) as unknown as {
      tasks: MaintenanceTaskDto[];
      queue: string[];
    };

    expect(snapshot.tasks.map((task) => task.id)).toEqual([
      "running",
      "waiting",
      "done",
    ]);
    expect(listActive).toHaveBeenCalledOnce();
    expect(listConcluded).toHaveBeenCalledOnce();
  });

  it("numbers only the rows that are genuinely waiting, in claim order", async () => {
    const { call } = harness({
      active: [
        job({ id: "running", status: "running" }),
        job({ id: "first" }),
        job({ id: "second" }),
      ],
    });

    const snapshot = (await call("/admin/maintenance/tasks")) as unknown as {
      tasks: MaintenanceTaskDto[];
      queue: string[];
    };

    const positions = Object.fromEntries(
      snapshot.tasks.map((task) => [task.id, task.queuePosition]),
    );
    expect(positions).toEqual({
      running: undefined,
      first: 1,
      second: 2,
    });
    // The line the client applies verbatim rather than re-deriving.
    expect(snapshot.queue).toEqual(["first", "second"]);
  });

  /*
   * The two figures that used to be one. A tab labelled from the length of its
   * page says "50" whether there are fifty concluded jobs or eight hundred, and
   * for months there was no way to see the other seven hundred and fifty at all.
   */
  it("reports what it counted, not what the page happened to hold", async () => {
    const { call } = harness({
      active: [job({ id: "waiting" })],
      concluded: [job({ id: "done", status: "succeeded" })],
      totals: { active: 218, concluded: 811 },
    });

    const snapshot = (await call("/admin/maintenance/tasks")) as unknown as {
      tasks: MaintenanceTaskDto[];
      pages: {
        active: { total: number; offset: number; limit: number };
        concluded: { total: number; offset: number; limit: number };
      };
    };

    expect(snapshot.tasks).toHaveLength(2);
    expect(snapshot.pages.active.total).toBe(218);
    expect(snapshot.pages.concluded.total).toBe(811);
  });

  it("passes each tab's page through to its own query", async () => {
    const { call, listActive, listConcluded } = harness({});

    await call(
      "/admin/maintenance/tasks",
      {},
      "?active=200&activeOffset=400&history=50&historyOffset=150",
    );

    expect(listActive.mock.calls[0]?.[0]).toMatchObject({
      limit: 200,
      offset: 400,
    });
    expect(listConcluded.mock.calls[0]?.[0]).toMatchObject({
      limit: 50,
      offset: 150,
    });
  });

  /*
   * On page three of a queue the first row is not the next thing the worker
   * will claim, and numbering it "1" describes a queue that does not exist.
   */
  it("numbers a later page from where that page actually starts", async () => {
    const { call } = harness({
      active: [job({ id: "first" }), job({ id: "second" })],
    });

    const snapshot = (await call(
      "/admin/maintenance/tasks",
      {},
      "?activeOffset=400",
    )) as unknown as { tasks: MaintenanceTaskDto[]; queue: string[] };

    expect(
      Object.fromEntries(
        snapshot.tasks.map((task) => [task.id, task.queuePosition]),
      ),
    ).toEqual({ first: 401, second: 402 });
  });

  it("refuses a page offset that is not a whole number of rows", async () => {
    const { call } = harness({});
    await expect(
      call("/admin/maintenance/tasks", {}, "?historyOffset=-1"),
    ).rejects.toThrow();
    await expect(
      call("/admin/maintenance/tasks", {}, "?historyOffset=abc"),
    ).rejects.toThrow();
  });

  it("keeps the media lane out of the maintenance viewer", async () => {
    const { call, listActive, listConcluded } = harness({});
    await call("/admin/maintenance/tasks");

    for (const spy of [listActive, listConcluded]) {
      expect(spy.mock.calls[0]?.[0]).toMatchObject({
        excludeJobTypes: ["media.process"],
      });
    }
  });

  it("never carries a path, a payload or server prose to the page", async () => {
    const { call } = harness({
      concluded: [
        job({
          id: "done",
          status: "failed",
          payload: { libraryId: "films", sourcePath: "/private/media" },
          safeError: "The library no longer exists.",
          result: { path: "/private/media", itemsCreated: 4 },
          finishedAt: new Date(),
        }),
      ],
    });

    const snapshot = await call("/admin/maintenance/tasks");
    const text = JSON.stringify(snapshot);

    expect(text).not.toContain("/private/media");
    expect(text).not.toContain("no longer exists");
    // The code the page translates, in place of the sentence.
    expect(text).toContain("library-deleted");
  });

  it("bounds the history the caller may ask for", async () => {
    const { call, listConcluded } = harness({});

    // Refused rather than quietly clamped: a page that asked for a hundred
    // thousand rows has a bug, and answering it with two hundred hides that.
    await expect(
      call("/admin/maintenance/tasks", {}, "?history=100000"),
    ).rejects.toThrow(/between 1 and 200/);

    await call("/admin/maintenance/tasks", {}, "?history=25");
    expect(listConcluded.mock.calls[0]?.[0]).toMatchObject({ limit: 25 });

    // And a caller that asks for nothing in particular still gets a bounded
    // history rather than the whole table.
    await call("/admin/maintenance/tasks");
    expect(listConcluded.mock.calls[1]?.[0]).toMatchObject({ limit: 50 });
  });
});

describe("rewriting the waiting line", () => {
  it("answers with the line the server holds, not the one it was asked for", async () => {
    // The head of the queue was claimed between the drag and the drop, so only
    // one row actually moved.
    const { call } = harness({
      active: [
        job({ id: "claimed", status: "running" }),
        job({ id: "b" }),
        job({ id: "a" }),
      ],
      reorder: async () => ["b"],
    });

    const answer = await call("/admin/maintenance/queue/order", {
      taskIds: [
        "11111111-1111-4111-8111-111111111111",
        "22222222-2222-4222-8222-222222222222",
      ],
    });

    expect(answer).toEqual({ moved: ["b"], queue: ["b", "a"] });
  });

  it("keeps the media lane's queue out of a maintenance reorder", async () => {
    const { call, reorderQueue } = harness({});
    await call("/admin/maintenance/queue/order", {
      taskIds: ["11111111-1111-4111-8111-111111111111"],
    });

    expect(reorderQueue.mock.calls[0]?.[1]).toMatchObject({
      excludeJobTypes: ["media.process"],
    });
  });

  it("refuses an empty order, a repeated task and anything that is not an id", async () => {
    const { call, reorderQueue } = harness({});

    await expect(
      call("/admin/maintenance/queue/order", { taskIds: [] }),
    ).rejects.toThrow(/1 to 200/);
    await expect(
      call("/admin/maintenance/queue/order", {
        taskIds: [
          "11111111-1111-4111-8111-111111111111",
          "11111111-1111-4111-8111-111111111111",
        ],
      }),
    ).rejects.toThrow(/repeat/i);
    await expect(
      call("/admin/maintenance/queue/order", { taskIds: ["not-an-id"] }),
    ).rejects.toThrow();
    await expect(
      call("/admin/maintenance/queue/order", { taskIds: "everything" }),
    ).rejects.toThrow();

    expect(reorderQueue).not.toHaveBeenCalled();
  });

  it("is admin-only, like every other task route", () => {
    const routes = createTaskRoutes({ queue: {} as JobQueue, libraries });
    for (const path of [
      "/admin/maintenance/tasks",
      "/admin/maintenance/queue/order",
    ]) {
      expect(routes.find((route) => route.path === path)?.access).toBe("admin");
    }
  });
});

describe("what a queue row becomes on the page", () => {
  const context = { libraries, libraryCount: 2 };

  it("says a waiting row may be moved and a claimed one may not", async () => {
    expect(
      (await toMaintenanceTaskDto(job({ id: "a" }), context)).reorderable,
    ).toBe(true);
    for (const status of [
      "running",
      "succeeded",
      "failed",
      "cancelled",
    ] as const) {
      expect(
        (await toMaintenanceTaskDto(job({ id: "a", status }), context))
          .reorderable,
      ).toBe(false);
    }
  });

  it("names the library, and says when it is gone", async () => {
    expect(
      (
        await toMaintenanceTaskDto(
          job({ id: "a", payload: { libraryId: "films" } }),
          context,
        )
      ).scope,
    ).toEqual({ kind: "library", label: "Films" });

    expect(
      (
        await toMaintenanceTaskDto(
          job({ id: "a", payload: { libraryId: "vanished" } }),
          context,
        )
      ).scope,
    ).toEqual({ kind: "library", deleted: true });
  });

  it("counts the libraries a library-wide operation covers", async () => {
    expect(
      (
        await toMaintenanceTaskDto(
          job({ id: "a", jobType: "trickplay.scan" }),
          context,
        )
      ).scope,
    ).toEqual({ kind: "all-libraries", libraries: 2 });
  });

  it("carries the run a pass belongs to, and nothing when it belongs to none", async () => {
    expect(
      (
        await toMaintenanceTaskDto(
          job({
            id: "a",
            jobType: "library.maintenance",
            payload: { runId: "run-7" },
          }),
          context,
        )
      ).runId,
    ).toBe("run-7");
    expect(
      (await toMaintenanceTaskDto(job({ id: "a" }), context)).runId,
    ).toBeUndefined();
  });

  it("reads counters out of a result and its nested sub-results", async () => {
    const dto = await toMaintenanceTaskDto(
      job({
        id: "a",
        status: "succeeded",
        result: {
          itemsCreated: 4,
          probe: { probed: 12, probeFailed: 1 },
          somethingElse: "ignored",
        },
      }),
      context,
    );

    expect(dto.result?.counters).toEqual({
      itemsCreated: 4,
      probed: 12,
      probeFailed: 1,
    });
  });

  it("qualifies a success that had failures inside it", async () => {
    const dto = await toMaintenanceTaskDto(
      job({
        id: "a",
        status: "succeeded",
        result: {
          moved: 997,
          movesFailed: 3,
          failures: [{ phase: "moving", reason: "permission-denied" }],
        },
      }),
      context,
    );

    expect(dto.result?.outcome).toBe("completed-with-failures");
    expect(dto.result?.failures).toHaveLength(1);
  });

  it("does not qualify a plain success at all", async () => {
    const dto = await toMaintenanceTaskDto(
      job({ id: "a", status: "succeeded", result: { moved: 900 } }),
      context,
    );

    expect(dto.result?.outcome).toBeUndefined();
  });

  it("has no result at all until the job has concluded", async () => {
    expect(
      (await toMaintenanceTaskDto(job({ id: "a", status: "running" }), context))
        .result,
    ).toBeNull();
  });

  it("reports when the executor last spoke, which is not when it started", async () => {
    const dto = await toMaintenanceTaskDto(
      job({
        id: "a",
        status: "running",
        startedAt: new Date("2026-09-06T10:00:00.000Z"),
        progressDetail: {
          revision: 3,
          phase: "reading",
          measure: { kind: "counter", counted: 12, unit: "files" },
          at: "2026-09-06T10:07:00.000Z",
        },
      }),
      context,
    );

    expect(dto.startedAt).toBe("2026-09-06T10:00:00.000Z");
    expect(dto.progressAt).toBe("2026-09-06T10:07:00.000Z");
  });
});

it("includes exact accepted tasks beyond the history window and describes disabled rename and move", async () => {
  const ids = [
    "00000000-0000-4000-8000-000000000001",
    "00000000-0000-4000-8000-000000000002",
  ];
  const { call } = harness({
    concluded: [job({ id: "other", status: "succeeded" })],
    included: ids.map((id, i) =>
      job({
        id,
        jobType: i ? "library.organize" : "library.rename",
        status: "succeeded",
        result: { mode: "off", disabled: true },
      }),
    ),
  });
  const result = await call(
    "/admin/maintenance/tasks",
    {},
    `?history=1&include=${ids.join(",")}`,
  );
  const tasks = result.tasks as MaintenanceTaskDto[];
  expect(tasks.map((task) => task.id)).toEqual(["other", ...ids]);
  expect(tasks.slice(1).map((task) => task.result?.outcome)).toEqual([
    "organize-disabled",
    "organize-disabled",
  ]);
  expect(result.queue).toEqual([]);
});
it.each([
  "",
  "bad",
  Array(101).fill("00000000-0000-4000-8000-000000000001").join(","),
  "00000000-0000-4000-8000-000000000001,00000000-0000-4000-8000-000000000001",
])("rejects invalid exact-ID requests: %s", async (include) => {
  const { call } = harness({});
  await expect(
    call("/admin/maintenance/tasks", {}, `?include=${include}`),
  ).rejects.toThrow();
});
