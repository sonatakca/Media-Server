import { describe, expect, it } from "vitest";
import type { TaskDto } from "../../api/ownApi/dto";
import {
  describeTask,
  getTaskTitleKey,
  isSpokenForByLead,
  selectChangedTasks,
  selectProcessingLead,
  selectQueueLeads,
} from "./taskNotifications";
import {
  presentMaintenanceProgress,
  presentTask,
  resultMetrics,
  safeTaskLabel,
  type TaskPresentation,
} from "./taskPresentation";
import {
  MAINTENANCE_PHASES,
  MAINTENANCE_UNITS,
  describeOverall,
  type MaintenanceProgress,
} from "../maintenance/maintenanceTasks";
import { JOB_TYPES } from "../../server/ownApi/tasks/jobHandlers";
import { NFO_JOB_TYPES } from "../../server/ownApi/nfo/nfoJobs";
import { translations } from "../../i18n/translations";
export function task(overrides: Partial<TaskDto> = {}): TaskDto {
  return {
    id: "task-1",
    type: "media.probe",
    status: "running",
    progress: 0.42,
    progressMessage: "Analysed 42 of 100 files",
    attempts: 1,
    maxAttempts: 3,
    error: null,
    result: null,
    queuedAt: "2026-08-11T00:00:00Z",
    startedAt: "2026-08-11T00:00:01Z",
    finishedAt: null,
    ...overrides,
  };
}
describe("authoritative task presentation", () => {
  it.each([
    [0, 0],
    [0.42, 42],
    [1, 100],
    [-1, 0],
    [42, 100],
    [NaN, undefined],
    [Infinity, undefined],
  ])(
    "converts queue fraction %s to UI percentage %s exactly once",
    (progress, expected) => {
      expect(describeTask(task({ progress })).progress).toBe(expected);
    },
  );
  it("names every registered job in both languages", () => {
    for (const type of [
      ...Object.values(JOB_TYPES),
      ...Object.values(NFO_JOB_TYPES),
    ]) {
      const key = getTaskTitleKey(type);
      expect(key).not.toBe("tasks.backgroundWork");
      expect(translations.en[key]).toBeTruthy();
      expect(translations.tr[key]).toBeTruthy();
    }
    expect(getTaskTitleKey("future")).toBe("tasks.backgroundWork");
  });
  it("keeps stage checkpoints indeterminate and never derives counts from a fraction", () => {
    const detail = describeTask(
      task({ type: "library.scan", progressMessage: "Updating the catalogue" }),
    );
    expect(detail.task).toMatchObject({
      stage: "catalogue",
      determinate: false,
    });
    expect(detail.task.counts).toBeUndefined();
  });
  it("extracts only exact authoritative producer counts", () => {
    expect(
      presentTask("media.probe", "Analysed 296 of 412 files", null),
    ).toMatchObject({
      determinate: true,
      stage: "analysing",
      counts: { completed: 296, total: 412, unit: "files" },
    });
    expect(
      presentTask(
        "nfo.export.library",
        "Exported metadata for 3 of 10 titles",
        null,
      ).counts?.completed,
    ).toBe(3);
    expect(
      presentTask("media.probe", "Analysed 12 of 2 files", null).counts,
    ).toBeUndefined();
  });
  it("preserves meaningful zero counts with per-type allowlists", () => {
    expect(
      resultMetrics("library.scan", {
        itemsCreated: 0,
        itemsDeleted: 0,
        secret: 42,
      }),
    ).toEqual([
      { metric: "itemsCreated", value: 0 },
      { metric: "itemsDeleted", value: 0 },
    ]);
    expect(resultMetrics("media.process", { itemsCreated: 12 })).toEqual([]);
  });
  it("never renders arbitrary errors, paths, UUIDs, or result objects", () => {
    const detail = describeTask(
      task({
        status: "failed",
        error: "/secret/password postgres://db",
        result: { sourcePath: "/secret" },
        progressMessage: "/secret",
      }),
    );
    expect(JSON.stringify(detail)).not.toContain("/secret");
    expect(detail.task.errorKey).toBe("tasks.safeFailure");
    expect(detail.progress).toBeUndefined();
    expect(detail.task.metrics).toEqual([]);
    for (const unsafe of [
      "/mnt/file",
      "C:\\secret",
      "12345678-abcd-abcd-abcd-123456789abc",
      "postgres://host",
    ])
      expect(safeTaskLabel(unsafe)).toBeUndefined();
  });
  it("represents retry, queued, storage wait and cancellation honestly", () => {
    expect(
      describeTask(task({ status: "queued", attempts: 0 })).task.status,
    ).toBe("queued");
    expect(
      describeTask(task({ status: "queued", attempts: 1 })).task.status,
    ).toBe("retrying");
    expect(
      describeTask(
        task({
          type: "media.process",
          status: "succeeded",
          result: { status: "waiting-for-storage" },
        }),
      ).task.status,
    ).toBe("waiting-for-storage");
    expect(
      describeTask(task({ status: "succeeded", result: { cancelled: true } }))
        .task.status,
    ).toBe("cancelled");
  });
  it("holds an encode's position across a pause, but never its rate", () => {
    /*
     * The queue row behind a suspended encoder still says `running`. A card
     * that reported that said "Running · Encoding video · progress not
     * measurable yet" over a job the operator had deliberately stopped.
     */
    const held = describeTask(
      task({
        type: "media.process",
        status: "running",
        presentation: {
          determinate: false,
          outcome: "paused",
          stage: "video",
          encoding: { completedSeconds: 3_090, totalSeconds: 4_052 },
          remainingSeconds: 1_960,
        },
      }),
    );
    expect(held.task.status).toBe("paused");
    expect(held.tone).toBe("warning");
    expect(held.life).toBe("persistent");
    // Where it stopped is a fact about the file; how fast it was going is not.
    expect(held.task.stage).toBe("video");
    expect(held.task.encoding).toEqual({
      completedSeconds: 3_090,
      totalSeconds: 4_052,
    });
    expect(held.task.determinate).toBe(true);
    expect(held.progress).toBeCloseTo((3_090 / 4_052) * 100, 5);
    expect(held.task.remainingSeconds).toBeUndefined();
  });
  it("measures every phase, not only the one that encodes the picture", () => {
    // Assembling, verifying and publishing are the last stretch of every media
    // job. Without their own figure a card went blank for all of it.
    const packaging = describeTask(
      task({
        type: "media.process",
        status: "running",
        presentation: {
          determinate: false,
          stage: "packaging",
          phaseFraction: 0.081,
        },
      }),
    );
    expect(packaging.task.determinate).toBe(true);
    expect(packaging.progress).toBeCloseTo(8.1, 5);
    // The picture's own measure still leads while the picture is what is
    // happening; the two never compete.
    const encoding = describeTask(
      task({
        type: "media.process",
        status: "running",
        presentation: {
          determinate: false,
          stage: "video",
          encoding: { completedSeconds: 3_090, totalSeconds: 4_052 },
          phaseFraction: 0.5,
        },
      }),
    );
    expect(encoding.progress).toBeCloseTo((3_090 / 4_052) * 100, 5);
  });
  it.each([-0.1, 1.4, Number.NaN, Number.POSITIVE_INFINITY])(
    "refuses %s as a phase position",
    (phaseFraction) => {
      const described = describeTask(
        task({
          type: "media.process",
          status: "running",
          presentation: {
            determinate: false,
            stage: "packaging",
            phaseFraction,
          },
        }),
      );
      expect(described.task.phaseFraction).toBeUndefined();
      expect(described.task.determinate).toBe(false);
    },
  );
  it("success clears in-flight and failure fields", () => {
    const done = describeTask(
      task({ status: "succeeded", error: "stale", result: { probed: 0 } }),
    );
    expect(done).toMatchObject({ tone: "success", life: "long" });
    expect(done.progress).toBeUndefined();
    expect(done.task.stage).toBeUndefined();
    expect(done.task.errorKey).toBeUndefined();
  });
  it("suppresses history while restoring active work and tracking outcomes once", () => {
    const first = selectChangedTasks(
      [task(), task({ id: "old", status: "failed" })],
      new Map(),
      true,
    );
    expect(first.changed.map((t) => t.id)).toEqual(["task-1"]);
    const done = task({ status: "succeeded" });
    const second = selectChangedTasks([done], first.next);
    expect(second.changed).toEqual([done]);
    expect(selectChangedTasks([done], second.next).changed).toEqual([]);
  });
  it("detects attempts and separate tasks, but ignores duplicate polls", () => {
    const first = selectChangedTasks([task()], new Map());
    expect(selectChangedTasks([task()], first.next).changed).toEqual([]);
    expect(
      selectChangedTasks(
        [task({ attempts: 2 }), task({ id: "other" })],
        first.next,
      ).changed,
    ).toHaveLength(2);
  });
});

