import { useEffect, useState } from "react";
import { ArrowRight, ChevronLeft, PanelsTopLeft } from "lucide-react";
import { Link } from "react-router-dom";
import { MediaCardSkeleton } from "../components/Skeletons";
import { useLanguage } from "../i18n/LanguageContext";
import { setDevSkeletonMode, useDevSkeletonMode } from "../lib/devSkeletonMode";
import { getUserViews } from "../lib/jellyfinApi";
import { setPageTitle } from "../lib/pageTitle";

interface PreviewRoute {
  label: string;
  to: string;
}

export function SkeletonLabPage() {
  const { t } = useLanguage();
  const isForced = useDevSkeletonMode();
  const [previewRoutes, setPreviewRoutes] = useState<PreviewRoute[]>([
    { label: t("nav.home"), to: "/home" },
  ]);

  useEffect(() => {
    setPageTitle(`${t("devtools.skeletonLab.title")} · Seyirlik`, {
      canonicalPath: "/dev/skeleton-lab",
      robots: "noindex, nofollow",
    });
  }, [t]);

  useEffect(() => {
    let isMounted = true;

    void getUserViews()
      .then((libraries) => {
        if (!isMounted) return;

        const routes: PreviewRoute[] = [{ label: t("nav.home"), to: "/home" }];
        const routeDefinitions = [
          ["movies", t("nav.movies")],
          ["tvshows", t("nav.series")],
          ["books", t("nav.books")],
        ];

        routeDefinitions.forEach(([collectionType, label]) => {
          const library = libraries.find(
            (candidate) => candidate.CollectionType === collectionType,
          );
          if (library) routes.push({ label, to: `/library/${library.Id}` });
        });

        setPreviewRoutes(routes);
      })
      .catch(() => undefined);

    return () => {
      isMounted = false;
    };
  }, [t]);

  return (
    <div className="mx-auto max-w-6xl space-y-6 pb-20">
      <Link
        to="/dev"
        className="inline-flex items-center gap-2 text-sm font-bold text-white/60 transition hover:text-white"
      >
        <ChevronLeft size={18} />
        {t("devtools.backToDevtools")}
      </Link>

      <section className="overflow-hidden rounded-3xl border border-white/10 bg-white/[0.055] p-6 shadow-2xl backdrop-blur-xl sm:p-8">
        <div className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
          <div className="max-w-3xl">
            <p className="text-sm font-black uppercase tracking-[0.22em] text-[var(--accent)]">
              {t("devtools.skeletonLab.eyebrow")}
            </p>
            <div className="mt-3 flex items-start gap-4">
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-white/10 bg-white/10 text-white">
                <PanelsTopLeft size={23} />
              </div>
              <div>
                <h1 className="text-3xl font-black text-white sm:text-4xl">
                  {t("devtools.skeletonLab.title")}
                </h1>
                <p className="mt-2 text-sm font-medium leading-6 text-white/58 sm:text-base">
                  {t("devtools.skeletonLab.description")}
                </p>
              </div>
            </div>
          </div>

          <button
            type="button"
            onClick={() => setDevSkeletonMode(!isForced)}
            aria-pressed={isForced}
            className={`min-h-14 shrink-0 rounded-2xl border px-6 text-sm font-black transition ${
              isForced
                ? "border-amber-300/50 bg-amber-300 text-black hover:bg-amber-200"
                : "border-white/15 bg-black/40 text-white hover:border-white/30 hover:bg-white/10"
            }`}
          >
            {isForced
              ? t("devtools.skeletonLab.hideSkeletons")
              : t("devtools.skeletonLab.showSkeletons")}
          </button>
        </div>
      </section>

      <section className="rounded-3xl border border-white/10 bg-black/30 p-6 shadow-2xl sm:p-8">
        <h2 className="text-xl font-black text-white">
          {t("devtools.skeletonLab.previewTitle")}
        </h2>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-white/55">
          {t("devtools.skeletonLab.previewDescription")}
        </p>
        <div className="mt-5 flex flex-wrap gap-3">
          {previewRoutes.map((route) => (
            <Link
              key={route.to}
              to={route.to}
              className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-white/12 bg-white/[0.06] px-4 text-sm font-bold text-white/72 transition hover:border-[var(--accent)]/50 hover:text-white"
            >
              {route.label}
              <ArrowRight size={16} />
            </Link>
          ))}
        </div>
      </section>

      <section className="rounded-3xl border border-white/10 bg-black/30 p-6 shadow-2xl sm:p-8">
        <h2 className="text-xl font-black text-white">
          {t("devtools.skeletonLab.cardPreviewTitle")}
        </h2>
        <div className="mt-5 flex flex-wrap items-start gap-5">
          <MediaCardSkeleton variant="poster" />
          <MediaCardSkeleton variant="landscape" />
        </div>
      </section>
    </div>
  );
}
