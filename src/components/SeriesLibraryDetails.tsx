import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, Play } from "lucide-react";
import { Link } from "react-router-dom";
import { BackButton } from "./BackButton";
import { ErrorMessage } from "./ErrorMessage";
import { MediaCard } from "./MediaCard";
import { MobileMediaCard } from "./mobile/MobileMediaCard";
import { MotionReveal } from "./MotionReveal";
import { useLanguage } from "../i18n/LanguageContext";
import {
  getItem,
  getLocalTrailers,
  getLogoImageUrl,
  getPrimaryImageUrl,
  getSeasonEpisodes,
  getSeriesSeasons,
  getSimilarItems,
} from "../lib/jellyfinApi";
import { getDisplayTitle } from "../lib/format";
import { getRouteForItem, getWatchRouteForItem } from "../lib/routes";
import { setPageTitle } from "../lib/pageTitle";
import type { JellyfinItem } from "../lib/types";

interface JellyfinPerson {
  Id?: string;
  Name?: string;
  Role?: string;
  Type?: string;
  PrimaryImageTag?: string;
}

interface JellyfinStudio {
  Id?: string;
  Name?: string;
}

type SeriesDetailsItem = JellyfinItem & {
  People?: JellyfinPerson[];
  Studios?: JellyfinStudio[];
};

interface SeriesLibraryDetailsProps {
  initialItem: JellyfinItem;
  variant: "desktop" | "mobile";
  canonicalPath: string;
}

interface MediaShelfProps {
  title: string;
  headerControl?: ReactNode;
  children: ReactNode;
  variant: "desktop" | "mobile";
}

function MediaShelf({
  title,
  headerControl,
  children,
  variant,
}: MediaShelfProps) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const updateScrollState = () => {
    const scroller = scrollerRef.current;

    if (!scroller) {
      return;
    }

    const maxScrollLeft = scroller.scrollWidth - scroller.clientWidth;
    setCanScrollLeft(scroller.scrollLeft > 2);
    setCanScrollRight(scroller.scrollLeft < maxScrollLeft - 2);
  };

  useEffect(() => {
    updateScrollState();

    const scroller = scrollerRef.current;

    if (!scroller) {
      return undefined;
    }

    const resizeObserver = new ResizeObserver(updateScrollState);
    resizeObserver.observe(scroller);
    window.addEventListener("resize", updateScrollState);

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", updateScrollState);
    };
  }, [children]);

  const scroll = (direction: "left" | "right") => {
    const scroller = scrollerRef.current;

    if (!scroller) {
      return;
    }

    scroller.scrollBy({
      left:
        direction === "left"
          ? -scroller.clientWidth * 0.82
          : scroller.clientWidth * 0.82,
      behavior: "smooth",
    });
  };

  return (
    <MotionReveal className={variant === "desktop" ? "py-5" : "py-3"}>
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">{headerControl}</div>

        {variant === "desktop" ? (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => scroll("left")}
              disabled={!canScrollLeft}
              className="grid h-9 w-9 place-items-center rounded-full border border-white/10 bg-white/[0.06] text-white transition hover:bg-white/[0.12] disabled:pointer-events-none disabled:opacity-25"
              aria-label={`Scroll ${title} left`}
            >
              <ChevronLeft size={19} />
            </button>
            <button
              type="button"
              onClick={() => scroll("right")}
              disabled={!canScrollRight}
              className="grid h-9 w-9 place-items-center rounded-full border border-white/10 bg-white/[0.06] text-white transition hover:bg-white/[0.12] disabled:pointer-events-none disabled:opacity-25"
              aria-label={`Scroll ${title} right`}
            >
              <ChevronRight size={19} />
            </button>
          </div>
        ) : null}
      </div>

      <div
        ref={scrollerRef}
        onScroll={updateScrollState}
        className="media-scroll flex snap-x gap-3 overflow-x-auto overflow-y-visible pb-5 pt-1 sm:gap-4"
      >
        {children}
      </div>
    </MotionReveal>
  );
}

