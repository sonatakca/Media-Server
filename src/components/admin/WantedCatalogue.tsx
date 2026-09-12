import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useLanguage } from "../../i18n/LanguageContext";
import {
  addWanted,
  listWanted,
  searchWanted,
  releaseSearchUrl,
  type WantedItem,
  type WantedLibrary,
  type WantedTitle,
} from "../../lib/wantedApi";

/**
 * Finding a title on TMDB to want. Opened from the library page's "Add a
 * movie" and "Add a show", above the library rather than in front of it.
 */
export function WantedCatalogue({
  kind,
  onAdded,
}: {
  kind: "movie" | "tv";
  onAdded?: () => void;
}) {
  const { t } = useLanguage();
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [titles, setTitles] = useState<WantedTitle[]>([]);
  const [wanted, setWanted] = useState<WantedItem[]>([]);
  const [libraries, setLibraries] = useState<WantedLibrary[]>([]);
  const [destinations, setDestinations] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState(false);
  const [saveFailure, setSaveFailure] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const refresh = () =>
      void listWanted()
        .then((data) => {
          if (!cancelled) {
            setWanted(data.items);
            setLibraries(data.libraries);
          }
        })
        .catch(() => {
          if (!cancelled) setSaveFailure(true);
        });
    refresh();
    const interval = window.setInterval(refresh, 15000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSearch(query.trim());
      setPage(1);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setFailure(false);
    void Promise.all([searchWanted(kind, search, page)])
      .then((results) => {
        if (cancelled) return;
        setTitles(results.flatMap((result) => result.items));
        setPages(Math.max(1, ...results.map((result) => result.totalPages)));
      })
      .catch(() => {
        if (!cancelled) setFailure(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [kind, search, page]);
  async function save(title: WantedTitle, libraryId: string) {
    setSaving(`${title.kind}:${title.providerId}`);
    setSaveFailure(false);
    try {
      await addWanted(title, libraryId);
      const data = await listWanted();
      setWanted(data.items);
      onAdded?.();
    } catch {
      setSaveFailure(true);
    } finally {
      setSaving(null);
    }
  }
  const control =
    "min-h-11 rounded-xl border border-white/15 bg-black/30 px-3 py-2 text-sm text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]";
  return (
    <section className="space-y-5" aria-label={t("wanted.catalogue")}>
      <div>
        <h2 className="text-xl font-bold text-white">
          {t("wanted.catalogue")}
        </h2>
        <p className="mt-1 max-w-2xl text-sm text-white/65">
          {t("wanted.description")}
        </p>
      </div>
      <form
        className="flex flex-wrap gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          setSearch(query.trim());
          setPage(1);
        }}
      >
        <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm text-white/70">
          {t("wanted.searchLabel")}
          <input
            className={control}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <button className={`${control} self-end`} type="submit">
          {t("admin.decisions.search")}
        </button>
      </form>
      {saveFailure ? (
        <p role="alert" className="text-red-200">
          {t("wanted.saveFailed")}
        </p>
      ) : null}
      {loading ? (
        <p role="status" className="text-white/65">
          {t("wanted.loading")}
        </p>
      ) : failure ? (
        <p role="alert" className="text-red-200">
          {t("wanted.loadFailed")}
        </p>
      ) : (
        <>
          <div className="grid gap-x-6 gap-y-5 lg:grid-cols-2">
            {titles.map((title) => {
              const key = `${title.kind}:${title.providerId}`;
              const existing = wanted.find(
                (item) =>
                  item.kind === title.kind &&
                  item.providerId === title.providerId,
              );
              const saved = existing?.desired === true;
              const options = libraries.filter(
                (library) =>
                  library.kind ===
                  (title.kind === "movie" ? "movies" : "series"),
              );
              const destination = destinations[key] ?? options[0]?.id ?? "";
              return (
                <article
                  key={key}
                  className="flex min-w-0 gap-4 border-b border-white/10 pb-5"
                >
                  {title.posterUrl ? (
                    <img
                      src={title.posterUrl}
                      alt=""
                      loading="lazy"
                      className="h-32 w-20 shrink-0 rounded-lg object-cover"
                    />
                  ) : null}
                  <div className="min-w-0 flex-1">
                    <h3 className="break-words font-bold text-white">
                      {title.title} {title.year ? `(${title.year})` : ""}
                    </h3>
                    <p className="text-xs text-white/65">
                      {t(
                        title.kind === "movie"
                          ? "wanted.movies"
                          : "wanted.shows",
                      )}
                    </p>
                    <p className="mt-2 line-clamp-3 text-sm text-white/65">
                      {title.overview}
                    </p>
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      {!saved && options.length > 1 ? (
                        <select
                          aria-label={`${t("wanted.library")} · ${title.title}`}
                          className={`${control} max-w-full`}
                          value={destination}
                          onChange={(event) =>
                            setDestinations((values) => ({
                              ...values,
                              [key]: event.target.value,
                            }))
                          }
                        >
                          {options.map((library) => (
                            <option key={library.id} value={library.id}>
                              {library.name}
                            </option>
                          ))}
                        </select>
                      ) : null}
                      <button
                        className={control}
                        disabled={saved || saving !== null || !destination}
                        onClick={() => void save(title, destination)}
                      >
                        {t(
                          saved
                            ? "wanted.saved"
                            : saving === key
                              ? "wanted.saving"
                              : "wanted.add",
                        )}
                      </button>
                      <Link
                        className="py-2 text-sm text-white/80 underline"
                        to={releaseSearchUrl({ ...title, id: existing?.id })}
                      >
                        {t("wanted.releases")}
                      </Link>
                    </div>
                    {!destination && !saved ? (
                      <p className="mt-2 text-xs text-amber-200">
                        {t("wanted.noLibrary")}
                      </p>
                    ) : null}
                  </div>
                </article>
              );
            })}
          </div>
          {titles.length === 0 ? (
            <p className="text-white/65">{t("wanted.noResults")}</p>
          ) : null}
          <div className="flex items-center gap-3">
            <button
              className={control}
              disabled={page <= 1}
              onClick={() => setPage((value) => value - 1)}
            >
              {t("wanted.previous")}
            </button>
            <span className="text-sm tabular-nums text-white/65">
              {page} / {pages}
            </span>
            <button
              className={control}
              disabled={page >= pages}
              onClick={() => setPage((value) => value + 1)}
            >
              {t("wanted.next")}
            </button>
          </div>
        </>
      )}
      <p className="text-xs text-white/50">{t("wanted.attribution")}</p>
    </section>
  );
}
