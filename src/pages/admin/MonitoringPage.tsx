import { useCallback, useEffect, useState } from "react";
import { setPageTitle } from "../../lib/pageTitle";
import { useLanguage } from "../../i18n/LanguageContext";
import { WantedCatalogue } from "../../components/admin/WantedCatalogue";
import { WorkflowSteps } from "../../components/admin/WorkflowSteps";
import {
  getMonitoring,
  listSeries,
  setEpisodeMonitoring,
  setSeasonMonitoring,
  setTitleMonitoring,
  type MonitoringChoice,
  type MonitoringView,
  type SeriesSummary,
} from "../../lib/monitoringApi";

/**
 * What Seyirlik is watching, and why each level says so.
 *
 * Every row shows its own choice beside the effective answer and the level
 * that produced it. A season reading "monitored — inherited from the series"
 * and one reading "monitored — this season's own setting" behave differently
 * the moment the series changes, and a single toggle would hide exactly that.
 */

const CHOICES: MonitoringChoice[] = ["inherit", "monitored", "unmonitored"];

export function MonitoringPage() {
  const { t } = useLanguage();
  const [series, setSeries] = useState<SeriesSummary[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [view, setView] = useState<MonitoringView | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    setPageTitle(`${t("admin.monitoring.title")} · Seyirlik`, {
      canonicalPath: "/admin/monitoring",
      robots: "noindex, nofollow",
    });
  }, [t]);

  useEffect(() => {
    let isCancelled = false;
    void (async () => {
      try {
        const rows = await listSeries();
        if (!isCancelled) setSeries(rows);
      } catch {
        if (!isCancelled) setFailure("admin.monitoring.loadFailed");
      }
    })();
    return () => {
      isCancelled = true;
    };
  }, []);

  const open = useCallback(async (itemId: string) => {
    setSelected(itemId);
    setFailure(null);
    try {
      setView(await getMonitoring(itemId));
    } catch {
      setFailure("admin.monitoring.loadFailed");
      setView(null);
    }
  }, []);

  const refresh = useCallback(async () => {
    if (selected) setView(await getMonitoring(selected));
  }, [selected]);

  return (
    <div className="w-full space-y-6">
      <WorkflowSteps current="/admin/monitoring" />
      <header>
        <h1 className="text-3xl font-black text-white">
          {t("admin.monitoring.title")}
        </h1>
        <p className="mt-1 text-sm font-semibold text-white/50">
          {t("admin.monitoring.description")}
        </p>
      </header>

      <WantedCatalogue />

      {failure ? (
        <p
          role="alert"
          className="rounded-2xl border border-red-400/30 bg-red-400/10 px-4 py-3 text-sm font-bold text-red-200"
        >
          {t(failure as "admin.monitoring.loadFailed")}
        </p>
      ) : null}

      <label className="flex flex-col gap-1">
        <span className="text-xs font-black uppercase tracking-wide text-white/45">
          {t("admin.monitoring.series")}
        </span>
        <select
          value={selected}
          onChange={(event) => void open(event.target.value)}
          className="rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
        >
          <option value="">{t("admin.monitoring.choose")}</option>
          {series.map((entry) => (
            <option key={entry.Id} value={entry.Id}>
              {entry.Name}
              {entry.ProductionYear ? ` (${entry.ProductionYear})` : ""}
            </option>
          ))}
        </select>
      </label>

      {view ? (
        <>
          <section className="rounded-3xl border border-white/10 bg-white/[0.05] p-5">
            <h2 className="text-lg font-black text-white">
              {t("admin.monitoring.titleLevel")}
            </h2>
            <label className="mt-3 flex items-center gap-3">
              <input
                type="checkbox"
                checked={view.title.monitored}
                onChange={async (event) => {
                  await setTitleMonitoring(
                    view.title.itemId,
                    event.target.checked,
                  );
                  await refresh();
                }}
                className="h-4 w-4"
              />
              <span className="text-sm font-bold text-white/80">
                {t("admin.monitoring.monitored")}
              </span>
            </label>
          </section>

          <section className="rounded-3xl border border-white/10 bg-white/[0.05] p-5">
            <h2 className="text-lg font-black text-white">
              {t("admin.monitoring.seasons")}
            </h2>
            <ul className="mt-3 space-y-2">
              {view.seasons.map((season) => (
                <li
                  key={season.seasonNumber}
                  className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-2xl border border-white/10 bg-black/25 px-4 py-3"
                >
                  <span className="text-sm font-bold text-white/80">
                    {t("admin.monitoring.season")} {season.seasonNumber}
                  </span>

                  <select
                    aria-label={`${t("admin.monitoring.season")} ${season.seasonNumber}`}
                    value={season.choice}
                    onChange={async (event) => {
                      await setSeasonMonitoring(
                        view.title.itemId,
                        season.seasonNumber,
                        event.target.value as MonitoringChoice,
                      );
                      await refresh();
                    }}
                    className="rounded-xl border border-white/10 bg-black/40 px-2 py-1 text-xs font-bold text-white"
                  >
                    {CHOICES.map((choice) => (
                      <option key={choice} value={choice}>
                        {t(
                          `admin.monitoring.choice.${choice}` as "admin.monitoring.choice.inherit",
                        )}
                      </option>
                    ))}
                  </select>

                  {/* The effective answer and its source, never just a tick. */}
                  <p className="w-full text-xs font-medium text-white/45">
                    {season.monitored
                      ? t("admin.monitoring.isMonitored")
                      : t("admin.monitoring.isNotMonitored")}{" "}
                    — {season.reason}
                  </p>
                </li>
              ))}
            </ul>
          </section>

          {view.episodes.length > 0 ? (
            <section className="rounded-3xl border border-white/10 bg-white/[0.05] p-5">
              <h2 className="text-lg font-black text-white">
                {t("admin.monitoring.episodes")}
              </h2>
              <ul className="mt-3 space-y-2">
                {view.episodes.map((episode) => (
                  <li
                    key={`${episode.seasonNumber}x${episode.episodeNumber}`}
                    className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-2xl border border-white/10 bg-black/25 px-4 py-3"
                  >
                    <span className="text-sm font-bold text-white/80">
                      S{String(episode.seasonNumber).padStart(2, "0")}E
                      {String(episode.episodeNumber).padStart(2, "0")}
                    </span>

                    <select
                      aria-label={`S${episode.seasonNumber}E${episode.episodeNumber}`}
                      value={episode.choice}
                      onChange={async (event) => {
                        await setEpisodeMonitoring(
                          view.title.itemId,
                          episode.seasonNumber,
                          episode.episodeNumber,
                          event.target.value as MonitoringChoice,
                        );
                        await refresh();
                      }}
                      className="rounded-xl border border-white/10 bg-black/40 px-2 py-1 text-xs font-bold text-white"
                    >
                      {CHOICES.map((choice) => (
                        <option key={choice} value={choice}>
                          {t(
                            `admin.monitoring.choice.${choice}` as "admin.monitoring.choice.inherit",
                          )}
                        </option>
                      ))}
                    </select>

                    <p className="w-full text-xs font-medium text-white/45">
                      {episode.monitored
                        ? t("admin.monitoring.isMonitored")
                        : t("admin.monitoring.isNotMonitored")}{" "}
                      — {episode.reason}
                    </p>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
