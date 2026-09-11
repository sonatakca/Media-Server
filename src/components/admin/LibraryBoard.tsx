import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronDown, Captions, Trash2 } from "lucide-react";
import { useLanguage } from "../../i18n/LanguageContext";
import type { TranslationKey } from "../../i18n/translations";
import {
  formatBytes,
  getLibraryTitle,
  listLibraryTitles,
  requestTitleSubtitles,
  toneOf,
  type HoldingFacts,
  type HoldingTone,
  type LibraryEpisode,
  type LibraryTitle,
  type LibraryTitleDetail,
  type LibraryTitleKind,
} from "../../lib/libraryAdminApi";
import { releaseSearchUrl, setWanted } from "../../lib/wantedApi";
import { getPrimaryImageUrl } from "../../lib/mediaApi";
import { RemoveTitleDialog } from "./RemoveTitleDialog";

/**
 * Everything the library holds or wants, as the Wanted page's second half.
 *
 * Colour is the first read: green is on disk, purple is on its way, red is
 * wanted and absent. Everything else on a row — size, languages, what
 * subtitles are still being looked for — is the second read.
 */

const TONE_STYLE: Record<
  HoldingTone,
  { bar: string; dot: string; pill: string }
> = {
  held: {
    bar: "border-emerald-400/30 bg-emerald-400/[0.04]",
    dot: "bg-emerald-400",
    pill: "bg-emerald-400/15 text-emerald-200",
  },
  downloading: {
    bar: "border-violet-400/30 bg-violet-400/[0.04]",
    dot: "bg-violet-400",
    pill: "bg-violet-400/15 text-violet-200",
  },
  wanted: {
    bar: "border-red-400/30 bg-red-400/[0.04]",
    dot: "bg-red-400",
    pill: "bg-red-400/15 text-red-200",
  },
  absent: {
    bar: "border-white/10 bg-white/[0.03]",
    dot: "bg-white/25",
    pill: "bg-white/10 text-white/60",
  },
  unaired: {
    bar: "border-white/10 bg-white/[0.02]",
    dot: "border border-white/35 bg-transparent",
    pill: "bg-white/5 text-white/45",
  },
};

const TONES: HoldingTone[] = ["held", "downloading", "wanted", "absent"];

/** Turkish and English first, then a count: a film can carry thirty tracks. */
const FIRST_LANGUAGES = ["tur", "eng"];
function languages(list: string[], shown = 4): string {
  const known = list
    .filter((language) => language !== "und")
    .sort(
      (a, b) =>
        (FIRST_LANGUAGES.indexOf(a) + 1 || 99) -
          (FIRST_LANGUAGES.indexOf(b) + 1 || 99) || a.localeCompare(b),
    );
  const head = known.slice(0, shown).map((language) => language.toUpperCase());
  return known.length > shown
    ? `${head.join(", ")} +${known.length - shown}`
    : head.join(", ");
}

function Facts({ facts }: { facts: HoldingFacts }) {
  const { t } = useLanguage();
  const parts = [
    facts.resolution ? `${facts.resolution}p` : null,
    facts.sizeBytes > 0 ? formatBytes(facts.sizeBytes) : null,
    languages(facts.audioLanguages)
      ? `${t("library.audio")} ${languages(facts.audioLanguages)}`
      : null,
    languages(facts.subtitleLanguages)
      ? `${t("library.subtitles")} ${languages(facts.subtitleLanguages)}`
      : facts.hasMedia
        ? `${t("library.subtitles")} —`
        : null,
    facts.pendingSubtitles.length
      ? `${t("library.lookingFor")} ${languages(facts.pendingSubtitles)}`
      : null,
    facts.processing ? t("library.processing") : null,
  ].filter(Boolean);
  if (!parts.length) return null;
  return (
    <p className="mt-1 text-xs font-medium tabular-nums text-white/55">
      {parts.join(" · ")}
    </p>
  );
}