function SeriesDetailsLoading({ variant }: { variant: "desktop" | "mobile" }) {
  return (
    <div
      className={variant === "desktop" ? "space-y-8 pb-12" : "space-y-5 pb-7"}
    >
      <div className="shimmer h-10 w-24 rounded-full" />
      <div className="shimmer mx-auto h-20 w-72 max-w-[70vw] rounded-2xl" />
      {Array.from({ length: 4 }, (_, index) => (
        <div key={index}>
          <div className="shimmer mb-4 h-7 w-36 rounded-lg" />
          <div className="flex gap-4 overflow-hidden">
            {Array.from({ length: 4 }, (_, cardIndex) => (
              <div
                key={cardIndex}
                className="shimmer aspect-video w-72 shrink-0 rounded-xl"
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function formatDate(value: string | undefined, language: "en" | "tr") {
  if (!value) {
    return null;
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return new Intl.DateTimeFormat(language === "tr" ? "tr-TR" : "en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(date);
}

function getSeasonLabel(season: JellyfinItem, language: "en" | "tr"): string {
  if (typeof season.IndexNumber === "number" && season.IndexNumber >= 0) {
    return language === "tr"
      ? `${season.IndexNumber}. Sezon`
      : `Season ${season.IndexNumber}`;
  }

  return season.Name;
}

function sortSeasons(left: JellyfinItem, right: JellyfinItem) {
  return (
    (left.IndexNumber ?? Number.MAX_SAFE_INTEGER) -
      (right.IndexNumber ?? Number.MAX_SAFE_INTEGER) ||
    left.Name.localeCompare(right.Name, undefined, { numeric: true })
  );
}

function sortEpisodes(left: JellyfinItem, right: JellyfinItem) {
  return (
    (left.IndexNumber ?? Number.MAX_SAFE_INTEGER) -
      (right.IndexNumber ?? Number.MAX_SAFE_INTEGER) ||
    left.Name.localeCompare(right.Name, undefined, { numeric: true })
  );
}

export function SeriesLibraryDetails({
  initialItem,
  variant,
  canonicalPath,
}: SeriesLibraryDetailsProps) {
  const { language, t } = useLanguage();
  const [series, setSeries] = useState<SeriesDetailsItem | null>(null);
  const [seasons, setSeasons] = useState<JellyfinItem[]>([]);
  const [selectedSeasonId, setSelectedSeasonId] = useState<string | null>(null);
  const [episodes, setEpisodes] = useState<JellyfinItem[]>([]);
  const [trailers, setTrailers] = useState<JellyfinItem[]>([]);
  const [similarItems, setSimilarItems] = useState<JellyfinItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingEpisodes, setIsLoadingEpisodes] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isDesktop = variant === "desktop";
  const seriesId =
    initialItem.Type === "Series"
      ? initialItem.Id
      : (initialItem.SeriesId ?? initialItem.ParentId);
  const routeSeasonId = initialItem.Type === "Season" ? initialItem.Id : null;

  useEffect(() => {
    let cancelled = false;

    async function loadDetails() {
      if (!seriesId) {
        setError(
          language === "tr"
            ? "Bu sezonun bağlı olduğu dizi bulunamadı."
            : "The series connected to this season could not be found.",
        );
        setIsLoading(false);
        return;
      }

      setIsLoading(true);
      setError(null);

      try {
        const [seriesResult, seasonResults, trailerResults, similarResults] =
          await Promise.all([
            initialItem.Type === "Series"
              ? Promise.resolve(initialItem as SeriesDetailsItem)
              : getItem(seriesId).then((item) => item as SeriesDetailsItem),
            getSeriesSeasons(seriesId),
            getLocalTrailers(seriesId).catch(() => []),
            getSimilarItems(seriesId, 18).catch(() => []),
          ]);

        if (cancelled) {
          return;
        }

        const orderedSeasons = [...seasonResults].sort(sortSeasons);
        const defaultSeason =
          orderedSeasons.find((season) => season.Id === routeSeasonId) ??
          orderedSeasons.find((season) => season.IndexNumber === 1) ??
          orderedSeasons[0] ??
          null;

        setSeries(seriesResult);
        setSeasons(orderedSeasons);
        setTrailers(trailerResults);
        setSimilarItems(
          similarResults.filter((item) => item.Id !== seriesResult.Id),
        );
        setSelectedSeasonId(defaultSeason?.Id ?? null);
      } catch (loadError) {
        if (!cancelled) {
          setError(
            loadError instanceof Error
              ? loadError.message
              : language === "tr"
                ? "Dizi ayrıntıları yüklenemedi."
                : "Series details could not be loaded.",
          );
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }

    void loadDetails();

    return () => {
      cancelled = true;
    };
  }, [initialItem, language, routeSeasonId, seriesId]);

  useEffect(() => {
    let cancelled = false;

    async function loadEpisodes() {
      if (!seriesId || !selectedSeasonId) {
        setEpisodes([]);
        return;
      }

      setIsLoadingEpisodes(true);

      try {
        const episodeResults = await getSeasonEpisodes(
          seriesId,
          selectedSeasonId,
        );

        if (!cancelled) {
          setEpisodes([...episodeResults].sort(sortEpisodes));
        }
      } catch (episodeError) {
        if (!cancelled) {
          console.warn("[Seyirlik Series Details] Could not load episodes", {
            seriesId,
            selectedSeasonId,
            error: episodeError,
          });
          setEpisodes([]);
        }
      } finally {
        if (!cancelled) {
          setIsLoadingEpisodes(false);
        }
      }
    }

    void loadEpisodes();

    return () => {
      cancelled = true;
    };
  }, [selectedSeasonId, seriesId]);

  const title = useMemo(() => {
    if (!series) {
      return initialItem.Name;
    }

    return getDisplayTitle(series, {
      season: t("media.seasonNumber"),
      hourShort: t("format.hourShort"),
      minuteShort: t("format.minuteShort"),
    });
  }, [initialItem.Name, series, t]);

  useEffect(() => {
    if (!title) {
      return;
    }

    setPageTitle(`${title} · Seyirlik`, {
      canonicalPath,
      robots: "noindex, nofollow",
    });
  }, [canonicalPath, title]);

  if (isLoading) {
    return <SeriesDetailsLoading variant={variant} />;
  }

  if (error || !series) {
    return (
      <ErrorMessage
        title={language === "tr" ? "Dizi kullanılamıyor" : "Series unavailable"}
        message={error ?? "Unknown error"}
      />
    );
  }

  const logoUrl = series.ImageTags?.Logo
    ? getLogoImageUrl(series.Id, series.ImageTags.Logo, isDesktop ? 1100 : 700)
    : "";
  const selectedSeason = seasons.find(
    (season) => season.Id === selectedSeasonId,
  );
  const cast = (series.People ?? []).filter(
    (person) => person.Name && (person.Type === "Actor" || person.Role),
  );
  const studios = (series.Studios ?? [])
    .map((studio) => studio.Name)
    .filter((name): name is string => Boolean(name));
  const releaseDate = formatDate(series.PremiereDate, language);
  const ratingPercent =
    typeof series.CommunityRating === "number"
      ? Math.round(series.CommunityRating * 10)
      : null;
  const labels =
    language === "tr"
      ? {
          episodes: "Bölümler",
          trailers: "Fragmanlar",
          trailerLabel: "Fragman",
          similar: "Benzerler",
          cast: "Oyuncular ve teknik ekip",
          about: "Hakkında",
          information: "Bilgiler",
          studio: "Stüdyo",
          release: "Yayın tarihi",
          ageRating: "Yaş sınırı",
          noEpisodes: "Bu sezon için bölüm bulunamadı.",
          selectSeason: "Sezon seç",
        }
      : {
          episodes: "Episodes",
          trailers: "Trailers",
          trailerLabel: "Trailer",
          similar: "Similar",
          cast: "Cast and crew",
          about: "About",
          information: "Information",
          studio: "Studio",
          release: "Release",
          ageRating: "Age rating",
          noEpisodes: "No episodes were found for this season.",
          selectSeason: "Select season",
        };

  const seasonSelector =
    seasons.length > 0 ? (
      <label className="relative shrink-0">
        <span className="sr-only">{labels.selectSeason}</span>
        <select
          value={selectedSeasonId ?? ""}
          onChange={(event) => setSelectedSeasonId(event.target.value)}
          className={
            isDesktop
              ? "h-10 rounded-xl bg-transparent px-3 pr-9 text-sm font-black text-white outline-none transition hover:bg-white/[0.12] cursor-pointer focus:border-white/30"
              : "h-9 max-w-[46vw] rounded-lg border border-white/12 bg-white/[0.08] px-2 pr-8 text-xs font-black text-white outline-none"
          }
        >
          {seasons.map((season) => (
            <option key={season.Id} value={season.Id}>
              {getSeasonLabel(season, language)}
            </option>
          ))}
        </select>
      </label>
    ) : null;

  return (
    <div className={isDesktop ? "pb-14" : "pb-7"}>
      <MediaShelf
        title={labels.episodes}
        headerControl={seasonSelector}
        variant={variant}
      >
        {isLoadingEpisodes ? (
          Array.from({ length: 4 }, (_, index) => (
            <div
              key={index}
              className={
                isDesktop
                  ? "shimmer aspect-video w-80 shrink-0 rounded-xl"
                  : "shimmer aspect-video w-[78vw] shrink-0 rounded-xl"
              }
            />
          ))
        ) : episodes.length > 0 ? (
          episodes.map((episode, index) => (
            <div key={episode.Id} className="snap-start">
              {isDesktop ? (
                <MediaCard
                  item={episode}
                  to={getRouteForItem(episode)}
                  variant="landscape"
                  index={index}
                  animateIn
                  showPlayFromBeginning
                />
              ) : (
                <MobileMediaCard
                  item={episode}
                  to={getRouteForItem(episode)}
                  variant="landscape"
                />
              )}
            </div>
          ))
        ) : (
          <p className="rounded-xl border border-white/10 bg-white/[0.04] px-4 py-5 text-sm text-white/55">
            {labels.noEpisodes}
          </p>
        )}
      </MediaShelf>

      {trailers.length > 0 ? (
        <MediaShelf title={labels.trailers} variant={variant}>
          {trailers.map((trailer) => (
            <Link
              key={trailer.Id}
              to={getWatchRouteForItem(trailer)}
              className={
                isDesktop
                  ? "group relative aspect-video w-80 shrink-0 snap-start overflow-hidden rounded-xl border border-white/10 bg-zinc-900"
                  : "group relative aspect-video w-[78vw] shrink-0 snap-start overflow-hidden rounded-xl border border-white/10 bg-zinc-900"
              }
            >
              <img
                src={getPrimaryImageUrl(
                  trailer.Id,
                  trailer.ImageTags?.Primary,
                  isDesktop ? 900 : 650,
                )}
                alt={trailer.Name}
                loading="lazy"
                className="h-full w-full object-cover transition duration-500 group-hover:scale-[1.04]"
              />
              <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/10 to-transparent" />
              <div className="absolute inset-x-0 bottom-0 flex items-center gap-2 p-3 text-white">
                <span className="grid h-8 w-8 place-items-center rounded-full bg-white text-black">
                  <Play size={15} fill="currentColor" />
                </span>
                <span className="line-clamp-1 text-sm font-black">
                  {labels.trailerLabel}
                </span>
              </div>
            </Link>
          ))}
        </MediaShelf>
      ) : null}

      {similarItems.length > 0 ? (
        <MediaShelf title={labels.similar} variant={variant}>
          {similarItems.map((item, index) => (
            <div key={item.Id} className="snap-start">
              {isDesktop ? (
                <MediaCard
                  item={item}
                  to={getRouteForItem(item)}
                  variant="poster"
                  index={index}
                  animateIn
                />
              ) : (
                <MobileMediaCard
                  item={item}
                  to={getRouteForItem(item)}
                  variant="poster"
                />
              )}
            </div>
          ))}
        </MediaShelf>
      ) : null}

      {cast.length > 0 ? (
        <MotionReveal className={isDesktop ? "py-6" : "py-4"}>
          <h2
            className={
              isDesktop
                ? "mb-5 text-2xl font-black text-white"
                : "mb-4 text-lg font-black text-white"
            }
          >
            {labels.cast}
          </h2>
          <div className="media-scroll flex gap-4 overflow-x-auto pb-3 sm:gap-5">
            {cast.map((person, index) => {
              const personImageUrl = person.Id
                ? getPrimaryImageUrl(
                    person.Id,
                    person.PrimaryImageTag,
                    isDesktop ? 320 : 240,
                  )
                : "";

              return (
                <div
                  key={`${person.Id ?? person.Name}-${index}`}
                  className={
                    isDesktop
                      ? "w-28 shrink-0 text-center"
                      : "w-24 shrink-0 text-center"
                  }
                >
                  <div
                    className={
                      isDesktop
                        ? "mx-auto h-24 w-24 overflow-hidden rounded-full border border-white/10 bg-white/[0.06]"
                        : "mx-auto h-20 w-20 overflow-hidden rounded-full border border-white/10 bg-white/[0.06]"
                    }
                  >
                    {personImageUrl ? (
                      <img
                        src={personImageUrl}
                        alt={person.Name ?? ""}
                        loading="lazy"
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <div className="grid h-full w-full place-items-center text-2xl font-black text-white/35">
                        {person.Name?.slice(0, 1)}
                      </div>
                    )}
                  </div>
                  <p className="mt-2 line-clamp-2 text-xs font-bold text-white">
                    {person.Name}
                  </p>
                  {person.Role ? (
                    <p className="mt-0.5 line-clamp-2 text-[11px] text-white/45">
                      {person.Role}
                    </p>
                  ) : null}
                </div>
              );
            })}
          </div>
        </MotionReveal>
      ) : null}

      <MotionReveal className={isDesktop ? "pt-6" : "pt-4"}>
        <h2
          className={
            isDesktop
              ? "mb-5 text-2xl font-black text-white"
              : "mb-4 text-lg font-black text-white"
          }
        >
          {labels.about}
        </h2>

        <div
          className={
            isDesktop
              ? "grid grid-cols-[minmax(0,1fr)_15rem] gap-4"
              : "space-y-3"
          }
        >
          <div className="rounded-2xl border border-white/10 bg-white/[0.055] p-5 sm:p-6">
            <p className="font-black text-white">{title}</p>
            {series.Genres?.length ? (
              <p className="mt-2 text-xs font-bold uppercase tracking-wide text-white/60">
                {series.Genres.join(", ")}
              </p>
            ) : null}
            <p className="mt-3 max-w-3xl text-sm leading-6 text-white/65">
              {series.Overview || t("details.noOverview")}
            </p>
          </div>

          {ratingPercent !== null ? (
            <div className="flex min-h-40 flex-col items-center justify-center rounded-2xl border border-white/10 bg-white/[0.055] p-5 text-center">
              <span className="text-xs font-black uppercase tracking-[0.18em] text-white/40">
                TMDB
              </span>
              <strong className="mt-3 text-4xl font-black text-orange-400">
                {ratingPercent}%
              </strong>
              <span className="mt-3 text-xs font-bold text-white/35">
                Community
              </span>
            </div>
          ) : null}
        </div>

        <div className={isDesktop ? "mt-8" : "mt-6"}>
          <h2
            className={
              isDesktop
                ? "mb-4 text-2xl font-black text-white"
                : "mb-3 text-lg font-black text-white"
            }
          >
            {labels.information}
          </h2>
          <dl
            className={
              isDesktop
                ? "grid max-w-3xl grid-cols-3 gap-x-8 gap-y-5"
                : "grid grid-cols-2 gap-x-5 gap-y-4"
            }
          >
            {studios.length > 0 ? (
              <div>
                <dt className="text-xs font-bold text-white/45">
                  {labels.studio}
                </dt>
                <dd className="mt-1 text-sm text-white/75">
                  {studios.join(", ")}
                </dd>
              </div>
            ) : null}
            {releaseDate ? (
              <div>
                <dt className="text-xs font-bold text-white/45">
                  {labels.release}
                </dt>
                <dd className="mt-1 text-sm text-white/75">{releaseDate}</dd>
              </div>
            ) : null}
            {series.OfficialRating ? (
              <div>
                <dt className="text-xs font-bold text-white/45">
                  {labels.ageRating}
                </dt>
                <dd className="mt-1 text-sm text-white/75">
                  {series.OfficialRating}
                </dd>
              </div>
            ) : null}
          </dl>
        </div>
      </MotionReveal>
    </div>
  );
}
