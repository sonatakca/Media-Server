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
import { LibraryPage } from "./LibraryPage";

export function LibraryAliasPage({ slug }: { slug: LibrarySlug }) {
  const { t } = useLanguage();
  const [library, setLibrary] = useState<SavedLibraryRoute | null>(
    () => readSavedLibraryRoutes()[slug] ?? null,
  );
  const [isLoading, setIsLoading] = useState(!library);
  // A reason from the server; an unassigned slug is not an error, just no library.
  const [error, setError] = useState<string | null>(null);

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
          setError(reason instanceof Error ? reason.message : String(reason));
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
        message={error ?? t("library.notAssigned")}
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
