import type { ReactNode } from "react";
import { useLanguage } from "../../i18n/LanguageContext";
import { formatTemplate } from "../../lib/format";
import type { MaintenanceTaskDto } from "../../lib/maintenance/maintenanceTasks";
import {
  elapsedSeconds,
  queueWaitSeconds,
  sinceProgressSeconds,
} from "../../lib/maintenance/maintenanceView";
import { formatDuration, formatFinishedAt } from "./processingModel";
import {
  counterLines,
  errorLabel,
  failureLine,
  measureText,
  operationLabel,
  overallOf,
  scopeLabel,
} from "./maintenanceTaskPresentation";

/**
 * Everything a maintenance task will admit to, for the operator who opened it.
 *
 * The row above stays calm; this is where the diagnosis lives. Every section
 * renders only if it has something in it — a panel of dashes and "unknown" is
 * how a detail view teaches people not to open it.
 */

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-[10px] font-black uppercase tracking-[0.18em] text-white/35">
        {title}
      </p>
      <dl className="mt-2 flex flex-col gap-1.5">{children}</dl>
    </div>
  );
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-[11px] font-bold text-white/40">{label}</dt>
      <dd className="min-w-0 truncate text-right text-[12px] font-bold text-white/75">
        {value}
      </dd>
    </div>
  );
}

export interface MaintenanceTaskDetailsProps {
  task: MaintenanceTaskDto;
  /** How many tasks share this task's run. Zero when it belongs to no run. */
  runSize: number;
  nowMs: number;
}

