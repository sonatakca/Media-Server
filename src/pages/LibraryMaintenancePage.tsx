import { useEffect, useState } from "react";
import { DatabaseZap } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { setPageTitle } from "../lib/pageTitle";
import { useLanguage } from "../i18n/LanguageContext";
import { LibraryMaintenanceActions } from "./admin/LibraryMaintenanceActions";
import { MaintenanceTasksPanel } from "./admin/MaintenanceTasksPanel";
import { MetadataEditPanel } from "./admin/MetadataEditPanel";
import {
  MAINTENANCE_TABS,
  tabFromSearch,
  type MaintenanceTab,
} from "../lib/maintenance/maintenanceView";

/**
 * Library Maintenance, in the two modes it has always actually had.
 *
 * The page used to run the library's operational work and its per-title
 * metadata editor in one column each, which made the scan controls read as a
 * toolbar above the editor rather than as work the server would be doing for
 * the next hour. They are separate modes now: one runs maintenance and watches
 * it, the other edits a title.
 *
 * The mode lives in the query string rather than in component state, so the
 * back button, a reload and a pasted link all land where the operator expects.
 */

export function LibraryMaintenancePage() {
  const { t } = useLanguage();
  const [acceptedIds, setAcceptedIds] = useState<string[]>([]);
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = tabFromSearch(searchParams.get("tab"));

  useEffect(() => {
    setPageTitle(
      `${t("maintenance.title")} · ${t("devtools.title")} · Seyirlik`,
      {
        canonicalPath: "/dev/library-maintenance",
        robots: "noindex, nofollow",
      },
    );
  }, [t]);

  const selectTab = (next: MaintenanceTab) => {
    /*
     * A push rather than a replace: switching mode is a place the operator can
     * come back to. The scan tab writes no parameter at all, so the plain URL
     * stays the plain URL.
     */
    setSearchParams(next === "scan" ? {} : { tab: next });
  };

  return (
    <div className="relative w-full space-y-6">
      <section className="overflow-hidden rounded-3xl border border-white/10 bg-white/[0.055] shadow-2xl backdrop-blur-xl">
        <div className="relative p-6 sm:p-7">
          <div className="pointer-events-none absolute -right-16 -top-24 h-56 w-56 rounded-full bg-[var(--accent)]/20 blur-3xl" />
          <div className="pointer-events-none absolute -bottom-28 left-10 h-56 w-56 rounded-full bg-white/10 blur-3xl" />
          <div className="relative mt-6 flex items-center gap-3">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-[color-mix(in_srgb,var(--accent)_30%,transparent)] bg-[var(--accent)]/10 text-[var(--accent)]">
              <DatabaseZap size={23} />
            </div>

            <div className="min-w-0">
              <p className="text-sm font-black uppercase tracking-[0.22em] text-[var(--accent)]">
                {t("maintenance.eyebrow")}
              </p>
              <h1 className="mt-1 text-3xl font-black text-white sm:text-4xl">
                {t("maintenance.title")}
              </h1>
            </div>
          </div>

          <div
            role="tablist"
            aria-label={t("maintenance.tabs.label")}
            className="relative mt-6 inline-flex rounded-2xl border border-white/10 bg-black/30 p-1"
          >
            {MAINTENANCE_TABS.map((candidate) => {
              const selected = tab === candidate;
              return (
                <button
                  key={candidate}
                  id={`maintenance-tab-${candidate}`}
                  type="button"
                  role="tab"
                  aria-controls={`maintenance-panel-${candidate}`}
                  aria-selected={selected}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => selectTab(candidate)}
                  className={`rounded-xl px-4 py-2 text-sm font-black transition focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${
                    selected
                      ? "bg-[var(--accent)] text-black shadow-[0_10px_28px_var(--accent-soft)]"
                      : "text-white/55 hover:text-white"
                  }`}
                >
                  {t(`maintenance.tab.${candidate}`)}
                </button>
              );
            })}
          </div>

          <p className="relative mt-3 max-w-2xl text-sm font-semibold leading-6 text-white/45">
            {t(
              tab === "scan"
                ? "maintenance.tab.scanHint"
                : "maintenance.tab.metadataHint",
            )}
          </p>
        </div>
      </section>

      {tab === "scan" ? (
        <div
          id="maintenance-panel-scan"
          role="tabpanel"
          aria-labelledby="maintenance-tab-scan"
          className="space-y-5"
        >
          <section className="rounded-3xl border border-white/10 bg-black/30 p-5 shadow-2xl backdrop-blur-xl">
            <p className="max-w-2xl text-sm font-semibold leading-6 text-white/40">
              {t("maintenance.allInOneHint")}
            </p>
            <LibraryMaintenanceActions
              onAccepted={(ids) =>
                setAcceptedIds((held) => [...new Set([...held, ...ids])])
              }
            />
          </section>

          <MaintenanceTasksPanel acceptedIds={acceptedIds} />
        </div>
      ) : (
        <div
          id="maintenance-panel-metadata"
          role="tabpanel"
          aria-labelledby="maintenance-tab-metadata"
        >
          <MetadataEditPanel />
        </div>
      )}
    </div>
  );
}