it("distinguishes a successful metadata match from partial failures", () => {
  expect(
    describeTask(
      task({
        type: "metadata.refresh",
        status: "succeeded",
        result: { status: "matched" },
      }),
    ).tone,
  ).toBe("success");
  expect(
    describeTask(
      task({ status: "succeeded", result: { probed: 4, failed: 1 } }),
    ).tone,
  ).toBe("warning");
});

it("does not raise a warning for the overwrite policy declining a foreign file", () => {
  /*
   * `managed-only` is the default: an NFO file this server did not write is
   * left where it is. That is the configuration working, and it recurs
   * identically on every scan of the same library — so a card that read it as
   * trouble was permanently amber over a job that had nothing wrong with it.
   */
  const scan = describeTask(
    task({
      type: "nfo.export.library",
      status: "succeeded",
      result: { itemsConsidered: 28, unchanged: 4, skippedConflict: 24 },
    }),
  );
  expect(scan.tone).toBe("success");
  // Still reported, on the card, as a figure rather than as an alarm.
  expect(scan.task.metrics).toContainEqual({
    metric: "skippedConflict",
    value: 24,
  });
  expect(
    describeTask(
      task({
        type: "nfo.export.library",
        status: "succeeded",
        result: { skippedConflict: 24, failed: 1 },
      }),
    ).tone,
  ).toBe("warning");
});

