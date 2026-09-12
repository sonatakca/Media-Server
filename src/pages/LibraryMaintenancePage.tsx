import { useEffect, useState } from "react";
import { DatabaseZap } from "lucide-react";
import { Link } from "react-router-dom";
import { setPageTitle } from "../lib/pageTitle";
import { useLanguage } from "../i18n/LanguageContext";
import { LibraryMaintenanceActions } from "./admin/LibraryMaintenanceActions";
import { MaintenanceTasksPanel } from "./admin/MaintenanceTasksPanel";

/**
 * Library Maintenance: work the server does across the whole library.
 *
 * Scans, the library-wide trickplay pass, renaming and moving — and the queue
 * that shows them running. Anything done to one title (its metadata, artwork,
 * trickplay, subtitles) lives in that title's workspace under Library, which
 * is where the per-title editor that used to be a second tab here went.
 */

export function LibraryMaintenancePage() {
  const { t } = useLanguage();
  const [acceptedIds, setAcceptedIds] = useState<string[]>([]);
  useEffect(() => {
    setPageTitle(
      `${t("maintenance.title")} · ${t("devtools.title")} · Seyirlik`,
      {
        canonicalPath: "/dev/library-maintenance",
        robots: "noindex, nofollow",
      },
    );
  }, [t]);

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

          <p className="relative mt-3 max-w-2xl text-sm font-semibold leading-6 text-white/45">
            {t("maintenance.libraryWideHint")}{" "}
            <Link to="/admin/library" className="underline">
              {t("library.title")}
            </Link>
          </p>
        </div>
      </section>

      <div className="space-y-5">
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
    </div>
  );
}
