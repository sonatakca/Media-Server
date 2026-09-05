import { useEffect, useState } from "react";
import { useLanguage } from "../../i18n/LanguageContext";
import { formatMediaClock } from "../../lib/mediaClock";
import type { TranslationKey } from "../../i18n/translations";
import type { SeyirlikNotification } from "../../lib/notifications/notificationStore";

/**
 * A span of seconds as a person says it: "1 hr 5 min 25 sec".
 *
 * Whole units only, and never rounded up into a unit that has not passed —
 * a job that has run for fifty-nine seconds has not been running for a minute.
 */
function formatDuration(seconds: number, language: string): string | undefined {
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  const whole = Math.floor(seconds);
  const unit = (value: number, unit: "hour" | "minute" | "second") =>
    new Intl.NumberFormat(language, {
      style: "unit",
      unit,
      unitDisplay: "short",
    }).format(value);
  return [
    whole >= 3600 ? unit(Math.floor(whole / 3600), "hour") : "",
    whole >= 60 ? unit(Math.floor(whole / 60) % 60, "minute") : "",
    unit(whole % 60, "second"),
  ]
    .filter(Boolean)
    .join(" ");
}

export function TaskDetails({
  notification,
}: {
  notification: SeyirlikNotification;
}) {
  const { t, language } = useLanguage();
  const [now, setNow] = useState(Date.now);
  const task = notification.task!;
  /*
   * A held job is still spending wall-clock time, and the card says so with
   * the neutral "elapsed" wording below rather than "running for" — the hold
   * is on the encoder, not on the clock.
   */
  const ongoing = task.status === "running" || task.status === "paused";
  useEffect(() => {
    if (!ongoing || !task.startedAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [ongoing, task.startedAt]);
  const number = new Intl.NumberFormat(language);
  const text = (key: string) => t(`tasks.${key}` as TranslationKey);
  const start = Date.parse(task.startedAt ?? "");
  const end = ongoing ? now : Date.parse(task.finishedAt ?? "");
  const seconds = Math.floor((end - start) / 1000);
  const duration =
    Number.isFinite(seconds) && seconds >= 0
      ? formatDuration(seconds, language)
      : undefined;
  const remaining =
    task.remainingSeconds === undefined
      ? undefined
      : formatDuration(task.remainingSeconds, language);
  return (
    <div className="mt-1 space-y-1 text-xs leading-5 text-white/80">
      {/* The kind of work, which the card's own line gives up to the title of
          whatever the work is about. */}
      {task.titleKey && task.subject ? (
        <p className="font-semibold text-white/70">{t(task.titleKey)}</p>
      ) : null}
      {task.subject?.deleted ? (
        <p>{text("deleted")}</p>
      ) : task.subject?.code || task.subject?.detail ? (
        <p className="font-semibold text-white">
          {[task.subject.code, task.subject.detail].filter(Boolean).join(" · ")}
        </p>
      ) : null}
      {/* The phase says "running" already: "Running · Encoding video" spends a
          word on nothing. Every other state is the opposite — a held encoder
          is still *in* the video phase, and dropping "Paused" there would put
          the card back to reporting a suspended job as working away. */}
      <p className="font-semibold">
        {task.status === "running" && task.stage
          ? text(task.stage)
          : `${text(task.status)}${task.stage ? ` · ${text(task.stage)}` : ""}`}
      </p>
      {task.counts && (
        <p>
          {text(task.counts.unit)
            .replace("{count}", number.format(task.counts.completed))
            .replace("{total}", number.format(task.counts.total))}
        </p>
      )}
      {/* The source timeline as a clock, the way any player states a position:
          raw media seconds were a figure nobody could picture, and the page
          this card sits beside has always shown the same pair. */}
      {task.encoding && (
        <p className="tabular-nums text-white/90">
          {text("encodedClock")
            .replace(
              "{count}",
              formatMediaClock(task.encoding.completedSeconds),
            )
            .replace("{total}", formatMediaClock(task.encoding.totalSeconds))}
        </p>
      )}
      {task.metrics?.length ? (
        <dl className="grid grid-cols-[1fr_auto] gap-x-3">
          {task.metrics.map(({ metric, value }, index) => (
            <div className="contents" key={`${metric}:${index}`}>
              <dt>{text(metric)}</dt>
              <dd className="tabular-nums">{number.format(value)}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {task.status === "running" &&
        (!task.determinate || notification.progress === undefined) && (
          <p>{text("indeterminate")}</p>
        )}
      {duration && (
        <p className="tabular-nums">
          {text(
            task.status === "running"
              ? "elapsed"
              : task.status === "succeeded"
                ? "duration"
                : "timeSpent",
          ).replace("{duration}", duration)}
        </p>
      )}
      {/* Only ever shown while the rate it was measured from is still being
          reported; the server withdraws it the moment the encoder goes quiet. */}
      {remaining && (
        <p className="tabular-nums">
          {text("remaining").replace("{duration}", remaining)}
        </p>
      )}
      {/* The waiting line is the `+N` on the card's own line and nothing more:
          saying it twice on one card told nobody anything the badge had not
          already said. */}
      {task.attempts > 1 || task.status === "retrying" ? (
        <p>
          {text("attempt")
            .replace("{count}", number.format(task.attempts))
            .replace("{total}", number.format(task.maxAttempts))}
        </p>
      ) : null}
      {/* Outcomes the status line above has already spoken for are not said
          twice; what is left here is the kind that adds something. */}
      {task.outcome &&
        !["cancelled", "waiting-for-storage", "paused", "failed"].includes(
          task.outcome,
        ) && <p>{text(task.outcome)}</p>}
      {task.errorKey && <p>{t(task.errorKey)}</p>}
    </div>
  );
}