export function MaintenanceTaskDetails({
  task,
  runSize,
  nowMs,
}: MaintenanceTaskDetailsProps) {
  const { t, language } = useLanguage();
  const overall = overallOf(task);
  const measure = measureText(overall, t);
  const counters = counterLines(
    task.result?.counters ?? task.progress?.counters,
    t,
  );
  const failures = task.result?.failures ?? [];
  const error = errorLabel(task, t);
  const wait = queueWaitSeconds(task, nowMs);
  const elapsed = elapsedSeconds(task, nowMs);
  const silent =
    task.status === "running" ? sinceProgressSeconds(task, nowMs) : null;

  return (
    <div className="mt-3 grid gap-5 rounded-2xl border border-white/[0.07] bg-black/25 p-4 sm:grid-cols-2 lg:grid-cols-3">
      <Section title={t("maintenance.detail.identity")}>
        <Row
          label={t("maintenance.detail.operation")}
          value={operationLabel(task.operation, t)}
        />
        {scopeLabel(task, t) ? (
          <Row
            label={t("maintenance.detail.scope")}
            value={scopeLabel(task, t)}
          />
        ) : null}
        <Row
          label={t("maintenance.detail.taskId")}
          value={<span className="font-mono text-[11px]">{task.id}</span>}
        />
        {task.runId ? (
          <Row
            label={t("maintenance.detail.runId")}
            value={<span className="font-mono text-[11px]">{task.runId}</span>}
          />
        ) : null}
        {runSize > 1 ? (
          <Row
            label={t("maintenance.detail.runMembers")}
            value={String(runSize)}
          />
        ) : null}
        {/* Only worth saying once an attempt has actually been retried. */}
        {task.attempts > 1 ? (
          <Row
            label={t("maintenance.detail.attempt")}
            value={formatTemplate(t("maintenance.detail.attemptValue"), {
              attempt: task.attempts,
              max: task.maxAttempts,
            })}
          />
        ) : null}
        {task.queuePosition !== undefined ? (
          <Row
            label={t("maintenance.detail.queuePosition")}
            value={String(task.queuePosition)}
          />
        ) : null}
      </Section>

      <Section title={t("maintenance.detail.timing")}>
        <Row
          label={t("maintenance.timing.queuedAt")}
          value={formatFinishedAt(task.queuedAt, language)}
        />
        {task.startedAt ? (
          <Row
            label={t("maintenance.timing.startedAt")}
            value={formatFinishedAt(task.startedAt, language)}
          />
        ) : null}
        {task.finishedAt ? (
          <Row
            label={t("maintenance.timing.finishedAt")}
            value={formatFinishedAt(task.finishedAt, language)}
          />
        ) : null}
        {task.progressAt ? (
          <Row
            label={t("maintenance.timing.lastUpdate")}
            value={formatFinishedAt(task.progressAt, language)}
          />
        ) : null}
        {wait !== null ? (
          <Row
            label={t("maintenance.timing.queueWait")}
            value={formatDuration(wait)}
          />
        ) : null}
        {elapsed !== null ? (
          <Row
            label={t("maintenance.timing.elapsed")}
            value={formatDuration(elapsed)}
          />
        ) : null}
        {/*
         * Only for a running task, and only once it has been quiet for a
         * while: the number that separates a long job from a wedged one.
         */}
        {silent !== null && silent >= 60 ? (
          <Row
            label={t("maintenance.timing.lastUpdate")}
            value={formatTemplate(t("maintenance.timing.silentFor"), {
              value: formatDuration(silent),
            })}
          />
        ) : null}
      </Section>

      {task.progress || measure ? (
        <Section title={t("maintenance.detail.execution")}>
          {task.progress ? (
            <Row
              label={t("maintenance.detail.operation")}
              value={t(`maintenance.phase.${task.progress.phase}`)}
            />
          ) : null}
          {task.progress?.current?.label ? (
            <Row
              label={t("maintenance.detail.currentItem")}
              value={
                task.progress.current.code
                  ? `${task.progress.current.label} · ${task.progress.current.code}`
                  : task.progress.current.label
              }
            />
          ) : null}
          {measure ? (
            <Row label={t("maintenance.detail.results")} value={measure} />
          ) : null}
          {/*
           * Said in words rather than implied by a missing bar. An operator
           * looking at a task with no percentage deserves to be told that the
           * server has no total, not left to wonder whether the page broke.
           */}
          {overall.kind === "exact" && overall.provisionalTotal ? (
            <p className="pt-1 text-[11px] font-semibold leading-5 text-white/35">
              {t("maintenance.measure.provisionalHint")}
            </p>
          ) : null}
          {overall.kind !== "exact" && task.status === "running" ? (
            <p className="pt-1 text-[11px] font-semibold leading-5 text-white/35">
              {t("maintenance.measure.unknownHint")}
            </p>
          ) : null}
        </Section>
      ) : null}

      {counters.length > 0 ? (
        <Section title={t("maintenance.detail.counters")}>
          {counters.map((line) => (
            <Row
              key={line.counter}
              label={line.label}
              value={line.value.toLocaleString()}
            />
          ))}
        </Section>
      ) : null}

      {error || failures.length > 0 ? (
        <div className="min-w-0 sm:col-span-2 lg:col-span-1">
          <p className="text-[10px] font-black uppercase tracking-[0.18em] text-white/35">
            {t("maintenance.detail.problems")}
          </p>
          {error ? (
            <p className="mt-2 rounded-xl border border-red-400/20 bg-red-400/10 px-3 py-2 text-[12px] font-bold text-red-100">
              {error}
            </p>
          ) : null}
          {failures.length > 0 ? (
            <>
              <p className="mt-3 text-[11px] font-bold text-white/40">
                {t("maintenance.detail.failureList")}
              </p>
              <ul className="mt-1.5 flex flex-col gap-1">
                {failures.map((failure, index) => (
                  <li
                    key={`${failure.phase}-${failure.reason}-${index}`}
                    className="truncate text-[12px] font-semibold text-white/65"
                  >
                    {failureLine(failure, t)}
                  </li>
                ))}
              </ul>
              {task.result?.failuresTruncated ? (
                <p className="mt-1.5 text-[11px] font-semibold text-white/35">
                  {formatTemplate(t("maintenance.detail.failuresTruncated"), {
                    count: failures.length,
                  })}
                </p>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