/**
 * The cards used to read the sentence beside the report rather than the report.
 *
 * Every maintenance executor writes a phase and a measure into its queue row —
 * the Library Maintenance page has drawn bars from them all along — and the
 * notification layer matched four regular expressions against the human
 * sentence instead. Everything they did not recognise, trickplay included,
 * came out as "Progress not measurable yet".
 */
describe("a maintenance report, read as a card reads it", () => {
  const report = (
    overrides: Partial<MaintenanceProgress> = {},
  ): MaintenanceProgress => ({
    revision: 4,
    phase: "trickplay",
    measure: { kind: "exact", completed: 61, total: 144, unit: "frames" },
    at: "2026-08-11T00:00:03Z",
    ...overrides,
  });

  it("carries an exact measure through as the phase's own fraction", () => {
    expect(presentMaintenanceProgress(report())).toEqual({
      stage: "trickplay",
      counts: { completed: 61, total: 144, unit: "frames" },
      phaseFraction: 61 / 144,
      determinate: true,
    });
  });

  it("gives the phase and no fraction for every other shape", () => {
    for (const measure of [
      { kind: "indeterminate" } as const,
      { kind: "counter", counted: 4_012, unit: "directories" } as const,
      // Not a fraction: a denominator of nought, and a numerator past its own
      // denominator, are upstream defects rather than positions.
      { kind: "exact", completed: 0, total: 0, unit: "files" } as const,
      { kind: "exact", completed: 812, total: 742, unit: "files" } as const,
    ]) {
      expect(
        presentMaintenanceProgress(report({ phase: "reading", measure })),
      ).toEqual({ stage: "reading" });
    }
    expect(presentMaintenanceProgress(null)).toBeNull();
  });

  /*
   * The two vocabularies have to stay in step: a phase a card cannot name
   * renders as a missing key, and a unit it cannot name renders a count with
   * no noun after it.
   */
  it("has a word in both languages for every phase and every unit", () => {
    for (const phase of MAINTENANCE_PHASES) {
      expect(translations.en[`tasks.${phase}`]).toBeTruthy();
      expect(translations.tr[`tasks.${phase}`]).toBeTruthy();
    }
    for (const unit of MAINTENANCE_UNITS) {
      for (const dictionary of [translations.en, translations.tr]) {
        const sentence = dictionary[`tasks.${unit}`];
        expect(sentence).toContain("{count}");
        expect(sentence).toContain("{total}");
      }
    }
  });

  it("puts a bar on the card, which is what the whole chain is for", () => {
    const card = describeTask(
      task({
        type: "trickplay.generate",
        progressMessage: "Generating trickplay",
        presentation: {
          ...presentTask("trickplay.generate", "Generating trickplay", null),
          ...presentMaintenanceProgress(report()),
        },
      }),
    );

    expect(card.task.determinate).toBe(true);
    /*
     * The number on the card is the number on the page, not a second reading
     * of the same row. Both go through `measurePercent`, so 61 of 144 frames
     * is 42 in both places rather than 42 beside 43.
     */
    const overall = describeOverall(report());
    expect(overall.kind).toBe("exact");
    expect(card.progress).toBe(
      overall.kind === "exact" ? overall.percent : NaN,
    );
    expect(card.progress).toBe(42);
    expect(card.task.counts).toEqual({
      completed: 61,
      total: 144,
      unit: "frames",
    });
  });
});

