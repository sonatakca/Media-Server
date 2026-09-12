import { useEffect } from "react";
import { setPageTitle } from "../../lib/pageTitle";
import { useLanguage } from "../../i18n/LanguageContext";
import { WantedCatalogue } from "../../components/admin/WantedCatalogue";
import { WorkflowSteps } from "../../components/admin/WorkflowSteps";

/**
 * The library, and the way into it.
 *
 * Asking for a film and seeing what the library holds were one errand split
 * across Monitoring and Content Explorer. They are one page now: find a title
 * on TMDB above, see every title and its state below, and open any of them for
 * everything that can be done to it.
 */
export function LibraryPage() {
  const { t } = useLanguage();

  useEffect(() => {
    setPageTitle(`${t("library.title")} · Seyirlik`, {
      canonicalPath: "/admin/library",
      robots: "noindex, nofollow",
    });
  }, [t]);

  return (
    <div className="w-full space-y-6">
      <WorkflowSteps current="/admin/library" />
      <header>
        <h1 className="text-3xl font-black text-white">{t("library.title")}</h1>
        <p className="mt-1 text-sm font-semibold text-white/50">
          {t("library.pageDescription")}
        </p>
      </header>
      <WantedCatalogue />
    </div>
  );
}
