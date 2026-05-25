import { useEffect, useMemo, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { Link, useParams } from "react-router-dom";
import { Clock, Film, Play, RotateCcw, Star } from "lucide-react";
import { AnimatedText } from "../../components/AnimatedText";
import { AnimatedWidth } from "../../components/AnimatedWidth";
import { BackButton } from "../../components/BackButton";
import { ButtonLink } from "../../components/Button";
import { ErrorMessage } from "../../components/ErrorMessage";
import { MotionReveal } from "../../components/MotionReveal";
import { DetailsSkeleton } from "../../components/Skeletons";
import { useLanguage } from "../../i18n/LanguageContext";
import { formatRuntime, getDisplayTitle } from "../../lib/format";
import {
  getBackdropImageUrl,
  getItem,
  getLogoImageUrl,
  getPrimaryImageUrl,
} from "../../lib/jellyfinApi";
import type { JellyfinItem } from "../../lib/types";
import { setSeoMetadata } from "../../lib/seo";

const easeOut: [number, number, number, number] = [0.22, 1, 0.36, 1];

function getBackdrop(item: JellyfinItem): string {
  if (item.BackdropImageTags?.[0]) {
    return getBackdropImageUrl(item.Id, item.BackdropImageTags[0], 1800);
  }

  if (item.ParentBackdropItemId && item.ParentBackdropImageTags?.[0]) {
    return getBackdropImageUrl(
      item.ParentBackdropItemId,
      item.ParentBackdropImageTags[0],
      1800,
    );
  }

  return "";
}

function getRemainingRuntime(
  item: JellyfinItem,
  labels: Parameters<typeof formatRuntime>[1],
): string | null {
  const positionTicks = item.UserData?.PlaybackPositionTicks ?? 0;
  const runtimeTicks = item.RunTimeTicks ?? 0;

  if (
    positionTicks <= 0 ||
    runtimeTicks <= 0 ||
    positionTicks >= runtimeTicks
  ) {
    return null;
  }

  return formatRuntime(runtimeTicks - positionTicks, labels);
}

function getEpisodeCode(item: JellyfinItem): string | null {
  if (item.Type !== "Episode") {
    return null;
  }

  const seasonNumber = item.ParentIndexNumber
    ? `S${item.ParentIndexNumber}`
    : "";
  const episodeNumber = item.IndexNumber ? `E${item.IndexNumber}` : "";
  const code = `${seasonNumber}${episodeNumber}`;

  return code || null;
}

export function DesktopItemDetailsPage() {
  const { itemId } = useParams<{ itemId: string }>();
  const { t } = useLanguage();
  const mediaFormatLabels = useMemo(
    () => ({
      season: t("media.seasonNumber"),
      hourShort: t("format.hourShort"),
      minuteShort: t("format.minuteShort"),
    }),
    [t],
  );
  const shouldReduceMotion = useReducedMotion();
  const [item, setItem] = useState<JellyfinItem | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!item) {
      setSeoMetadata({
        canonicalPath: itemId ? `/item/${itemId}` : "/home",
        robots: "noindex, nofollow",
      });
      return;
    }

    setSeoMetadata({
      title: `${getDisplayTitle(item, mediaFormatLabels)} · Seyirlik`,
      canonicalPath: `/item/${item.Id}`,
      robots: "noindex, nofollow",
    });
  }, [item, itemId, mediaFormatLabels]);

  useEffect(() => {
    let isMounted = true;

    async function loadItem() {
      if (!itemId) {
        setError(t("details.missingItemId"));
        return;
      }

      setError(null);
      setItem(null);

      try {
        const itemDetails = await getItem(itemId);

        if (isMounted) {
          setItem(itemDetails);
        }
      } catch (itemError) {
        if (isMounted) {
          setError(
            itemError instanceof Error
              ? itemError.message
              : t("details.couldNotLoad"),
          );
        }
      }
    }

    void loadItem();

    return () => {
      isMounted = false;
    };
  }, [itemId, t]);

  if (error) {
    return (
      <ErrorMessage title={t("details.itemUnavailable")} message={error} />
    );
  }

  if (!item) {
    return <DetailsSkeleton />;
  }

  const title = getDisplayTitle(item, mediaFormatLabels);
  const runtime = formatRuntime(item.RunTimeTicks, mediaFormatLabels);
  const posterUrl = item.ImageTags?.Primary
    ? getPrimaryImageUrl(item.Id, item.ImageTags.Primary, 760)
    : "";
  const isEpisode = item.Type === "Episode";
  const seriesItemId = isEpisode
    ? (item.SeriesId ?? item.ParentLogoItemId ?? null)
    : null;
  const seasonItemId = isEpisode
    ? (item.SeasonId ?? item.ParentId ?? null)
    : null;
  const logoUrl = item.ImageTags?.Logo
    ? getLogoImageUrl(item.Id, item.ImageTags.Logo, 1100)
    : item.ParentLogoItemId && item.ParentLogoImageTag
      ? getLogoImageUrl(item.ParentLogoItemId, item.ParentLogoImageTag, 1100)
      : "";
  const episodeCode = getEpisodeCode(item);
  const episodeTitle = isEpisode ? item.Name || title : title;
  const seriesTitle = item.SeriesName ?? title;
  const backdropUrl = getBackdrop(item);
  const videoStream = item.MediaSources?.[0]?.MediaStreams?.find(
    (stream) => stream.Type?.toLowerCase() === "video",
  );
  const audioStream = item.MediaSources?.[0]?.MediaStreams?.find(
    (stream) => stream.Type?.toLowerCase() === "audio",
  );
  const chips = [
    item.ProductionYear
      ? { label: String(item.ProductionYear), icon: Film }
      : null,
    runtime ? { label: runtime, icon: Clock } : null,
    item.OfficialRating ? { label: item.OfficialRating, icon: Star } : null,
    item.CommunityRating
      ? { label: item.CommunityRating.toFixed(1), icon: Star }
      : null,
  ].filter(Boolean) as Array<{ label: string; icon: typeof Film }>;
  const mediaLabel =
    item.Type === "Movie"
      ? t("common.movie")
      : item.Type === "Series"
        ? t("common.series")
        : item.Type === "BoxSet"
          ? t("common.boxsets")
          : (item.Type ?? t("details.media"));
  const canPlay =
    item.Type === "Movie" ||
    item.Type === "Episode" ||
    item.MediaType === "Video";
  const playbackPositionTicks = item.UserData?.PlaybackPositionTicks ?? 0;
  const hasStarted = playbackPositionTicks > 0 && !item.UserData?.Played;
  const remainingRuntime = getRemainingRuntime(item, mediaFormatLabels);
  const primaryPlayLabel = hasStarted
    ? t("details.continueWatching")
    : t("common.play");
  const continueHref = `/watch/${item.Id}`;
  const restartHref = `/watch/${item.Id}?restart=1`;
  const containerLabel =
    item.MediaSources?.[0]?.Container || t("details.unknown");
  const videoLabel =
    [
      videoStream?.Codec,
      videoStream?.Width && videoStream?.Height
        ? `${videoStream.Width}x${videoStream.Height}`
        : undefined,
    ]
      .filter(Boolean)
      .join(" / ") || t("details.unknown");
  const audioLabel =
    [
      audioStream?.Codec,
      audioStream?.Channels
        ? t("details.audioChannelsShort").replace(
            "{count}",
            String(audioStream.Channels),
          )
        : undefined,
    ]
      .filter(Boolean)
      .join(" / ") || t("details.unknown");

  return (
    <div className="layout-no-offset">
      <article className="full-bleed relative  min-h-[calc(100vh-4rem)] overflow-hidden px-4 pb-16 pt-8 sm:px-6 lg:px-8">
        {backdropUrl ? (
          <div className="pointer-events-none absolute inset-x-0 top-0 z-0 h-[78vh] overflow-hidden">
            <motion.img
              src={backdropUrl}
              alt=""
              className="h-full w-full object-cover opacity-50"
              initial={
                shouldReduceMotion ? false : { opacity: 0, scale: 1.035 }
              }
              animate={
                shouldReduceMotion ? undefined : { opacity: 0.5, scale: 1 }
              }
              transition={{ duration: 0.5, ease: easeOut }}
            />
            <div className="details-backdrop-bottom-fade z-10" />
          </div>
        ) : null}
        <div className="hero-cinematic-vignette z-0" />

        <div className="relative z-10 mx-auto max-w-[1500px]">
          <BackButton className="mb-10 mt-16" />

          <div
            className={
              isEpisode
                ? "grid gap-8 md:grid-cols-[minmax(28rem,44rem)_1fr] md:items-end lg:gap-12"
                : "grid gap-8 md:grid-cols-[minmax(16rem,22rem)_1fr] md:items-end lg:gap-12"
            }
          >
            <motion.div
              className={
                isEpisode
                  ? "artwork-edge-vignette overflow-hidden rounded-2xl border border-white/[0.12] bg-zinc-900 shadow-artwork-glow md:self-center"
                  : "artwork-edge-vignette overflow-hidden rounded-2xl border border-white/[0.12] bg-zinc-900 shadow-artwork-glow"
              }
              initial={
                shouldReduceMotion ? false : { opacity: 0, y: 18, scale: 0.985 }
              }
              animate={
                shouldReduceMotion ? undefined : { opacity: 1, y: 0, scale: 1 }
              }
              transition={{ duration: 0.34, delay: 0.04, ease: easeOut }}
            >
              {posterUrl ? (
                <img
                  src={posterUrl}
                  alt={title}
                  className={
                    isEpisode
                      ? "aspect-video w-full object-cover"
                      : "aspect-[2/3] w-full object-cover"
                  }
                />
              ) : (
                <div
                  className={
                    isEpisode
                      ? "flex aspect-video items-center justify-center bg-[linear-gradient(145deg,#27272a,#050506)] p-6 text-center font-semibold text-zinc-200"
                      : "flex aspect-[2/3] items-center justify-center bg-[linear-gradient(145deg,#27272a,#050506)] p-6 text-center font-semibold text-zinc-200"
                  }
                >
                  {title}
                </div>
              )}
            </motion.div>

            <motion.div
              className="max-w-4xl"
              initial={shouldReduceMotion ? false : { opacity: 0, y: 18 }}
              animate={shouldReduceMotion ? undefined : { opacity: 1, y: 0 }}
              transition={{ duration: 0.36, delay: 0.08, ease: easeOut }}
            >
              {isEpisode ? (
                <>
                  <div className="flex min-w-0 flex-wrap items-center gap-4">
                    {logoUrl ? (
                      seriesItemId ? (
                        <Link
                          to={`/library/${seriesItemId}`}
                          aria-label={`Go to ${seriesTitle}`}
                          title={seriesTitle}
                          className="inline-flex min-w-0 rounded-xl transition hover:scale-[1.02] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white/70"
                        >
                          <img
                            src={logoUrl}
                            alt={seriesTitle}
                            className="cinematic-logo-shadow h-auto max-h-24 max-w-[min(22rem,58vw)] object-contain object-left sm:max-h-28 lg:max-h-32"
                          />
                        </Link>
                      ) : (
                        <img
                          src={logoUrl}
                          alt={seriesTitle}
                          className="cinematic-logo-shadow h-auto max-h-24 max-w-[min(22rem,58vw)] object-contain object-left sm:max-h-28 lg:max-h-32"
                        />
                      )
                    ) : seriesItemId ? (
                      <Link
                        to={`/library/${seriesItemId}`}
                        aria-label={`Go to ${seriesTitle}`}
                        title={seriesTitle}
                        className="inline-flex min-w-0 rounded-xl transition hover:scale-[1.02] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white/70"
                      >
                        <h2 className="max-w-[min(28rem,70vw)] truncate text-3xl font-black leading-none text-white sm:text-4xl">
                          <AnimatedWidth value={seriesTitle}>
                            <AnimatedText value={seriesTitle} />
                          </AnimatedWidth>
                        </h2>
                      </Link>
                    ) : (
                      <h2 className="max-w-[min(28rem,70vw)] truncate text-3xl font-black leading-none text-white sm:text-4xl">
                        <AnimatedWidth value={seriesTitle}>
                          <AnimatedText value={seriesTitle} />
                        </AnimatedWidth>
                      </h2>
                    )}
                  </div>
                  <div className="flex">
                    <h1 className=" mt-5 pb-2 text-4xl font-black leading-[1.08] text-white sm:text-5xl lg:text-6xl">
                      <AnimatedWidth value={episodeTitle}>
                        <AnimatedText value={episodeTitle} />
                      </AnimatedWidth>
                    </h1>
                    {episodeCode ? (
                      seasonItemId ? (
                        <Link
                          to={`/library/${seasonItemId}`}
                          aria-label={`Go to ${episodeCode}`}
                          title={episodeCode}
                          className="group/episode-label relative my-7 mb-8 overflow-hidden rounded-2xl border border-white/[0.12] bg-gray-700 px-4 py-2.5 shadow-soft-inset transition hover:border-white/[0.24] hover:bg-gray-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white/70 sm:px-5 sm:py-3"
                        >
                          <div className="relative flex items-center">
                            <span className="text-2xl font-black leading-none tracking-[-0.04em] text-white sm:text-4xl">
                              {episodeCode}
                            </span>
                          </div>
                        </Link>
                      ) : (
                        <div className="group/episode-label relative my-7 mb-8 overflow-hidden rounded-2xl border border-white/[0.12] bg-gray-700 px-4 py-2.5 shadow-soft-inset sm:px-5 sm:py-3">
                          <div className="relative flex items-center">
                            <span className="text-2xl font-black leading-none tracking-[-0.04em] text-white sm:text-4xl">
                              {episodeCode}
                            </span>
                          </div>
                        </div>
                      )
                    ) : null}
                  </div>
                </>
              ) : (
                <>
                  <p className="text-sm font-black uppercase tracking-[0.22em] text-[var(--accent)]">
                    <AnimatedWidth value={mediaLabel}>
                      <AnimatedText value={mediaLabel} />
                    </AnimatedWidth>
                  </p>
                  {logoUrl ? (
                    <img
                      src={logoUrl}
                      alt={title}
                      className="cinematic-logo-shadow mt-3 max-h-36 max-w-[min(42rem,92vw)] object-contain object-left sm:max-h-44 lg:max-h-52"
                    />
                  ) : (
                    <h1 className="text-cinematic-title mt-3 text-5xl font-black leading-[0.94] text-white sm:text-6xl lg:text-7xl">
                      <AnimatedWidth value={title}>
                        <AnimatedText value={title} />
                      </AnimatedWidth>
                    </h1>
                  )}
                </>
              )}
              <div className="mt-5 flex flex-wrap gap-2">
                {chips.map(({ label, icon: Icon }, index) => (
                  <motion.span
                    key={label}
                    className="inline-flex min-h-9 items-center gap-2 rounded-full border border-white/[0.12] bg-gray-700/50 px-3 text-sm font-bold text-white/[0.78]"
                    initial={shouldReduceMotion ? false : { opacity: 0, y: 8 }}
                    animate={
                      shouldReduceMotion ? undefined : { opacity: 1, y: 0 }
                    }
                    transition={{
                      duration: 0.24,
                      delay: 0.12 + index * 0.03,
                      ease: easeOut,
                    }}
                  >
                    <Icon size={15} />
                    <AnimatedWidth value={label}>
                      <AnimatedText value={label} />
                    </AnimatedWidth>
                  </motion.span>
                ))}
              </div>
              {item.Genres?.length ? (
                <div className="mt-4 flex flex-wrap gap-2">
                  {item.Genres.slice(0, 6).map((genre) => (
                    <span
                      key={genre}
                      className="rounded-full border border-white/10 bg-gray-500/20 px-3 py-1.5 text-sm font-semibold text-white/[0.62]"
                    >
                      <AnimatedWidth value={genre}>
                        <AnimatedText value={genre} />
                      </AnimatedWidth>
                    </span>
                  ))}
                </div>
              ) : null}
              {canPlay ? (
                <div className="mt-8 flex flex-wrap items-start gap-3">
                  <ButtonLink
                    to={continueHref}
                    className="min-h-12 rounded-full px-7 text-base shadow-button-glow"
                  >
                    <Play size={20} fill="currentColor" className="shrink-0" />
                    <AnimatedWidth value={primaryPlayLabel}>
                      <AnimatedText value={primaryPlayLabel} />
                    </AnimatedWidth>
                  </ButtonLink>

                  {hasStarted ? (
                    <motion.div
                      className="-mt-1 flex w-16 flex-col items-center gap-1.5"
                      initial={
                        shouldReduceMotion ? false : { opacity: 0, y: 8 }
                      }
                      animate={
                        shouldReduceMotion ? undefined : { opacity: 1, y: 0 }
                      }
                      transition={{
                        duration: 0.26,
                        delay: 0.18,
                        ease: easeOut,
                      }}
                    >
                      <ButtonLink
                        to={restartHref}
                        aria-label={t("details.playFromBeginning")}
                        title={t("details.playFromBeginning")}
                        className="group !flex !h-[3.5rem] !w-[3.5rem] !min-w-[3.5rem] !items-center !justify-center !rounded-full !border !border-white/[0.14] !bg-gray-700/75 !p-0 !px-0 !py-0 !text-white !shadow-soft-inset transition hover:!border-white/[0.24] hover:!bg-gray-500 hover:!text-white"
                      >
                        <RotateCcw
                          size={23}
                          strokeWidth={2}
                          className="shrink-0 text-white/70 transition group-hover:text-white"
                        />
                      </ButtonLink>
                    </motion.div>
                  ) : null}

                  {hasStarted && remainingRuntime ? (
                    <motion.div
                      className="inline-flex min-h-12 items-center gap-3 rounded-full border border-white/[0.14] bg-gray-700/75 px-4 text-sm font-black text-white/[0.78] shadow-soft-inset"
                      initial={
                        shouldReduceMotion ? false : { opacity: 0, y: 8 }
                      }
                      animate={
                        shouldReduceMotion ? undefined : { opacity: 1, y: 0 }
                      }
                      transition={{
                        duration: 0.26,
                        delay: 0.18,
                        ease: easeOut,
                      }}
                    >
                      <span className="flex h-7 w-7 items-center justify-center rounded-full bg-[var(--accent)]/15 text-[var(--accent)]">
                        <Clock size={15} />
                      </span>
                      <span className="text-white/[0.48]">
                        <AnimatedWidth value={t("details.remainingTime")}>
                          <AnimatedText value={t("details.remainingTime")} />
                        </AnimatedWidth>
                      </span>
                      <span className="text-white">
                        <AnimatedWidth value={remainingRuntime}>
                          <AnimatedText value={remainingRuntime} />
                        </AnimatedWidth>
                      </span>
                    </motion.div>
                  ) : null}
                </div>
              ) : null}
            </motion.div>
          </div>

          <MotionReveal
            className="mt-12 grid gap-5 lg:grid-cols-[1.4fr_0.8fr]"
            delay={0.08}
          >
            <section className="panel-top-highlight rounded-2xl border border-white/10 bg-gray-500/15 p-5 shadow-soft-inset sm:p-6">
              <h2 className="text-xl font-black text-white">
                <AnimatedWidth value={t("details.overview")}>
                  <AnimatedText value={t("details.overview")} />
                </AnimatedWidth>
              </h2>
              <p className="mt-4 max-w-4xl text-base leading-8 text-white/[0.68]">
                {item.Overview || (
                  <AnimatedWidth value={t("details.noOverview")}>
                    <AnimatedText value={t("details.noOverview")} />
                  </AnimatedWidth>
                )}
              </p>
            </section>
            <section className="panel-top-highlight rounded-2xl border border-white/10 bg-gray-500/15 p-5 shadow-soft-inset sm:p-6">
              <h2 className="text-xl font-black text-white">
                <AnimatedWidth value={t("details.mediaInfo")}>
                  <AnimatedText value={t("details.mediaInfo")} />
                </AnimatedWidth>
              </h2>
              <dl className="mt-4 grid gap-3 text-sm">
                <div className="flex justify-between gap-4 border-b border-white/[0.08] pb-3">
                  <dt className="text-white/45">
                    <AnimatedWidth value={t("details.container")}>
                      <AnimatedText value={t("details.container")} />
                    </AnimatedWidth>
                  </dt>
                  <dd className="text-right font-semibold text-white/[0.78]">
                    <AnimatedWidth value={containerLabel}>
                      <AnimatedText value={containerLabel} />
                    </AnimatedWidth>
                  </dd>
                </div>
                <div className="flex justify-between gap-4 border-b border-white/[0.08] pb-3">
                  <dt className="text-white/45">
                    <AnimatedWidth value={t("details.video")}>
                      <AnimatedText value={t("details.video")} />
                    </AnimatedWidth>
                  </dt>
                  <dd className="text-right font-semibold text-white/[0.78]">
                    <AnimatedWidth value={videoLabel}>
                      <AnimatedText value={videoLabel} />
                    </AnimatedWidth>
                  </dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-white/45">
                    <AnimatedWidth value={t("details.audio")}>
                      <AnimatedText value={t("details.audio")} />
                    </AnimatedWidth>
                  </dt>
                  <dd className="text-right font-semibold text-white/[0.78]">
                    <AnimatedWidth value={audioLabel}>
                      <AnimatedText value={audioLabel} />
                    </AnimatedWidth>
                  </dd>
                </div>
              </dl>
            </section>
          </MotionReveal>
        </div>
      </article>
    </div>
  );
}
