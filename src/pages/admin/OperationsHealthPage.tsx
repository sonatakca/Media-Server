import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, RefreshCw } from "lucide-react";
import { setPageTitle } from "../../lib/pageTitle";
import { useLanguage } from "../../i18n/LanguageContext";
import {
  attentionCount,
  buildHealthSignals,
  needsOperator,
  overallVerdict,
  type HealthSignal,
  type OverallVerdict,
  type SignalTier,
} from "../../lib/operationsHealth";
import {
  fetchOperationsSnapshot,
  type OperationsSnapshot,
} from "../../lib/operationsApi";

/**
 * What the server is doing, for somebody who has to keep it running.
 *
 * The page is deliberately plain. Its job is to answer three questions in
 * order — is it serving, what is not working, what is waiting for me — and a
 * dashboard that answered them in a prettier order would be a worse dashboard.
 */

const VERDICT_TONE: Record<OverallVerdict, string> = {
  serving: "border-emerald-400/30 bg-emerald-400/10 text-emerald-200",
  degraded: "border-amber-400/30 bg-amber-400/10 text-amber-200",
  starting: "border-sky-400/30 bg-sky-400/10 text-sky-200",
  "not-serving": "border-red-400/35 bg-red-400/10 text-red-200",
  unreachable: "border-red-400/35 bg-red-400/10 text-red-200",
};

const STATE_TONE: Record<HealthSignal["state"], string> = {
  ok: "text-emerald-300",
  degraded: "text-amber-300",
  down: "text-red-300",
  off: "text-white/35",
  unknown: "text-white/45",
};

const TIER_ORDER: SignalTier[] = [
  "core",
  "capability",
  "dependency",
  "attention",
];

export function OperationsHealthPage() {
  const { t } = useLanguage();
  const [snapshot, setSnapshot] = useState<OperationsSnapshot | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [refreshedAt, setRefreshedAt] = useState<Date | null>(null);

  /*
   * The first read and a refresh are deliberately not the same function. The
   * refresh may set the spinner immediately, because a person just asked for
   * it; the mount may not, because a state write in the body of an effect
   * schedules a second render before the first has painted. The mount also
   * discards its answer if the page has gone, which a fetch started at mount
   * otherwise would not.
   */
  const refresh = useCallback(async () => {
    setIsLoading(true);
    try {
      setSnapshot(await fetchOperationsSnapshot());
      setRefreshedAt(new Date());
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    setPageTitle(`${t("admin.health.title")} · Seyirlik`, {
      canonicalPath: "/admin/health",
      robots: "noindex, nofollow",
    });
  }, [t]);

  useEffect(() => {
    let isCancelled = false;

    void (async () => {
      try {
        const next = await fetchOperationsSnapshot();
        if (isCancelled) return;
        setSnapshot(next);
        setRefreshedAt(new Date());
      } finally {
        if (!isCancelled) setIsLoading(false);
      }
    })();

    return () => {
      isCancelled = true;
    };
  }, []);

  const signals = snapshot ? buildHealthSignals(snapshot.input) : [];
  const verdict = snapshot ? overallVerdict(signals) : null;
  const waiting = attentionCount(signals);

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="flex items-center justify-between gap-4">
        <Link
          to="/admin"
          className="inline-flex items-center gap-2 text-sm font-bold text-white/50 transition hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
        >
          <ArrowLeft size={16} />
          {t("admin.title")}
        </Link>

        <button
          type="button"
          onClick={() => void refresh()}
          disabled={isLoading}
          className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.06] px-4 py-2 text-sm font-bold text-white/70 transition hover:text-white disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
        >
          <RefreshCw size={15} className={isLoading ? "animate-spin" : ""} />
          {t("admin.health.refresh")}
        </button>
      </div>

      <section
        className={`rounded-3xl border p-6 ${
          verdict
            ? VERDICT_TONE[verdict]
            : "border-white/10 bg-white/[0.05] text-white/60"
        }`}
        aria-live="polite"
      >
        <p className="text-xs font-black uppercase tracking-[0.2em] opacity-70">
          {t("admin.health.title")}
        </p>

        <h1 className="mt-2 text-3xl font-black">
          {verdict
            ? t(
                `admin.health.verdict.${verdict}` as "admin.health.verdict.serving",
              )
            : t("admin.health.checking")}
        </h1>

        {verdict && needsOperator(verdict) ? (
          <p className="mt-2 text-sm font-semibold opacity-90">
            {t("admin.health.needsOperator")}
          </p>
        ) : null}

        {refreshedAt ? (
          <p className="mt-3 text-xs font-semibold opacity-60">
            {t("admin.health.checkedAt")} {refreshedAt.toLocaleTimeString()}
          </p>
        ) : null}
      </section>

      {waiting > 0 ? (
        <section className="rounded-3xl border border-white/10 bg-white/[0.05] p-5">
          <h2 className="text-lg font-black text-white">
            {t("admin.health.waiting")}
          </h2>

          <ul className="mt-3 space-y-2">
            {signals
              .filter(
                (signal) =>
                  signal.tier === "attention" && (signal.count ?? 0) > 0,
              )
              .map((signal) => (
                <li
                  key={signal.id}
                  className="flex items-center justify-between gap-4 rounded-2xl border border-white/10 bg-black/25 px-4 py-3"
                >
                  <span className="text-sm font-bold text-white/80">
                    {t(
                      `admin.health.signal.${signal.id}` as "admin.health.signal.server",
                    )}
                  </span>

                  <span className="text-sm font-black text-amber-300">
                    {signal.count}
                  </span>
                </li>
              ))}
          </ul>
        </section>
      ) : null}

      {TIER_ORDER.filter((tier) => tier !== "attention").map((tier) => {
        const inTier = signals.filter((signal) => signal.tier === tier);
        if (inTier.length === 0) return null;

        return (
          <section
            key={tier}
            className="rounded-3xl border border-white/10 bg-white/[0.05] p-5"
            aria-labelledby={`tier-${tier}`}
          >
            <h2 id={`tier-${tier}`} className="text-lg font-black text-white">
              {t(`admin.health.tier.${tier}` as "admin.health.tier.core")}
            </h2>

            <p className="mt-1 text-sm font-medium text-white/45">
              {t(
                `admin.health.tierDescription.${tier}` as "admin.health.tierDescription.core",
              )}
            </p>

            <ul className="mt-3 space-y-2">
              {inTier.map((signal) => (
                <li
                  key={signal.id}
                  className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 rounded-2xl border border-white/10 bg-black/25 px-4 py-3"
                >
                  <span className="text-sm font-bold text-white/80">
                    {t(
                      `admin.health.signal.${signal.id}` as "admin.health.signal.server",
                    )}
                  </span>

                  <span
                    className={`text-sm font-black ${STATE_TONE[signal.state]}`}
                  >
                    {t(
                      `admin.health.state.${signal.state}` as "admin.health.state.ok",
                    )}
                  </span>

                  {signal.detail ? (
                    <p className="w-full text-xs font-medium text-white/40">
                      {signal.detail}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        );
      })}

      {snapshot && snapshot.unreachable.length > 0 ? (
        <section className="rounded-3xl border border-white/10 bg-white/[0.03] p-5">
          <h2 className="text-sm font-black text-white/70">
            {t("admin.health.notAnswered")}
          </h2>

          <p className="mt-1 text-sm font-medium text-white/45">
            {snapshot.unreachable.join(", ")}
          </p>
        </section>
      ) : null}
    </div>
  );
}
