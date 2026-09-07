import {
  MAINTENANCE_COUNTERS,
  describeOverall,
  lifecycleOf,
  type MaintenanceCounter,
  type MaintenanceFailureReason,
  type MaintenancePhase,
  type MaintenanceLifecycle,
  type MaintenanceOverall,
  type MaintenanceSubject,
  type MaintenanceTaskDto,
} from "../../lib/maintenance/maintenanceTasks";
import { formatTemplate } from "../../lib/format";
import type { TranslationKey } from "../../i18n/translations";

/**
 * Turning a maintenance task into words, and refusing to turn it into more
 * than it says.
 *
 * Everything here is pure and takes its translator as an argument, so what the
 * page will render can be asserted directly. The one rule the module exists to
 * hold is the one the whole feature exists for: a percentage is produced only
 * from a numerator and a denominator the executor actually wrote, and there is
 * no branch anywhere below that invents either.
 */

export type Translate = (key: TranslationKey) => string;

/** A task's title line: what is being done, and what it is being done to. */
export interface TaskHeadline {
  operation: string;
  scope: string | null;
}

const NAMED_OPERATIONS = [
  "library.scan",
  "library.organize",
  "library.rename",
  "library.maintenance",
  "media.probe",
  "metadata.scan",
  "metadata.refresh",
  "trickplay.generate",
  "trickplay.scan",
] as const;
type NamedOperation = (typeof NAMED_OPERATIONS)[number];

const OPERATION_SET: ReadonlySet<string> = new Set(NAMED_OPERATIONS);

export function operationLabel(operation: string, t: Translate): string {
  /*
   * An allowlist rather than a template, because the job type is a database
   * string and a page that interpolated it into a key would render the raw
   * type — `library.scan` — the first time somebody added one.
   */
  return OPERATION_SET.has(operation)
    ? t(`maintenance.operation.${operation as NamedOperation}`)
    : t("maintenance.operation.unknown");
}

function subjectLabel(
  subject: Pick<MaintenanceSubject, "label" | "code" | "unnamed">,
  t: Translate,
): string | null {
  if (subject.label && subject.code)
    return `${subject.label} · ${subject.code}`;
  if (subject.label) return subject.label;
  if (subject.code) return subject.code;
  return subject.unnamed ? t("maintenance.scope.unnamed") : null;
}

export function scopeLabel(
  task: Pick<MaintenanceTaskDto, "scope">,
  t: Translate,
): string | null {
  const scope = task.scope;
  if (!scope) return null;
  if (scope.kind === "all-libraries") {
    return typeof scope.libraries === "number"
      ? formatTemplate(t("maintenance.scope.allLibrariesCount"), {
          count: scope.libraries,
        })
      : t("maintenance.scope.allLibraries");
  }
  if (scope.deleted) {
    return t(
      scope.kind === "library"
        ? "maintenance.scope.libraryDeleted"
        : "maintenance.scope.itemDeleted",
    );
  }
  return subjectLabel(scope, t);
}

export function headlineOf(
  task: MaintenanceTaskDto,
  t: Translate,
): TaskHeadline {
  return {
    operation: operationLabel(task.operation, t),
    scope: scopeLabel(task, t),
  };
}

export function lifecycleLabel(
  lifecycle: MaintenanceLifecycle,
  t: Translate,
): string {
  return t(`maintenance.lifecycle.${lifecycle}`);
}

/**
 * The tone a status badge wears.
 *
 * `completed-with-failures` deliberately does not read as a plain success: a
 * job that renamed nine hundred files and could not rename three must not look
 * identical to one that renamed nine hundred and three.
 */
export type TaskTone =
  | "waiting"
  | "running"
  | "good"
  | "warn"
  | "bad"
  | "muted";

export function toneOf(task: MaintenanceTaskDto, now: number): TaskTone {
  const lifecycle = lifecycleOf(task, now);
  switch (lifecycle) {
    case "running":
      return "running";
    case "queued":
    case "scheduled":
      return "waiting";
    case "retry-waiting":
      return "warn";
    case "failed":
      return "bad";
    case "cancelled":
      return "muted";
    case "succeeded":
      if (task.result?.outcome === "organize-disabled") return "warn";
      return task.result?.outcome === "completed-with-failures" ||
        task.result?.outcome === "incomplete"
        ? "warn"
        : "good";
  }
}

