import { describe, expect, it } from "vitest";
import { translations } from "../../i18n/translations";
import type { TranslationKey } from "../../i18n/translations";
import type {
  MaintenanceProgress,
  MaintenanceTaskDto,
} from "../../lib/maintenance/maintenanceTasks";
import {
  activityOf,
  counterLines,
  errorLabel,
  failureLine,
  headlineOf,
  lifecycleLabel,
  measureText,
  operationLabel,
  outcomeLabel,
  overallOf,
  percentOf,
  toneOf,
} from "./maintenanceTaskPresentation";

/*
 * The real English table rather than a key-echoing stub: half of what this
 * module does is choose a key, and a stub would pass whether or not the key
 * exists.
 */
const t = (key: TranslationKey) => translations.en[key];

const NOW = Date.parse("2026-09-06T10:10:00.000Z");

function task(over: Partial<MaintenanceTaskDto> = {}): MaintenanceTaskDto {
  return {
    id: "task",
    operation: "library.scan",
    status: "running",
    reorderable: false,
    attempts: 1,
    maxAttempts: 3,
    progress: null,
    result: null,
    errorCode: null,
    queuedAt: "2026-09-06T10:00:00.000Z",
    runAfter: "2026-09-06T10:00:00.000Z",
    startedAt: "2026-09-06T10:01:00.000Z",
    finishedAt: null,
    progressAt: null,
    ...over,
  };
}

function progress(
  over: Partial<MaintenanceProgress> = {},
): MaintenanceProgress {
  return {
    revision: 1,
    phase: "reading",
    measure: { kind: "indeterminate" },
    at: "2026-09-06T10:05:00.000Z",
    ...over,
  };
}

describe("naming an operation", () => {
  it("gives every job type the page runs a real label", () => {
    for (const operation of [
      "library.scan",
      "library.organize",
      "library.rename",
      "library.maintenance",
      "media.probe",
      "metadata.scan",
      "metadata.refresh",
      "trickplay.generate",
      "trickplay.scan",
    ]) {
      const label = operationLabel(operation, t);
      expect(label).toBeTruthy();
      expect(label).not.toContain(".");
    }
  });

  it("never renders a raw job type it does not know", () => {
    expect(operationLabel("library.someNewThing", t)).toBe(
      translations.en["maintenance.operation.unknown"],
    );
  });
});

describe("naming what the work is against", () => {
  it("names a library", () => {
    expect(
      headlineOf(task({ scope: { kind: "library", label: "Films" } }), t),
    ).toEqual({
      operation: translations.en["maintenance.operation.library.scan"],
      scope: "Films",
    });
  });

  it("says a library is gone rather than showing nothing", () => {
    expect(
      headlineOf(task({ scope: { kind: "library", deleted: true } }), t).scope,
    ).toBe(translations.en["maintenance.scope.libraryDeleted"]);
  });

  it("counts the libraries a library-wide operation covers", () => {
    expect(
      headlineOf(task({ scope: { kind: "all-libraries", libraries: 4 } }), t)
        .scope,
    ).toContain("4");
  });

  it("puts an episode code beside its show", () => {
    expect(
      headlineOf(
        task({ scope: { kind: "media", label: "Severance", code: "S01E03" } }),
        t,
      ).scope,
    ).toBe("Severance · S01E03");
  });

  it("has no scope line for an operation with no scope", () => {
    expect(headlineOf(task(), t).scope).toBeNull();
  });
});

describe("saying how far along the task is", () => {
  it("gives a percentage only from a fraction the executor wrote", () => {
    const measured = task({
      progress: progress({
        measure: { kind: "exact", completed: 37, total: 100, unit: "files" },
      }),
    });

    expect(percentOf(overallOf(measured))).toBe(37);
    expect(measureText(overallOf(measured), t)).toBe("37 / 100 files");
  });

  it("gives a count and no percentage when the total is unknown", () => {
    const counted = task({
      progress: progress({
        measure: { kind: "counter", counted: 4_281, unit: "files" },
      }),
    });

    expect(percentOf(overallOf(counted))).toBeNull();
    expect(measureText(overallOf(counted), t)).toBe("4,281 files");
  });

  it("says the total is still moving when the executor said so", () => {
    const provisional = task({
      progress: progress({
        measure: {
          kind: "exact",
          completed: 183,
          total: 742,
          unit: "files",
          provisionalTotal: true,
        },
      }),
    });

    expect(measureText(overallOf(provisional), t)).toBe(
      "183 of 742 files so far",
    );
    expect(percentOf(overallOf(provisional))).toBe(25);
  });

  it("counts phases from one for the reader, not from zero", () => {
    const phased = task({
      progress: progress({ phaseIndex: 2, phaseCount: 5 }),
    });

    expect(measureText(overallOf(phased), t)).toBe("Phase 3 of 5");
    expect(percentOf(overallOf(phased))).toBeNull();
  });

  it("says nothing at all, and no percentage, when nothing is measurable", () => {
    const blank = task({ progress: progress() });
    expect(measureText(overallOf(blank), t)).toBeNull();
    expect(percentOf(overallOf(blank))).toBeNull();
  });

  it("has no percentage for a task that has not reported anything", () => {
    expect(percentOf(overallOf(task()))).toBeNull();
  });
});

