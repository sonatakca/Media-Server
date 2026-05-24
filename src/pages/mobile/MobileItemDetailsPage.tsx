import { useEffect, useMemo, useState } from "react";
import { Clock, Film, Play, RotateCcw, Star } from "lucide-react";
import { useParams } from "react-router-dom";
import { BackButton } from "../../components/BackButton";
import { ButtonLink } from "../../components/Button";
import { ErrorMessage } from "../../components/ErrorMessage";
import { useLanguage } from "../../i18n/LanguageContext";
import { formatRuntime, getDisplayTitle } from "../../lib/format";
import {
  getBackdropImageUrl,
  getItem,
  getLogoImageUrl,
  getPrimaryImageUrl,
} from "../../lib/jellyfinApi";
import { setSeoMetadata } from "../../lib/seo";
import type { JellyfinItem } from "../../lib/types";

function getBackdrop(item: JellyfinItem): string {
  if (item.BackdropImageTags?.[0]) {
    return getBackdropImageUrl(item.Id, item.BackdropImageTags[0], 1280);
  }

  if (item.ParentBackdropItemId && item.ParentBackdropImageTags?.[0]) {
    return getBackdropImageUrl(
      item.ParentBackdropItemId,
      item.ParentBackdropImageTags[0],
      1280,
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

  const season = item.ParentIndexNumber ? `S${item.ParentIndexNumber}` : "";
  const episode = item.IndexNumber ? `E${item.IndexNumber}` : "";

  return `${season}${episode}` || null;
}

function MobileDetailsLoading() {
  return (
    <div className="layout-no-offset min-h-screen pb-24">
      <div className="shimmer full-bleed h-[25rem]" />
      <div className="-mt-28 px-4">
        <div className="shimmer h-44 w-28 rounded-xl" />
        <div className="shimmer mt-5 h-12 rounded-full" />
      </div>
    </div>
  );
}

export function MobileItemDetailsPage() {
  const { itemId } = useParams<{ itemId: string }>();
  const { t } = useLanguage();
  const labels = useMemo(
    () => ({
      season: t("media.seasonNumber"),
      hourShort: t("format.hourShort"),
      minuteShort: t("format.minuteShort"),
    }),
    [t],
  );
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
      title: `${getDisplayTitle(item, labels)} · Seyirlik`,
      canonicalPath: `/item/${item.Id}`,
      robots: "noindex, nofollow",
    });
  }, [item, itemId, labels]);

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
        const loadedItem = await getItem(itemId);

        if (isMounted) {
          setItem(loadedItem);
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
    return <MobileDetailsLoading />;
  }

  const title = getDisplayTitle(item, labels);
  const runtime = formatRuntime(item.RunTimeTicks, labels);
  const isEpisode = item.Type === "Episode";
  const artworkUrl = item.ImageTags?.Primary
    ? getPrimaryImageUrl(item.Id, item.ImageTags.Primary, 520)
    : "";
  const backdropUrl = getBackdrop(item);
  const logoUrl = item.ImageTags?.Logo
    ? getLogoImageUrl(item.Id, item.ImageTags.Logo, 620)
    : item.ParentLogoItemId && item.ParentLogoImageTag
      ? getLogoImageUrl(item.ParentLogoItemId, item.ParentLogoImageTag, 620)
      : "";
  const displayTitle = isEpisode ? item.Name || title : title;
  const seriesTitle = item.SeriesName ?? title;
  const episodeCode = getEpisodeCode(item);
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
  const positionTicks = item.UserData?.PlaybackPositionTicks ?? 0;
  const hasStarted = positionTicks > 0 && !item.UserData?.Played;
  const remainingRuntime = getRemainingRuntime(item, labels);
  const primaryPlayLabel = hasStarted
    ? t("details.continueWatching")
    : t("common.play");
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
  const mediaRows = [
    {
      label: t("details.container"),
      value: item.MediaSources?.[0]?.Container || t("details.unknown"),
    },
    {
      label: t("details.video"),
      value:
        [
          videoStream?.Codec,
          videoStream?.Width && videoStream.Height
            ? `${videoStream.Width}x${videoStream.Height}`
            : undefined,
        ]
          .filter(Boolean)
          .join(" / ") || t("details.unknown"),
    },
    {
      label: t("details.audio"),
      value:
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
          .join(" / ") || t("details.unknown"),
    },
  ];

  return (
    <div className="layout-no-offset min-h-screen pb-[calc(5.25rem+env(safe-area-inset-bottom))]">
      <article className="full-bleed relative min-h-screen overflow-hidden">
        {backdropUrl ? (
          <img
            src={backdropUrl}
            alt=""
            className="absolute inset-x-0 top-0 h-[28rem] w-full object-cover opacity-50"
          />
        ) : null}
        <div className="absolute inset-x-0 top-0 h-[30rem] bg-gradient-to-t from-[#050506] via-black/42 to-black/45" />

        <div className="relative px-4 pt-[calc(4.4rem+env(safe-area-inset-top))]">
          <BackButton className="min-h-10 bg-black/38" />

          <div className="mt-[5.25rem] flex items-end gap-4">
            <div
              className={`w-[7.4rem] shrink-0 overflow-hidden rounded-xl border border-white/15 bg-zinc-900 shadow-artwork-glow ${
                isEpisode ? "aspect-video" : "aspect-[2/3]"
              }`}
            >
              {artworkUrl ? (
                <img
                  src={artworkUrl}
                  alt={title}
                  className="h-full w-full object-cover"
                />
              ) : (
                <div className="flex h-full items-center justify-center p-3 text-center text-xs font-bold text-white/72">
                  {title}
                </div>
              )}
            </div>

            <div className="min-w-0 flex-1 pb-1">
              <p className="mb-2 text-[0.68rem] font-black uppercase tracking-[0.2em] text-[var(--accent)]">
                {mediaLabel}
              </p>
              {logoUrl ? (
                <img
                  src={logoUrl}
                  alt={seriesTitle}
                  className="cinematic-logo-shadow mb-2 max-h-12 max-w-full object-contain object-left"
                />
              ) : null}
              <h1 className="line-clamp-3 text-2xl font-black leading-tight text-white">
                {displayTitle}
              </h1>
              {episodeCode ? (
                <p className="mt-2 text-xs font-black tracking-[0.18em] text-white/60">
                  {episodeCode}
                </p>
              ) : null}
            </div>
          </div>

          <div className="mt-5 flex flex-wrap gap-2">
            {chips.map(({ label, icon: Icon }) => (
              <span
                key={label}
                className="inline-flex min-h-8 items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.08] px-3 text-xs font-bold text-white/75 backdrop-blur"
              >
                <Icon size={13} />
                {label}
              </span>
            ))}
          </div>

          {item.Genres?.length ? (
            <div className="mt-3 flex flex-wrap gap-2">
              {item.Genres.slice(0, 4).map((genre) => (
                <span
                  key={genre}
                  className="rounded-full bg-white/[0.06] px-3 py-1 text-xs font-semibold text-white/58"
                >
                  {genre}
                </span>
              ))}
            </div>
          ) : null}

          {canPlay ? (
            <div className="mt-6 flex items-center gap-2.5">
              <ButtonLink
                to={`/watch/${item.Id}`}
                className="min-h-12 flex-1 rounded-full bg-white text-black hover:bg-white/90"
              >
                <Play size={18} fill="currentColor" />
                {primaryPlayLabel}
              </ButtonLink>
              {hasStarted ? (
                <ButtonLink
                  to={`/watch/${item.Id}?restart=1`}
                  variant="secondary"
                  aria-label={t("details.playFromBeginning")}
                  title={t("details.playFromBeginning")}
                  className="h-12 min-h-12 w-12 rounded-full px-0"
                >
                  <RotateCcw size={18} />
                </ButtonLink>
              ) : null}
            </div>
          ) : null}

          {hasStarted && remainingRuntime ? (
            <p className="mt-3 text-center text-xs font-semibold text-white/58">
              {t("details.remainingTime")}:{" "}
              <span className="text-white">{remainingRuntime}</span>
            </p>
          ) : null}

          <section className="mt-8 rounded-2xl border border-white/10 bg-white/[0.055] p-4 shadow-soft-inset">
            <h2 className="text-lg font-black text-white">
              {t("details.overview")}
            </h2>
            <p className="mt-3 text-sm leading-6 text-white/68">
              {item.Overview || t("details.noOverview")}
            </p>
          </section>

          <section className="mt-3 rounded-2xl border border-white/10 bg-white/[0.055] p-4 shadow-soft-inset">
            <h2 className="text-lg font-black text-white">
              {t("details.mediaInfo")}
            </h2>
            <dl className="mt-3 space-y-3 text-sm">
              {mediaRows.map((row) => (
                <div
                  key={row.label}
                  className="flex justify-between gap-4 border-b border-white/[0.08] pb-3 last:border-0 last:pb-0"
                >
                  <dt className="text-white/48">{row.label}</dt>
                  <dd className="text-right font-semibold text-white/78">
                    {row.value}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        </div>
      </article>
    </div>
  );
}
