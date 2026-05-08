import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, Clock, Film, Play, Star } from "lucide-react";
import { ButtonLink } from "../components/Button";
import { ErrorMessage } from "../components/ErrorMessage";
import { DetailsSkeleton } from "../components/Skeletons";
import { useLanguage } from "../i18n/LanguageContext";
import { formatRuntime, getDisplayTitle } from "../lib/format";
import { getBackdropImageUrl, getItem, getLogoImageUrl, getPrimaryImageUrl } from "../lib/jellyfinApi";
import type { JellyfinItem } from "../lib/types";
import { AnimatedText } from "../components/AnimatedText";
import { AnimatedWidth } from "../components/AnimatedWidth";

function getBackdrop(item: JellyfinItem): string {
  if (item.BackdropImageTags?.[0]) {
    return getBackdropImageUrl(item.Id, item.BackdropImageTags[0], 1800);
  }

  if (item.ParentBackdropItemId && item.ParentBackdropImageTags?.[0]) {
    return getBackdropImageUrl(item.ParentBackdropItemId, item.ParentBackdropImageTags[0], 1800);
  }

  return "";
}

export function ItemDetailsPage() {
  const { itemId } = useParams<{ itemId: string }>();
  const { t } = useLanguage();
  const [item, setItem] = useState<JellyfinItem | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;

    async function loadItem() {
      if (!itemId) {
        setError("Missing item id.");
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
          setError(itemError instanceof Error ? itemError.message : "Could not load item details.");
        }
      }
    }

    void loadItem();

    return () => {
      isMounted = false;
    };
  }, [itemId]);

  if (error) {
    return <ErrorMessage title={t("details.itemUnavailable")} message={error} />;
  }

  if (!item) {
    return <DetailsSkeleton />;
  }

  const title = getDisplayTitle(item);
  const runtime = formatRuntime(item.RunTimeTicks);
  const posterUrl = item.ImageTags?.Primary ? getPrimaryImageUrl(item.Id, item.ImageTags.Primary, 760) : "";
  const logoUrl = item.ImageTags?.Logo ? getLogoImageUrl(item.Id, item.ImageTags.Logo, 1100) : "";
  const backdropUrl = getBackdrop(item);
  const videoStream = item.MediaSources?.[0]?.MediaStreams?.find((stream) => stream.Type?.toLowerCase() === "video");
  const audioStream = item.MediaSources?.[0]?.MediaStreams?.find((stream) => stream.Type?.toLowerCase() === "audio");
  const chips = [
    item.ProductionYear ? { label: String(item.ProductionYear), icon: Film } : null,
    runtime ? { label: runtime, icon: Clock } : null,
    item.OfficialRating ? { label: item.OfficialRating, icon: Star } : null,
    item.CommunityRating ? { label: item.CommunityRating.toFixed(1), icon: Star } : null,
  ].filter(Boolean) as Array<{ label: string; icon: typeof Film }>;

  return (
    <article className="relative -mx-4 -mt-6 min-h-[calc(100vh-4rem)] overflow-hidden px-4 pb-16 pt-6 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
      {backdropUrl ? (
        <img src={backdropUrl} alt="" className="absolute inset-0 h-[78vh] w-full scale-105 object-cover opacity-50" />
      ) : null}
      <div className="absolute inset-0 bg-gradient-to-r from-black via-black/[0.78] to-black/[0.28]" />
      <div className="absolute inset-0 bg-gradient-to-t from-[var(--background)] via-black/[0.34] to-black/40" />

      <div className="relative mx-auto max-w-[1500px]">
        <Link
          to="/home"
          className="mb-10 inline-flex min-h-10 items-center gap-2 rounded-full border border-white/10 bg-white/[0.08] px-4 text-sm font-semibold text-zinc-200 backdrop-blur transition hover:bg-white/[0.14] hover:text-white"
        >
            <ArrowLeft size={17} className="shrink-0" />
            <AnimatedWidth value={t("common.home")}>
              <AnimatedText value={t("common.home")} />
            </AnimatedWidth>
        </Link>

        <div className="grid gap-8 md:grid-cols-[minmax(16rem,22rem)_1fr] md:items-end lg:gap-12">
          <div className="overflow-hidden rounded-2xl border border-white/[0.12] bg-zinc-900 shadow-[0_30px_120px_rgba(0,0,0,0.64)]">
            {posterUrl ? (
              <img src={posterUrl} alt={title} className="aspect-[2/3] w-full object-cover" />
            ) : (
              <div className="flex aspect-[2/3] items-center justify-center bg-[linear-gradient(145deg,#27272a,#050506)] p-6 text-center font-semibold text-zinc-200">
                {title}
              </div>
            )}
          </div>

          <div className="max-w-4xl">
            <p className="text-sm font-black uppercase tracking-[0.22em] text-[var(--accent)]">
              <AnimatedWidth value={item.Type === "Movie" ? t("common.movie") : item.Type === "BoxSet" ? t("common.boxsets") : item.Type ?? t("details.media")}>
                <AnimatedText value={item.Type === "Movie" ? t("common.movie") : item.Type === "BoxSet" ? t("common.boxsets") : item.Type ?? t("details.media")} />
              </AnimatedWidth>
            </p>
            {logoUrl ? (
              <img
                src={logoUrl}
                alt={title}
                className="mt-3 max-h-36 max-w-[min(42rem,92vw)] object-contain object-left drop-shadow-[0_16px_42px_rgba(0,0,0,0.85)] sm:max-h-44 lg:max-h-52"
              />
            ) : (
              <h1 className="mt-3 text-5xl font-black leading-[0.94] text-white sm:text-6xl lg:text-7xl">
                {title}
              </h1>
            )}
            <div className="mt-5 flex flex-wrap gap-2">
              {chips.map(({ label, icon: Icon }) => (
                <span
                  key={label}
                  className="inline-flex min-h-9 items-center gap-2 rounded-full border border-white/[0.12] bg-black/[0.35] px-3 text-sm font-bold text-white/[0.78] backdrop-blur"
                >
                  <Icon size={15} />
                  {label}
                </span>
              ))}
            </div>
            {item.Genres?.length ? (
              <div className="mt-4 flex flex-wrap gap-2">
                {item.Genres.slice(0, 6).map((genre) => (
                  <span
                    key={genre}
                    className="rounded-full border border-white/10 bg-white/[0.08] px-3 py-1.5 text-sm font-semibold text-white/[0.62]"
                  >
                    {genre}
                  </span>
                ))}
              </div>
            ) : null}
            <div className="mt-8 flex flex-wrap gap-3">
              <ButtonLink to={`/watch/${item.Id}`} className="min-h-12 rounded-full px-7 text-base shadow-2xl">
                <Play size={20} fill="currentColor" className="shrink-0" />
                  <AnimatedWidth value={t("common.play")}>
                    <AnimatedText value={t("common.play")} />
                  </AnimatedWidth>
              </ButtonLink>
            </div>
          </div>
        </div>

        <div className="mt-12 grid gap-5 lg:grid-cols-[1.4fr_0.8fr]">
          <section className="rounded-2xl border border-white/10 bg-white/[0.055] p-5 backdrop-blur-xl sm:p-6">
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
          <section className="rounded-2xl border border-white/10 bg-white/[0.055] p-5 backdrop-blur-xl sm:p-6">
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
                  {item.MediaSources?.[0]?.Container || (
                    <AnimatedWidth value={t("details.unknown")}>
                      <AnimatedText value={t("details.unknown")} />
                    </AnimatedWidth>
                  )}
                </dd>
              </div>
              <div className="flex justify-between gap-4 border-b border-white/[0.08] pb-3">
                <dt className="text-white/45">
                  <AnimatedWidth value={t("details.video")}>
                    <AnimatedText value={t("details.video")} />
                  </AnimatedWidth>
                </dt>
                <dd className="text-right font-semibold text-white/[0.78]">
                  {[videoStream?.Codec, videoStream?.Width && videoStream?.Height ? `${videoStream.Width}x${videoStream.Height}` : undefined]
                    .filter(Boolean)
                    .join(" / ") || (
                    <AnimatedWidth value={t("details.unknown")}>
                      <AnimatedText value={t("details.unknown")} />
                    </AnimatedWidth>
                  )}
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-white/45">
                  <AnimatedWidth value={t("details.audio")}>
                    <AnimatedText value={t("details.audio")} />
                  </AnimatedWidth>
                </dt>
                <dd className="text-right font-semibold text-white/[0.78]">
                  {[audioStream?.Codec, audioStream?.Channels ? `${audioStream.Channels} ch` : undefined]
                    .filter(Boolean)
                    .join(" / ") || (
                    <AnimatedWidth value={t("details.unknown")}>
                      <AnimatedText value={t("details.unknown")} />
                    </AnimatedWidth>
                  )}
                </dd>
              </div>
            </dl>
          </section>
        </div>
      </div>
    </article>
  );
}