describe("one card for the waiting line", () => {
  const media = (id: string, status: TaskDto["status"], queuedAt: string) =>
    ({
      id,
      type: "media.process",
      status,
      progress: 0,
      progressMessage: null,
      attempts: 0,
      maxAttempts: 3,
      result: null,
      error: null,
      queuedAt,
      startedAt: null,
      finishedAt: null,
    }) as TaskDto;

  it("leads with what is encoding and counts the rest behind it", () => {
    const lead = selectProcessingLead([
      media("q1", "queued", "2026-09-05T10:00:00Z"),
      media("run", "running", "2026-09-05T09:00:00Z"),
      media("q2", "queued", "2026-09-05T10:01:00Z"),
    ]);
    expect(lead).toEqual({
      taskId: "run",
      queuedCount: 2,
      spokenFor: ["q1", "q2"],
    });
  });

  it("leads with the longest wait when nothing has started", () => {
    const lead = selectProcessingLead([
      media("late", "queued", "2026-09-05T10:05:00Z"),
      media("first", "queued", "2026-09-05T09:59:00Z"),
    ]);
    expect(lead).toEqual({
      taskId: "first",
      queuedCount: 1,
      spokenFor: ["late"],
    });
  });

  it("speaks for the titles behind the lead and for nothing else", () => {
    const lead = { taskId: "run", queuedCount: 2, spokenFor: ["q1", "q2"] };
    expect(isSpokenForByLead(media("q1", "queued", ""), lead)).toBe(true);
    expect(isSpokenForByLead(media("run", "running", ""), lead)).toBe(false);
    // A finished title is its own event: it has a name, a duration and an
    // outcome that no count can carry.
    expect(isSpokenForByLead(media("done", "succeeded", ""), lead)).toBe(false);
    expect(isSpokenForByLead(media("q1", "queued", ""), null)).toBe(false);
  });

  it("holds the whole line under one card when the line is held", () => {
    /*
     * The production shape of this: "pause all" on eighteen episodes. Each of
     * their queue attempts ends as `succeeded` carrying a cancelled result, so
     * reading the queue alone gave eighteen separate cards, every one of them
     * saying "Cancelled", led by the last title in the line instead of the
     * next one to run.
     */
    const held = (id: string, queuedAt: string) => ({
      ...media(id, "succeeded", queuedAt),
      result: { status: "cancelled" },
      presentation: { determinate: false, outcome: "paused" as const },
    });
    const tasks = [
      held("e10", "2026-09-05T10:02:00Z"),
      held("e09", "2026-09-05T10:01:00Z"),
      held("e11", "2026-09-05T10:03:00Z"),
    ];
    const lead = selectProcessingLead(tasks);
    expect(lead).toEqual({
      taskId: "e09",
      queuedCount: 2,
      spokenFor: ["e10", "e11"],
    });
    expect(tasks.filter((task) => isSpokenForByLead(task, lead))).toHaveLength(
      2,
    );
    // And the card that survives says it is held, not that it was cancelled.
    expect(describeTask(tasks[1]!).task.status).toBe("paused");
  });

  it("still lets a title that really was cancelled speak for itself", () => {
    const cancelled = {
      ...media("gone", "succeeded", "2026-09-05T10:00:00Z"),
      result: { status: "cancelled" },
    };
    expect(selectProcessingLead([cancelled])).toBeNull();
    expect(isSpokenForByLead(cancelled, null)).toBe(false);
  });

  it("ignores unrelated work entirely", () => {
    expect(
      selectProcessingLead([
        { ...media("scan", "running", ""), type: "library.scan" },
      ]),
    ).toBeNull();
  });

  it("puts the count on the lead's own card", () => {
    const described = describeTask(media("run", "running", ""), 9);
    expect(described.task.queuedCount).toBe(9);
    expect(describeTask(media("run", "running", "")).task.queuedCount).toBe(
      undefined,
    );
  });
});

