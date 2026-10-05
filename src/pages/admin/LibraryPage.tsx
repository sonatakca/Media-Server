import { useEffect, useRef, useState } from "react";
import { BookPlus, Film, Tv, X } from "lucide-react";
import { setPageTitle } from "../../lib/pageTitle";
import { useLanguage } from "../../i18n/LanguageContext";
import { LibraryBoard } from "../../components/admin/LibraryBoard";
import { WantedCatalogue } from "../../components/admin/WantedCatalogue";
import { WorkflowSteps } from "../../components/admin/WorkflowSteps";
import { Tooltip } from "../../components/ui/Tooltip";
import { uploadBook } from "../../lib/libraryAdminApi";

interface BookUpload {
  key: string;
  fileName: string;
  state: "uploading" | "added" | "duplicate" | "failed";
  /** The title the book gave itself, or why it was refused. */
  detail: string | null;
}

/** How long after an upload the list is read again, while the scan catches up. */
const BOOK_SCAN_REFRESH_MS = [4_000, 15_000];

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
  const [bookUploads, setBookUploads] = useState<BookUpload[]>([]);
  const bookInput = useRef<HTMLInputElement>(null);
  const refreshTimers = useRef<number[]>([]);

  useEffect(
    () => () => refreshTimers.current.forEach((id) => clearTimeout(id)),
    [],
  );

  /*
   * One at a time: each is a large body on a home uplink, and the server
   * collapses the scans they queue into one anyway.
   */
  const addBooks = async (files: File[]) => {
    const batch = files.map((file, index) => ({
      key: `${Date.now()}-${index}-${file.name}`,
      fileName: file.name,
      state: "uploading" as const,
      detail: null,
    }));
    setBookUploads((current) => [...batch, ...current]);
    const settle = (key: string, update: Partial<BookUpload>) =>
      setBookUploads((current) =>
        current.map((entry) =>
          entry.key === key ? { ...entry, ...update } : entry,
        ),
      );

    let anyAdded = false;
    for (const [index, file] of files.entries()) {
      const key = batch[index]!.key;
      try {
        const report = await uploadBook(file);
        anyAdded ||= report.outcome === "added";
        settle(key, {
          state: report.outcome,
          detail: [report.title, report.author].filter(Boolean).join(" · "),
        });
      } catch (error) {
        settle(key, {
          state: "failed",
          detail: error instanceof Error ? error.message : null,
        });
      }
    }
    if (anyAdded)
      refreshTimers.current.push(
        ...BOOK_SCAN_REFRESH_MS.map((delay) =>
          window.setTimeout(() => setRefreshKey((value) => value + 1), delay),
        ),
      );
  };

  const bookStateLabel: Record<BookUpload["state"], string> = {
    uploading: t("library.bookUploading"),
    added: t("library.bookAdded"),
    duplicate: t("library.bookDuplicate"),
    failed: t("library.bookFailed"),
  };

  useEffect(() => {
    setPageTitle(`${t("library.title")} · Seyirlik`, {
      canonicalPath: "/admin/library",
      robots: "noindex, nofollow",
    });
  }, [t]);

  const addButton = (kind: "movie" | "tv" | null) =>
    `inline-flex min-h-11 items-center gap-2 rounded-xl border px-4 py-2 text-sm font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${
      kind !== null && adding === kind
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
          className="flex flex-wrap gap-2"
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
          <Tooltip content={t("library.addBooksHint")}>
            <button
              type="button"
              onClick={() => bookInput.current?.click()}
              className={addButton(null)}
            >
              <BookPlus size={15} aria-hidden="true" />
              {t("library.addBooks")}
            </button>
          </Tooltip>
          <input
            ref={bookInput}
            type="file"
            accept=".epub,application/epub+zip"
            multiple
            hidden
            data-testid="book-upload-input"
            onChange={(event) => {
              const files = Array.from(event.currentTarget.files ?? []);
              // Cleared so choosing the same file again still fires.
              event.currentTarget.value = "";
              if (files.length > 0) void addBooks(files);
            }}
          />
        </div>
      </header>

      {bookUploads.length > 0 ? (
        <section
          aria-label={t("library.addBooks")}
          className="relative rounded-2xl border border-white/10 bg-white/[0.03] p-5 pr-12"
        >
          <Tooltip content={t("library.closeBookUploads")}>
            <button
              type="button"
              onClick={() => setBookUploads([])}
              aria-label={t("library.closeBookUploads")}
              className="absolute right-3 top-3 rounded-lg p-1.5 text-white/55 transition hover:bg-white/[0.08] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
            >
              <X size={18} aria-hidden="true" />
            </button>
          </Tooltip>
          <ul className="space-y-2" aria-live="polite">
            {bookUploads.map((entry) => (
              <li
                key={entry.key}
                className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm"
              >
                <span
                  className={`font-bold ${
                    entry.state === "failed"
                      ? "text-red-300"
                      : entry.state === "uploading"
                        ? "text-white/60"
                        : "text-emerald-300"
                  }`}
                >
                  {bookStateLabel[entry.state]}
                </span>
                <span className="min-w-0 break-all font-semibold text-white/85">
                  {entry.fileName}
                </span>
                {entry.detail ? (
                  <span className="min-w-0 text-white/50">{entry.detail}</span>
                ) : null}
              </li>
            ))}
          </ul>
          {bookUploads.some((entry) => entry.state === "added") ? (
            <p className="mt-3 text-xs font-semibold text-white/45">
              {t("library.bookScanNote")}
            </p>
          ) : null}
        </section>
      ) : null}

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
