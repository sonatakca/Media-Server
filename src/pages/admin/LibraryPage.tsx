import { useEffect, useState } from "react";
import { Film, Tv, X } from "lucide-react";
import { setPageTitle } from "../../lib/pageTitle";
import { useLanguage } from "../../i18n/LanguageContext";
import { LibraryBoard } from "../../components/admin/LibraryBoard";
import { WantedCatalogue } from "../../components/admin/WantedCatalogue";
import { WorkflowSteps } from "../../components/admin/WorkflowSteps";
import { Tooltip } from "../../components/ui/Tooltip";

/**
 * The library, and the way into it.
 *
 * The library itself comes first — it is what this page is opened for most
 * days. Finding a title on TMDB is a panel that "Add a movie" and "Add a show"
 * open above it and close again, rather than a catalogue to scroll past.
 */
export function LibraryPage() {
  const { t } = useLanguage();
  const [adding, setAdding] = useState<"movie" | "tv" | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    setPageTitle(`${t("library.title")} · Seyirlik`, {
      canonicalPath: "/admin/library",
      robots: "noindex, nofollow",
    });
  }, [t]);

  const addButton = (kind: "movie" | "tv") =>
    `inline-flex min-h-11 items-center gap-2 rounded-xl border px-4 py-2 text-sm font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${
      adding === kind
        ? "border-white/50 bg-white/15 text-white"
        : "border-white/15 bg-black/30 text-white/85 hover:text-white"
    }`;

  return (
    <div className="w-full space-y-6">
      <WorkflowSteps current="/admin/library" />
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-black text-white">
            {t("library.title")}
          </h1>
          <p className="mt-1 text-sm font-semibold text-white/50">
            {t("library.pageDescription")}
          </p>
        </div>
        <div
          className="flex gap-2"
          role="group"
          aria-label={t("wanted.catalogue")}
        >
          <button
            type="button"
            aria-pressed={adding === "movie"}
            aria-expanded={adding === "movie"}
            onClick={() => setAdding(adding === "movie" ? null : "movie")}
            className={addButton("movie")}
          >
            <Film size={15} aria-hidden="true" />
            {t("wanted.addMovie")}
          </button>
          <button
            type="button"
            aria-pressed={adding === "tv"}
            aria-expanded={adding === "tv"}
            onClick={() => setAdding(adding === "tv" ? null : "tv")}
            className={addButton("tv")}
          >
            <Tv size={15} aria-hidden="true" />
            {t("wanted.addShow")}
          </button>
        </div>
      </header>

      {adding ? (
        <section className="relative rounded-2xl border border-white/10 bg-white/[0.03] p-5">
          <Tooltip content={t("library.closeSearch")}>
            <button
              type="button"
              onClick={() => setAdding(null)}
              aria-label={t("library.closeSearch")}
              className="absolute right-3 top-3 rounded-lg p-1.5 text-white/55 transition hover:bg-white/[0.08] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
            >
              <X size={18} aria-hidden="true" />
            </button>
          </Tooltip>
          <WantedCatalogue
            key={adding}
            kind={adding}
            onAdded={() => setRefreshKey((value) => value + 1)}
          />
        </section>
      ) : null}

      <LibraryBoard refreshKey={refreshKey} />
    </div>
  );
}
