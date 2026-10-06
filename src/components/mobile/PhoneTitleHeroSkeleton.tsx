import { useLanguage } from "../../i18n/LanguageContext";
import { getItemDisplayMetadata } from "../../lib/itemMetadataPreferences";
import type { MediaItem } from "../../lib/types";
import { canStartOverFromHero } from "../HeroSection";
import { heroRoundCount, heroRowParts } from "../home/HeroActions";
import {
  PHONE_TITLE_HERO_ACTIONS,
  PHONE_TITLE_HERO_COPY,
  PHONE_TITLE_HERO_FACTS,
  PHONE_TITLE_HERO_FRAME,
  PHONE_TITLE_HERO_LOGO_BOX,
  PHONE_TITLE_HERO_OVERVIEW,
  PHONE_TITLE_HERO_SECTION,
  phoneTitleFacts,
} from "./phoneTitleHeroRows";

/**
 * A phone's title page hero while it loads, from the hero's own rows
 * (`PhoneTitleHero`): the backdrop's frame, the logo's box, the facts, the
 * overview and the actions, each in the same classes, so each placeholder
 * lands where its piece will. Once the page has the title, the rows it lacks
 * are left out and the facts take their own, unseen, width.
 */
export function PhoneTitleHeroSkeleton({
  kind,
  item,
}: {
  kind: "movie" | "show";
  item?: MediaItem;
}) {
  const { language, t } = useLanguage();
  const facts = item
    ? phoneTitleFacts(item, {
        season: t("media.seasonNumber"),
        hourShort: t("format.hourShort"),
        minuteShort: t("format.minuteShort"),
      })
    : null;
  const overview = item
    ? (getItemDisplayMetadata(item, language).overview ?? item.Overview ?? null)
    : "";
  // A film knows its own place; a series' next episode is not known yet.
  const parts = heroRowParts({
    compact: true,
    onTitlePage: true,
    isFilm: kind === "movie",
    canStartOver: item?.Type === "Movie" && canStartOverFromHero(item),
    hasOverview: false,
  });
  const rounds = heroRoundCount(parts);

  return (
    <section className={PHONE_TITLE_HERO_SECTION}>
      <div className={`${PHONE_TITLE_HERO_FRAME} shimmer`} />
      <div className={PHONE_TITLE_HERO_COPY}>
        <div className={PHONE_TITLE_HERO_LOGO_BOX}>
          <div className="shimmer h-[70%] w-full rounded-lg" />
        </div>
        {facts !== "" ? (
          <div className={PHONE_TITLE_HERO_FACTS}>
            <span className="shimmer max-w-full truncate rounded-md text-[0.8125rem] font-bold leading-4 tracking-[0.04em]">
              <span className="invisible">
                {facts ?? "2014  ·  2sa 44dk  ·  Action, Adventure"}
              </span>
            </span>
          </div>
        ) : null}
        {overview !== null ? (
          <div
            className={`${PHONE_TITLE_HERO_OVERVIEW} flex flex-col justify-center gap-[0.625rem]`}
          >
            <div className="shimmer h-3.5 w-full rounded-md" />
            <div className="shimmer h-3.5 w-[94%] rounded-md" />
            <div className="shimmer h-3.5 w-3/5 rounded-md" />
          </div>
        ) : null}
        <div className={`${PHONE_TITLE_HERO_ACTIONS} flex gap-1.5`}>
          <div className="shimmer h-12 min-w-0 flex-1 rounded-full" />
          {Array.from({ length: rounds }, (_, index) => (
            <div key={index} className="shimmer h-12 w-12 rounded-full" />
          ))}
        </div>
      </div>
    </section>
  );
}