describe("saying what the worker is doing", () => {
  it("uses the phase the executor named, and the item it named", () => {
    expect(
      activityOf(
        task({
          progress: progress({
            phase: "analysing",
            current: { label: "Interstellar" },
          }),
        }),
        t,
        NOW,
      ),
    ).toBe(`${translations.en["maintenance.phase.analysing"]} · Interstellar`);
  });

  it("falls back to the lifecycle rather than inventing an activity", () => {
    expect(activityOf(task(), t, NOW)).toBe(
      translations.en["maintenance.lifecycle.running"],
    );
    expect(activityOf(task({ status: "queued" }), t, NOW)).toBe(
      translations.en["maintenance.lifecycle.queued"],
    );
  });

  it("admits an item it cannot name rather than dropping the phase", () => {
    expect(
      activityOf(
        task({ progress: progress({ current: { unnamed: true } }) }),
        t,
        NOW,
      ),
    ).toContain(translations.en["maintenance.scope.unnamed"]);
  });
});

describe("the tone a finished task wears", () => {
  it("does not let a partial failure read as a plain success", () => {
    expect(
      toneOf(
        task({
          status: "succeeded",
          result: {
            counters: { moved: 900, movesFailed: 3 },
            failures: [],
            outcome: "completed-with-failures",
          },
        }),
        NOW,
      ),
    ).toBe("warn");
  });

  it("calls a clean success good", () => {
    expect(
      toneOf(
        task({ status: "succeeded", result: { counters: {}, failures: [] } }),
        NOW,
      ),
    ).toBe("good");
  });

  it("separates a failure, a cancellation and a retry", () => {
    expect(toneOf(task({ status: "failed" }), NOW)).toBe("bad");
    expect(toneOf(task({ status: "cancelled" }), NOW)).toBe("muted");
    expect(
      toneOf(
        task({
          status: "queued",
          attempts: 2,
          runAfter: "2026-09-06T10:15:00.000Z",
        }),
        NOW,
      ),
    ).toBe("warn");
  });

  it("gives every lifecycle a translated word", () => {
    for (const lifecycle of [
      "queued",
      "scheduled",
      "retry-waiting",
      "running",
      "succeeded",
      "failed",
      "cancelled",
    ] as const) {
      expect(lifecycleLabel(lifecycle, t)).toBeTruthy();
    }
  });
});

describe("the counters a row will show", () => {
  it("keeps the counters the executor wrote, in a fixed order", () => {
    expect(
      counterLines({ moved: 900, filesDiscovered: 4_281 }, t).map(
        (line) => line.counter,
      ),
    ).toEqual(["filesDiscovered", "moved"]);
  });

  it("drops a zero rather than printing a grid of noughts", () => {
    expect(
      counterLines({ moved: 0, renamed: 4 }, t).map((l) => l.counter),
    ).toEqual(["renamed"]);
  });

  it("keeps a failure counter at zero, because the nought is the reassurance", () => {
    expect(
      counterLines({ moved: 900, movesFailed: 0 }, t).map((l) => l.counter),
    ).toEqual(["moved", "movesFailed"]);
  });

  it("shows nothing when there are no counters", () => {
    expect(counterLines(undefined, t)).toEqual([]);
  });
});

describe("what went wrong", () => {
  it("translates the error code and never forwards server prose", () => {
    expect(errorLabel({ errorCode: "library-deleted" }, t)).toBe(
      translations.en["maintenance.error.library-deleted"],
    );
    expect(errorLabel({ errorCode: null }, t)).toBeNull();
  });

  it("translates the outcome qualifier", () => {
    expect(
      outcomeLabel(
        {
          result: {
            counters: {},
            failures: [],
            outcome: "organize-disabled",
          },
        },
        t,
      ),
    ).toBe(translations.en["maintenance.outcome.organize-disabled"]);
  });

  it("names the item, the reason and the phase of one failure", () => {
    expect(
      failureLine(
        {
          phase: "moving",
          reason: "permission-denied",
          subject: { label: "Dune" },
        },
        t,
      ),
    ).toBe(
      `Dune — ${translations.en["maintenance.reason.permission-denied"]} (${translations.en["maintenance.phase.moving"]})`,
    );
  });

  it("still reads sensibly when the item cannot be named", () => {
    expect(failureLine({ phase: "naming", reason: "unknown" }, t)).toBe(
      `${translations.en["maintenance.reason.unknown"]} (${translations.en["maintenance.phase.naming"]})`,
    );
  });
});