/**
 * What the worker is doing right now, in the words the worker chose.
 *
 * The phase, and the subject when there is one. Never a rotating filler
 * sentence: a task whose executor has said nothing yet gets its lifecycle back
 * — "Running" is more truthful than an invented activity.
 */
export function activityOf(
  task: MaintenanceTaskDto,
  t: Translate,
  now: number,
): string {
  const progress = task.progress;
  if (!progress) return lifecycleLabel(lifecycleOf(task, now), t);
  const phase = t(`maintenance.phase.${progress.phase}`);
  const subject = progress.current ? subjectLabel(progress.current, t) : null;
  return subject ? `${phase} · ${subject}` : phase;
}

/**
 * The measure, as a sentence, in whichever of the four shapes is honest.
 *
 * There is no fifth branch. A stage with a numerator and no denominator says
 * how many things it has done; a stage with neither says so; and only the
 * `exact` branch ever reaches a percentage.
 */
export function measureText(
  overall: MaintenanceOverall,
  t: Translate,
): string | null {
  switch (overall.kind) {
    case "exact":
      return formatTemplate(
        t(
          overall.provisionalTotal
            ? "maintenance.measure.exactProvisional"
            : "maintenance.measure.exact",
        ),
        {
          completed: overall.completed.toLocaleString(),
          total: overall.total.toLocaleString(),
          unit: t(`maintenance.unit.${overall.unit}`),
        },
      );
    case "counter":
      return formatTemplate(t("maintenance.measure.counter"), {
        count: overall.counted.toLocaleString(),
        unit: t(`maintenance.unit.${overall.unit}`),
      });
    case "phase":
      return formatTemplate(t("maintenance.measure.phase"), {
        // Reported zero-based by the executor; a person counts from one.
        index: overall.phaseIndex + 1,
        count: overall.phaseCount,
      });
    case "unknown":
      return null;
  }
}

/**
 * The percentage, and only when there genuinely is one.
 *
 * A separate function from `measureText` on purpose: the bar and the sentence
 * are drawn from the same reading, and a component that could render a bar
 * without having asked for a percentage is a component that can draw a bar for
 * a task that has none.
 */
export function percentOf(overall: MaintenanceOverall): number | null {
  return overall.kind === "exact" ? overall.percent : null;
}

export function overallOf(task: MaintenanceTaskDto): MaintenanceOverall {
  return describeOverall(task.progress);
}

/** One counter, ready to render: its translated name and its value. */
export interface CounterLine {
  counter: MaintenanceCounter;
  label: string;
  value: number;
}

/**
 * The counters worth showing, in the order they were declared.
 *
 * Zeroes are dropped rather than rendered as a grid of noughts — with one
 * exception no test should have to guess at: a failure counter that is present
 * is kept even at zero, because "moves failed: 0" beside "moves: 900" is the
 * reassurance, and a missing line is not.
 */
export function counterLines(
  counters: Partial<Record<MaintenanceCounter, number>> | undefined,
  t: Translate,
): CounterLine[] {
  if (!counters) return [];
  const lines: CounterLine[] = [];
  for (const counter of MAINTENANCE_COUNTERS) {
    const value = counters[counter];
    if (value === undefined) continue;
    if (value === 0 && !counter.toLowerCase().includes("failed")) continue;
    lines.push({
      counter,
      label: t(`maintenance.counter.${counter}`),
      value,
    });
  }
  return lines;
}

export function outcomeLabel(
  task: Pick<MaintenanceTaskDto, "result">,
  t: Translate,
): string | null {
  const outcome = task.result?.outcome;
  return outcome ? t(`maintenance.outcome.${outcome}`) : null;
}

export function errorLabel(
  task: Pick<MaintenanceTaskDto, "errorCode">,
  t: Translate,
): string | null {
  return task.errorCode ? t(`maintenance.error.${task.errorCode}`) : null;
}

export function failureLine(
  failure: {
    phase: MaintenancePhase;
    reason: MaintenanceFailureReason;
    subject?: MaintenanceSubject;
  },
  t: Translate,
): string {
  const reason = t(`maintenance.reason.${failure.reason}`);
  const phase = t(`maintenance.phase.${failure.phase}`);
  const subject = failure.subject ? subjectLabel(failure.subject, t) : null;
  return subject ? `${subject} — ${reason} (${phase})` : `${reason} (${phase})`;
}
