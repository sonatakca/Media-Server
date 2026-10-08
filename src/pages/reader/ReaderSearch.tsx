import { useEffect, useState } from "react";
import { Search } from "lucide-react";

import { useLanguage } from "../../i18n/LanguageContext";
import {
  searchBook,
  type BookSearchHit,
  type BookSearchOutcome,
} from "../../lib/bookSearchApi";

/** How often a book being prepared is asked about again. */
const PREPARING_POLL_MS = 2500;

/**
 * How long a search may take before the wait is explained. A warm search
 * answers well inside this; a slower one is the server loading its model.
 */
const SLOW_SEARCH_MS = 1500;

/**
 * The contents drawer's search: a moment described in the reader's own words,
 * answered with the passages that mean it, whatever words the book used.
 *
 * Opening the tab asks the server to prepare the book (a few minutes, once per
 * book); until then it shows how far along that is and asks again.
 */
export function ReaderSearch({
  itemId,
  active,
  chapterOf,
  onShow,
}: {
  itemId: string;
  /** The tab is on screen: prepare the book, and keep asking while it prepares. */
  active: boolean;
  /** The chapter a section belongs to, as the contents list names it. */
  chapterOf: (section: number) => string | null;
  onShow: (hit: BookSearchHit) => void;
}) {
  const { t } = useLanguage();
  const [query, setQuery] = useState("");
  /** The question last sent; empty until one is. */
  const [asked, setAsked] = useState("");
  /** Bumped to ask again: a repeat search, or a poll while preparing. */
  const [round, setRound] = useState(0);
  const [outcome, setOutcome] = useState<BookSearchOutcome | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    if (!busy) {
      return;
    }

    const timer = window.setTimeout(() => setSlow(true), SLOW_SEARCH_MS);
    return () => window.clearTimeout(timer);
  }, [busy]);

  useEffect(() => {
    if (!active) {
      return;
    }

    const controller = new AbortController();
    let pollTimer = 0;

    searchBook(itemId, asked, { signal: controller.signal })
      .then((next) => {
        setOutcome(next);
        setFailed(false);
        setBusy(false);

        if (next.state === "preparing") {
          pollTimer = window.setTimeout(
            () => setRound((value) => value + 1),
            PREPARING_POLL_MS,
          );
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setFailed(true);
          setBusy(false);
        }
      });

    return () => {
      controller.abort();
      window.clearTimeout(pollTimer);
    };
  }, [active, asked, itemId, round]);

  const hits = outcome?.state === "ready" && asked ? outcome.hits : null;

  const status = (() => {
    // Until the answer comes, whatever is on screen answered something else:
    // saying "nothing matches" now would send the reader away too early.
    if (busy) {
      return (
        <div className="rd-search-preparing" role="status">
          <p className="rd-search-preparing-title">
            {t("reader.search.searching")}
          </p>
          <div className="rd-search-meter" data-searching aria-hidden="true">
            <span />
          </div>
          {slow ? (
            <p className="rd-search-slow">
              {t("reader.search.searchingDetail")}
            </p>
          ) : null}
        </div>
      );
    }

    if (failed) {
      return <p className="rd-empty">{t("reader.search.failed")}</p>;
    }

    if (outcome?.state === "unavailable") {
      return <p className="rd-empty">{t("reader.search.unavailable")}</p>;
    }

    if (outcome?.state === "preparing") {
      const progress = outcome.progress;

      return (
        <div className="rd-search-preparing" role="status">
          <p className="rd-search-preparing-title">
            {t("reader.search.preparing")}
          </p>
          <p>{t("reader.search.preparingDetail")}</p>
          <div
            className="rd-search-meter"
            data-pending={progress === null || undefined}
            role="progressbar"
            aria-label={t("reader.search.preparing")}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={
              progress === null ? undefined : Math.round(progress * 100)
            }
          >
            <span
              style={{
                width: progress === null ? undefined : `${progress * 100}%`,
              }}
            />
          </div>
        </div>
      );
    }

    if (hits?.length === 0) {
      return <p className="rd-empty">{t("reader.search.noResults")}</p>;
    }

    if (!asked && outcome?.state === "ready") {
      return <p className="rd-empty">{t("reader.search.hint")}</p>;
    }

    return null;
  })();

  return (
    <div className="rd-search" role="tabpanel">
      <form
        className="rd-search-field"
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          const next = query.trim();

          if (next) {
            // Results already on screen stay, dimmed, until the new ones come.
            setBusy(true);
            setSlow(false);
            setAsked(next);
            setRound((value) => value + 1);
          }
        }}
      >
        <Search size={16} aria-hidden="true" />
        <input
          type="search"
          data-autofocus
          value={query}
          maxLength={300}
          enterKeyHint="search"
          placeholder={t("reader.search.placeholder")}
          aria-label={t("reader.search.label")}
          onChange={(event) => setQuery(event.target.value)}
        />
      </form>

      {status}

      {hits && hits.length > 0 ? (
        <ol className="rd-list" aria-busy={busy || undefined}>
          {hits.map((hit) => (
            <li
              key={`${hit.section}:${hit.block}:${hit.anchor}`}
              className="rd-bookmark rd-search-hit"
            >
              <button
                type="button"
                className="rd-bookmark-go"
                onClick={() => onShow(hit)}
              >
                <span className="rd-bookmark-excerpt">{hit.text}</span>
                <span className="rd-bookmark-label">
                  <span>
                    {chapterOf(hit.section) ?? t("reader.search.inBook")}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}
