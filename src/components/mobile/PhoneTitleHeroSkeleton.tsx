import { Play } from "lucide-react";
import { useLanguage } from "../../i18n/LanguageContext";
import { formatRuntime } from "../../lib/format";
import { getItemDisplayMetadata } from "../../lib/itemMetadataPreferences";
import type { MediaItem } from "../../lib/types";
import { canStartOverFromHero } from "../HeroSection";

/**
 * A phone's title page hero while it loads. The hero (`HeroSection`, fixed)
 * stands its copy on the section's foot in rows of fixed height (the logo's
 * box, the genre line, three lines of overview, the chips, the actions), so
 * each placeholder here takes the same row, in the same classes, and lands
 * where its piece will. Once the page has the title, the rows it lacks are
 * left out and the chips and play are sized by their own, unseen, words.
 */

/** The band's eased fade, as in HeroSection.css. */
const BAND_MASK =
  "linear-gradient(180deg, #000 0%, #000 40%, rgba(0, 0, 0, 0.82) 52%, rgba(0, 0, 0, 0.56) 64%, rgba(0, 0, 0, 0.3) 75%, rgba(0, 0, 0, 0.12) 84%, rgba(0, 0, 0, 0.03) 91%, transparent 96%)";
const CHIP =
  "shimmer rounded-full border border-transparent px-2.5 py-1 text-xs font-semibold";

export function PhoneTitleHeroSkeleton({
  kind,
  item,
}: {
  kind: "movie" | "show";
  item?: MediaItem;
}) {
  const { language, t } = useLanguage();
  const labels = {
    season: t("media.seasonNumber"),
    hourShort: t("format.hourShort"),
    minuteShort: t("format.minuteShort"),
  };
  const genres = item ? (item.Genres?.filter(Boolean).slice(0, 3) ?? []) : null;
  const overview = item
    ? (getItemDisplayMetadata(item, language).overview ?? item.Overview ?? null)
    : "";
  const chips = item
    ? [
        item.ProductionYear,
        formatRuntime(item.RunTimeTicks, labels),
        item.Type === "Movie"
          ? t("common.movie")
          : item.Type === "Series"
            ? t("common.series")
            : null,
      ].filter(Boolean)
    : null;
  // A film knows its own place; a series' next episode is not known yet.
  const isResumed =
    item?.Type === "Movie" && (item.UserData?.PlaybackPositionTicks ?? 0) > 0;
  const canStartOver = item?.Type === "Movie" && canStartOverFromHero(item);
  const playLabel = isResumed
    ? t("details.continueWatching")
    : t("common.play");

  return (
    <section className="relative min-h-[min(100svh,44rem)] w-full overflow-hidden bg-zinc-950">
      <div className="absolute inset-0 bg-[linear-gradient(145deg,#18181b_0%,#09090b_52%,#050506_100%)]" />
      {/* The backdrop's band, with the same dissolving foot. */}
      <div
        className="shimmer absolute inset-x-0 top-0 h-[min(75vw,62svh)]"
        style={{ WebkitMaskImage: BAND_MASK, maskImage: BAND_MASK }}
      />
      <div className="relative z-20 mx-auto flex min-h-[min(100svh,44rem)] w-full flex-col justify-end px-4 pb-[calc(6.75rem+env(safe-area-inset-bottom))]">
        <div className="max-w-[min(32rem,88vw)]">
          <div className="flex h-[clamp(6rem,28vw,15rem)] w-[min(24rem,70vw)] items-end">
            <div className="shimmer h-[62%] w-full rounded-lg" />
          </div>
          {genres === null || genres.length > 0 ? (
            <div className="mt-2 flex h-5 items-center">
              <div className="shimmer h-3.5 w-36 rounded-md" />
            </div>
          ) : null}
          {overview !== null ? (
            <div className="mt-3 flex h-[4.5rem] flex-col justify-center gap-[0.625rem]">
              <div className="shimmer h-3.5 w-full rounded-md" />
              <div className="shimmer h-3.5 w-[94%] rounded-md" />
              <div className="shimmer h-3.5 w-3/5 rounded-md" />
            </div>
          ) : null}
          <div className="mt-4 flex gap-1.5">
            {(
              chips ?? ["2014", "2sa 44dk", kind === "movie" ? "Film" : "Dizi"]
            ).map((value) => (
              <span key={String(value)} className={CHIP}>
                <span className="invisible">{value}</span>
              </span>
            ))}
          </div>
          <div className="mt-5 flex gap-2">
            <span className="shimmer inline-flex h-12 items-center gap-2 rounded-full pl-5 pr-6 text-[0.9375rem] font-bold">
              <span className="invisible inline-flex items-center gap-2">
                <Play size={19} className="shrink-0" />
                {/* The label keeps the 4px AnimatedWidth reserves around it. */}
                <span className="pr-1">{playLabel}</span>
              </span>
            </span>
            {canStartOver ? (
              <div className="shimmer h-12 w-12 rounded-full" />
            ) : null}
            <div className="shimmer h-12 w-12 rounded-full" />
          </div>
        </div>
      </div>
    </section>
  );
}