function StatusPill({ tone }: { tone: HoldingTone }) {
  const { t } = useLanguage();
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-black uppercase tracking-wide ${TONE_STYLE[tone].pill}`}
    >
      <span
        aria-hidden="true"
        className={`h-1.5 w-1.5 rounded-full ${TONE_STYLE[tone].dot}`}
      />
      {t(`library.tone.${tone}` as TranslationKey)}
    </span>
  );
}

const button =
  "inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-white/12 bg-white/[0.06] px-3 py-1.5 text-xs font-bold text-white/80 transition hover:bg-white/[0.11] hover:text-white disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]";

function EpisodeRow({
  episode,
  wanted,
  onSubtitles,
  busy,
}: {
  episode: LibraryEpisode;
  wanted: boolean;
  onSubtitles: (itemId: string) => void;
  busy: boolean;
}) {
  const { t } = useLanguage();
  const tone = toneOf(episode, wanted && episode.monitored);
  const code = `E${String(episode.episodeNumber).padStart(2, "0")}`;
  return (
    <li className="flex flex-wrap items-start gap-x-3 gap-y-1 py-2">
      <span
        aria-hidden="true"
        className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${TONE_STYLE[tone].dot}`}
      />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-bold text-white/85">
          <span className="tabular-nums text-white/50">{code}</span>{" "}
          {episode.title ?? ""}
          <span className="sr-only">
            {" "}
            · {t(`library.tone.${tone}` as TranslationKey)}
          </span>
        </p>
        {episode.hasMedia ? (
          <Facts facts={episode} />
        ) : (
          <p className="mt-0.5 text-xs text-white/40">
            {t(`library.tone.${tone}` as TranslationKey)}
            {episode.airDate ? ` · ${episode.airDate}` : ""}
          </p>
        )}
      </div>
      {episode.id && episode.mediaFileId ? (
        <button
          type="button"
          className={button}
          disabled={busy}
          onClick={() => onSubtitles(episode.id!)}
          aria-label={`${t("library.findTurkish")} · ${code}`}
        >
          <Captions size={13} aria-hidden="true" />
          TR
        </button>
      ) : null}
    </li>
  );
}

function TitleDetail({
  title,
  onSubtitles,
  busy,
}: {
  title: LibraryTitle;
  onSubtitles: (itemId: string) => void;
  busy: boolean;
}) {
  const { t } = useLanguage();
  const [detail, setDetail] = useState<LibraryTitleDetail | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    getLibraryTitle(title.id)
      .then((value) => !cancelled && setDetail(value))
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [title.id]);

  if (failed)
    return (
      <p role="alert" className="text-xs text-red-200">
        {t("library.detailFailed")}
      </p>
    );
  if (!detail)
    return (
      <p role="status" className="text-xs text-white/50">
        {t("library.loading")}
      </p>
    );
  if (detail.kind === "movie")
    return (
      <p className="break-all text-xs text-white/50">
        {detail.fileName ?? t("library.noFile")}
      </p>
    );
  return (
    <div className="space-y-3">
      {!detail.catalogueComplete ? (
        <p className="text-xs text-amber-200">
          {t("library.catalogueOffline")}
        </p>
      ) : null}
      {detail.seasons.map((season) => {
        const held = season.episodes.filter((e) => e.hasMedia).length;
        return (
          <details
            key={season.seasonNumber}
            className="rounded-xl border border-white/10 bg-black/20"
            open={detail.seasons.length === 1}
          >
            <summary className="flex cursor-pointer list-none items-center gap-3 px-3 py-2 text-sm font-black text-white/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]">
              <span>
                {season.seasonNumber === 0
                  ? t("library.specials")
                  : `${t("library.season")} ${season.seasonNumber}`}
              </span>
              <span className="text-xs font-bold tabular-nums text-white/50">
                {held}/{season.episodes.length}
              </span>
              {/* One segment per episode: the season at a glance. */}
              <span aria-hidden="true" className="flex flex-1 gap-0.5">
                {season.episodes.map((episode) => (
                  <span
                    key={episode.episodeNumber}
                    className={`h-1.5 max-w-6 flex-1 rounded-full ${
                      TONE_STYLE[
                        toneOf(episode, title.desired && episode.monitored)
                      ].dot
                    }`}
                  />
                ))}
              </span>
            </summary>
            <ul className="divide-y divide-white/5 px-3">
              {season.episodes.map((episode) => (
                <EpisodeRow
                  key={`${episode.seasonNumber}:${episode.episodeNumber}:${episode.id ?? ""}`}
                  episode={episode}
                  wanted={title.desired}
                  onSubtitles={onSubtitles}
                  busy={busy}
                />
              ))}
            </ul>
          </details>
        );
      })}
    </div>
  );
}

async function fetchBoth(): Promise<Record<LibraryTitleKind, LibraryTitle[]>> {
  const [movie, series] = await Promise.all([
    listLibraryTitles("movie"),
    listLibraryTitles("series"),
  ]);
  return { movie, series };
}