describe("what a media job actually measures", () => {
  const encoding = (presentation: Partial<TaskPresentation>): TaskDto =>
    ({
      id: "a",
      type: "media.process",
      status: "running",
      // The queue's own stage-weighted fraction, which is not a percentage of
      // anything a viewer can see.
      progress: 0.91,
      progressMessage: null,
      attempts: 1,
      maxAttempts: 3,
      result: null,
      error: null,
      queuedAt: "",
      startedAt: "2026-09-05T09:00:00Z",
      finishedAt: null,
      presentation: { determinate: false, ...presentation },
    }) as TaskDto;

  it("reports the encode fraction rather than the queue's stage weights", () => {
    const described = describeTask(
      encoding({
        stage: "video",
        encoding: { completedSeconds: 1_381, totalSeconds: 3_794 },
        remainingSeconds: 1_975,
      }),
    );
    expect(described.progress).toBeCloseTo(36.4, 1);
    expect(described.task.determinate).toBe(true);
    expect(described.task.remainingSeconds).toBe(1_975);
  });

  it("stays indeterminate when nothing measured it", () => {
    const described = describeTask(encoding({ stage: "packaging" }));
    expect(described.task.determinate).toBe(false);
    expect(described.task.remainingSeconds).toBeUndefined();
  });

  it("refuses impossible figures instead of showing them", () => {
    const described = describeTask(
      encoding({
        encoding: { completedSeconds: 4_000, totalSeconds: 3_794 },
        remainingSeconds: -5,
      }),
    );
    expect(described.task.encoding).toBeUndefined();
    expect(described.task.determinate).toBe(false);
    expect(described.task.remainingSeconds).toBeUndefined();
  });

  it("drops a remaining time the moment the work stops running", () => {
    const described = describeTask({
      ...encoding({ remainingSeconds: 600 }),
      status: "succeeded",
    });
    expect(described.task.remainingSeconds).toBeUndefined();
  });
});

/**
 * A thumbnail sweep queues one job per title — two hundred and sixty-six of
 * them over a whole library — and the pile has to stay readable through it.
 * The two facts a person actually wants are which titles are being decoded now
 * and how many are behind them.
 */
