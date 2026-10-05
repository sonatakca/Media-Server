import { useEffect, useState } from "react";
import { ErrorMessage } from "../components/ErrorMessage";
import { LibrarySkeleton } from "../components/Skeletons";
import { useLanguage } from "../i18n/LanguageContext";
import {
  readSavedLibraryRoutes,
  refreshLibraryRoutes,
  type LibrarySlug,
  type SavedLibraryRoute,
} from "../lib/libraryRoutes";
import { describeErrorDetail } from "../lib/userFacingError";
import { LibraryPage } from "./LibraryPage";

export function LibraryAliasPage({ slug }: { slug: LibrarySlug }) {
  const { t } = useLanguage();
  const [library, setLibrary] = useState<SavedLibraryRoute | null>(
    () => readSavedLibraryRoutes()[slug] ?? null,
  );
  const [isLoading, setIsLoading] = useState(!library);
  /*
   * The failure itself, not its text, so the text follows the page's
   * language. A registry that loads without this slug is not a failure: it
   * leaves `library` null and the page says so.
   */
  const [error, setError] = useState<{ reason: unknown } | null>(null);

  useEffect(() => {
    let active = true;
    const savedLibrary = readSavedLibraryRoutes()[slug] ?? null;

    setLibrary(savedLibrary);
    setIsLoading(!savedLibrary);
    setError(null);

    void refreshLibraryRoutes()
      .then((registry) => {
        if (!active) return;
        setLibrary(registry[slug] ?? null);
        setError(null);
      })
      .catch((reason) => {
        if (active && !savedLibrary) {
          setError({ reason });
        }
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });

    return () => {
      active = false;
    };
  }, [slug]);

  if (isLoading && !library) return <LibrarySkeleton />;
  if (error || !library) {
    return (
      <ErrorMessage
        title={t("library.unavailable")}
        message={
          error
            ? describeErrorDetail(error.reason, t) ||
              t("common.somethingWentWrong")
            : t("library.notAssigned")
        }
      />
    );
  }

  return (
    <LibraryPage
      mode="library"
      libraryId={library.id}
      canonicalPath={`/${slug}`}
    />
  );
}