export function LibraryBoard({ refreshKey = 0 }: { refreshKey?: number }) {
  const { t } = useLanguage();
  const [kind, setKind] = useState<LibraryTitleKind>("movie");
  const [titles, setTitles] = useState<
    Record<LibraryTitleKind, LibraryTitle[] | null>
  >({
    movie: null,
    series: null,
  });
  const [failed, setFailed] = useState(false);
  const [filter, setFilter] = useState<HoldingTone | "all">("all");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{
    tone: "ok" | "error";
    text: string;
  } | null>(null);
  const [removing, setRemoving] = useState<LibraryTitle | null>(null);

  const load = useCallback(async () => {
    try {
      setTitles(await fetchBoth());
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const refresh = () =>
      void fetchBoth()
        .then((value) => {
          if (cancelled) return;
          setTitles(value);
          setFailed(false);
        })
        .catch(() => {
          if (!cancelled) setFailed(true);
        });
    refresh();
    const interval = window.setInterval(refresh, 15000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [refreshKey]);

  const current = titles[kind];
  const counts = useMemo(() => {
    const result: Record<HoldingTone, number> = {
      held: 0,
      downloading: 0,
      wanted: 0,
      absent: 0,
      unaired: 0,
    };
    for (const title of current ?? [])
      result[toneOf(title, title.desired)] += 1;
    return result;
  }, [current]);
  const visible = (current ?? []).filter(
    (title) =>
      (filter === "all" || toneOf(title, title.desired) === filter) &&
      title.title
        .toLocaleLowerCase()
        .includes(query.trim().toLocaleLowerCase()),
  );

  async function toggleWanted(title: LibraryTitle) {
    setBusy(title.id);
    try {
      await setWanted(title.id, !title.desired);
      await load();
    } catch {
      setNotice({ tone: "error", text: t("library.saveFailed") });
    } finally {
      setBusy(null);
    }
  }

  async function findSubtitles(itemId: string) {
    setBusy(itemId);
    setNotice(null);
    try {
      const result = await requestTitleSubtitles(itemId, "tur");
      setNotice({
        tone: "ok",
        text:
          result.files === 0
            ? t("library.subtitlesNoFiles")
            : `${t("library.subtitlesQueued")} ${result.queued}/${result.files}`,
      });
      await load();
    } catch (error) {
      setNotice({
        tone: "error",
        text:
          (error as { status?: number }).status === 404
            ? t("library.subtitlesUnconfigured")
            : t("library.subtitlesFailed"),
      });
    } finally {
      setBusy(null);
    }
  }

  return (
    <section
      className="space-y-4 border-t border-white/10 pt-6"
      aria-labelledby="library-board-title"
    >
      <div>
        <h2 id="library-board-title" className="text-xl font-bold text-white">
          {t("library.title")}
        </h2>
        <p className="mt-1 max-w-2xl text-sm text-white/65">
          {t("library.description")}
        </p>
      </div>

      <div
        className="flex flex-wrap gap-2"
        role="tablist"
        aria-label={t("library.title")}
      >
        {(["movie", "series"] as const).map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={kind === value}
            onClick={() => {
              setKind(value);
              setOpen(null);
            }}
            className={`min-h-11 rounded-xl border border-white/15 px-4 py-2 text-sm font-bold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${
              kind === value
                ? "bg-white/15 ring-1 ring-white/50"
                : "bg-black/30"
            }`}
          >
            {t(value === "movie" ? "library.movies" : "library.shows")}{" "}
            <span className="tabular-nums text-white/55">
              {titles[value]?.length ?? "…"}
            </span>
          </button>
        ))}
      </div>

      <div
        className="flex flex-wrap items-center gap-2"
        role="group"
        aria-label={t("media.statusFilter")}
      >
        <button
          type="button"
          aria-pressed={filter === "all"}
          onClick={() => setFilter("all")}
          className={`rounded-full px-3 py-1 text-xs font-bold ${filter === "all" ? "bg-white/15 text-white" : "text-white/60 hover:text-white"}`}
        >
          {t("wanted.allStatuses")}
        </button>
        {TONES.map((tone) => (
          <button
            key={tone}
            type="button"
            aria-pressed={filter === tone}
            onClick={() => setFilter(filter === tone ? "all" : tone)}
            className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-bold ${filter === tone ? "bg-white/15 text-white" : "text-white/60 hover:text-white"}`}
          >
            <span
              aria-hidden="true"
              className={`h-2 w-2 rounded-full ${TONE_STYLE[tone].dot}`}
            />
            {t(`library.tone.${tone}` as TranslationKey)}
            <span className="tabular-nums text-white/45">{counts[tone]}</span>
          </button>
        ))}
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("library.filter")}
          aria-label={t("library.filter")}
          className="ml-auto min-h-9 w-full max-w-xs rounded-lg border border-white/15 bg-black/30 px-3 text-sm text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] sm:w-auto"
        />
      </div>

      {notice ? (
        <p
          role={notice.tone === "error" ? "alert" : "status"}
          className={`text-sm ${notice.tone === "error" ? "text-red-200" : "text-emerald-200"}`}
        >
          {notice.text}{" "}
          {notice.text === t("library.subtitlesUnconfigured") ? (
            <Link className="underline" to="/admin/integrations">
              {t("admin.integrations.title")}
            </Link>
          ) : null}
        </p>
      ) : null}

      {failed ? (
        <p role="alert" className="text-red-200">
          {t("library.loadFailed")}
        </p>
      ) : current === null ? (
        <p role="status" className="text-white/60">
          {t("library.loading")}
        </p>
      ) : visible.length === 0 ? (
        <p className="text-white/55">{t("library.empty")}</p>
      ) : (
        <ul className="space-y-2">
          {visible.map((title) => {
            const tone = toneOf(title, title.desired);
            const expanded = open === title.id;
            return (
              <li
                key={title.id}
                className={`rounded-xl border p-3 ${TONE_STYLE[tone].bar}`}
              >
                <div className="flex gap-3">
                  {title.hasMedia ? (
                    <img
                      src={getPrimaryImageUrl(title.id, undefined, 120)}
                      alt=""
                      loading="lazy"
                      className="h-[72px] w-12 shrink-0 rounded-md bg-white/5 object-cover"
                      onError={(event) => {
                        event.currentTarget.style.visibility = "hidden";
                      }}
                    />
                  ) : (
                    <div
                      aria-hidden="true"
                      className="h-[72px] w-12 shrink-0 rounded-md bg-white/[0.04]"
                    />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <h3 className="break-words font-bold text-white">
                        {title.title}
                        {title.year ? (
                          <span className="font-semibold text-white/50">
                            {" "}
                            ({title.year})
                          </span>
                        ) : null}
                      </h3>
                      <StatusPill tone={tone} />
                      {title.kind === "series" && title.episodeCount > 0 ? (
                        <span className="text-xs font-bold tabular-nums text-white/55">
                          {title.availableEpisodeCount}/{title.episodeCount}{" "}
                          {t("library.episodes")}
                        </span>
                      ) : null}
                      {tone === "held" && title.downloading > 0 ? (
                        <StatusPill tone="downloading" />
                      ) : null}
                    </div>
                    <Facts facts={title} />
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        className={button}
                        aria-expanded={expanded}
                        onClick={() => setOpen(expanded ? null : title.id)}
                      >
                        <ChevronDown
                          size={13}
                          aria-hidden="true"
                          className={expanded ? "rotate-180" : ""}
                        />
                        {t(
                          title.kind === "series"
                            ? "library.seasons"
                            : "library.details",
                        )}
                      </button>
                      <button
                        type="button"
                        className={button}
                        disabled={busy !== null}
                        onClick={() => void toggleWanted(title)}
                      >
                        {t(title.desired ? "wanted.unmonitor" : "wanted.add")}
                      </button>
                      <Link
                        className={button}
                        to={releaseSearchUrl({
                          ...title,
                          year: title.year ?? undefined,
                        })}
                      >
                        {t("wanted.releases")}
                      </Link>
                      {title.hasMedia ? (
                        <button
                          type="button"
                          className={button}
                          disabled={busy !== null}
                          onClick={() => void findSubtitles(title.id)}
                        >
                          <Captions size={13} aria-hidden="true" />
                          {t("library.findTurkish")}
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className={`${button} ml-auto border-rose-400/25 text-rose-200 hover:bg-rose-400/10 hover:text-rose-100`}
                        onClick={() => setRemoving(title)}
                      >
                        <Trash2 size={13} aria-hidden="true" />
                        {t("library.remove")}
                      </button>
                    </div>
                  </div>
                </div>
                {expanded ? (
                  <div className="mt-3 border-t border-white/10 pt-3">
                    <TitleDetail
                      title={title}
                      onSubtitles={(itemId) => void findSubtitles(itemId)}
                      busy={busy !== null}
                    />
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {removing ? (
        <RemoveTitleDialog
          title={removing}
          onClose={() => setRemoving(null)}
          onRemoved={(report) => {
            setRemoving(null);
            setOpen(null);
            setNotice({
              tone: report.leftovers.length ? "error" : "ok",
              text: report.leftovers.length
                ? `${t("library.removedWithLeftovers")} ${report.leftovers.join(", ")}`
                : `${t("library.removed")} ${report.title}`,
            });
            void load();
          }}
        />
      ) : null}
    </section>
  );
}