describe("one card for the thumbnail line too", () => {
  const thumbnail = (id: string, status: TaskDto["status"], queuedAt: string) =>
    ({
      id,
      type: "trickplay.generate",
      status,
      progress: 0,
      progressMessage: null,
      attempts: 0,
      maxAttempts: 3,
      result: null,
      error: null,
      queuedAt,
      startedAt: null,
      finishedAt: null,
    }) as TaskDto;

  it("keeps a card for every title actually being decoded, and counts the rest", () => {
    // Three run at once in the library lane; the other two hundred wait.
    const tasks = [
      thumbnail("run-a", "running", "2026-09-06T08:00:00Z"),
      thumbnail("run-b", "running", "2026-09-06T08:00:01Z"),
      thumbnail("run-c", "running", "2026-09-06T08:00:02Z"),
      thumbnail("q1", "queued", "2026-09-06T08:00:03Z"),
      thumbnail("q2", "queued", "2026-09-06T08:00:04Z"),
    ];

    const leads = selectQueueLeads(tasks);
    const trickplay = leads.find((lead) => lead.taskId.startsWith("run"));

    expect(trickplay).toEqual({
      taskId: "run-a",
      queuedCount: 2,
      spokenFor: ["q1", "q2"],
    });
    // The other two decoders keep their own cards: three titles are being
    // worked on, and a single card naming one of them would be a lie.
    expect(isSpokenForByLead(tasks[1] as TaskDto, leads)).toBe(false);
    expect(isSpokenForByLead(tasks[2] as TaskDto, leads)).toBe(false);
    expect(isSpokenForByLead(tasks[3] as TaskDto, leads)).toBe(true);
  });

  it("gives encoding and trickplay a lead each, never a shared line", () => {
    const leads = selectQueueLeads([
      thumbnail("thumb", "running", "2026-09-06T08:00:00Z"),
      thumbnail("thumb-q", "queued", "2026-09-06T08:00:01Z"),
      {
        ...thumbnail("encode", "running", "2026-09-06T07:00:00Z"),
        type: "media.process",
      } as TaskDto,
    ]);

    expect(leads.map((lead) => lead.taskId).sort()).toEqual([
      "encode",
      "thumb",
    ]);
    expect(leads.find((lead) => lead.taskId === "encode")?.queuedCount).toBe(0);
    expect(leads.find((lead) => lead.taskId === "thumb")?.queuedCount).toBe(1);
  });

  it("names the title on the card rather than a bare job", () => {
    const card = describeTask(
      {
        ...thumbnail("run-a", "running", "2026-09-06T08:00:00Z"),
        progressMessage: "Generating trickplay",
        presentation: {
          determinate: false,
          stage: "trickplay",
          subject: { type: "media", label: "Dune" },
        },
      } as TaskDto,
      265,
    );

    expect(card.titleKey).toBe("tasks.trickplayGenerate");
    expect(card.task.subject?.label).toBe("Dune");
    expect(card.task.stage).toBe("trickplay");
    expect(card.task.queuedCount).toBe(265);
    /*
     * Honest: nothing measures a sprite sheet's decode, so the card must not
     * draw a figure. `determinate` is what suppresses it — the raw `progress`
     * channel still carries the queue's own zero for legacy consumers.
     */
    expect(card.task.determinate).toBe(false);
  });

  it("still leaves a single encode's line exactly as it was", () => {
    const leads = selectQueueLeads([
      {
        ...thumbnail("run", "running", "2026-09-05T09:00:00Z"),
        type: "media.process",
      } as TaskDto,
      {
        ...thumbnail("q1", "queued", "2026-09-05T10:00:00Z"),
        type: "media.process",
      } as TaskDto,
      {
        ...thumbnail("q2", "queued", "2026-09-05T10:01:00Z"),
        type: "media.process",
      } as TaskDto,
    ]);

    expect(leads).toEqual([
      { taskId: "run", queuedCount: 2, spokenFor: ["q1", "q2"] },
    ]);
  });
});

it("reports an unseen completion inside the successful observation window only once", () => {
  const boundary = Date.parse("2026-09-06T10:00:00.000Z");
  const completed = task({
    type: "library.rename",
    status: "succeeded",
    queuedAt: "2026-09-06T10:00:00.100Z",
    finishedAt: "2026-09-06T10:00:00.105Z",
  });
  const observed = selectChangedTasks([completed], new Map(), false, boundary);
  expect(observed.changed).toEqual([completed]);
  expect(
    selectChangedTasks([completed], observed.next, false, boundary).changed,
  ).toEqual([]);
  expect(
    selectChangedTasks([completed], new Map(), true, boundary).changed,
  ).toEqual([]);
  expect(
    selectChangedTasks([completed], new Map(), false, boundary + 1000).changed,
  ).toEqual([]);
});
