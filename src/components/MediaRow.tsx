import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Link } from "react-router-dom";
import { useLanguage } from "../i18n/LanguageContext";
import type { JellyfinItem } from "../lib/types";
import { MediaCard } from "./MediaCard";
import { AnimatedText } from "./AnimatedText";
import { AnimatedWidth } from "./AnimatedWidth";
import { MotionReveal } from "./MotionReveal";

interface MediaRowProps {
  title: string;
  items: JellyfinItem[];
  getItemTo: (item: JellyfinItem) => string;
  variant?: "poster" | "landscape";
  emptyMessage?: string;
  viewAllTo?: string;
}

function formatTemplate(
  template: string,
  values: Record<string, string | number>,
): string {
  return Object.entries(values).reduce(
    (result, [key, value]) => result.split(`{${key}}`).join(String(value)),
    template,
  );
}

export function MediaRow({
  title,
  items,
  getItemTo,
  variant = "poster",
  emptyMessage,
  viewAllTo,
}: MediaRowProps) {
  const { t } = useLanguage();
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const updateScrollState = useCallback(() => {
    const scroller = scrollerRef.current;

    if (!scroller) {
      setCanScrollLeft(false);
      setCanScrollRight(false);
      return;
    }

    const maxScrollLeft = scroller.scrollWidth - scroller.clientWidth;
    setCanScrollLeft(scroller.scrollLeft > 2);
    setCanScrollRight(scroller.scrollLeft < maxScrollLeft - 2);
  }, []);

  useEffect(() => {
    updateScrollState();

    const scroller = scrollerRef.current;

    if (!scroller) {
      return undefined;
    }

    const resizeObserver = new ResizeObserver(updateScrollState);
    resizeObserver.observe(scroller);

    scroller.addEventListener("scroll", updateScrollState, { passive: true });
    window.addEventListener("resize", updateScrollState);

    return () => {
      resizeObserver.disconnect();
      scroller.removeEventListener("scroll", updateScrollState);
      window.removeEventListener("resize", updateScrollState);
    };
  }, [items.length, updateScrollState, variant]);

  if (items.length === 0 && !emptyMessage) {
    return null;
  }

  const scrollByCards = (direction: "left" | "right") => {
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
    <MotionReveal className="py-4 sm:py-6" direction="up">
      <div className="mb-0 flex items-end justify-between gap-4">
        <h2 className="text-lg font-black text-white sm:text-2xl">
          <AnimatedWidth value={title}>
            <AnimatedText value={title} />
          </AnimatedWidth>
        </h2>
        {viewAllTo ? (
          <Link
            to={viewAllTo}
            className="text-sm font-bold text-white/[0.55] transition hover:text-white"
          >
            <AnimatedWidth value={t("common.viewAll")}>
              <AnimatedText value={t("common.viewAll")} />
            </AnimatedWidth>
          </Link>
        ) : null}
      </div>
      {items.length > 0 ? (
        <div
          className={`group/viewport media-row-edge-fade relative isolate ${
            canScrollLeft ? "media-row-edge-fade--left" : ""
          } ${canScrollRight ? "media-row-edge-fade--right" : ""}`}
        >
          <div
            ref={scrollerRef}
            onScroll={updateScrollState}
            className="media-scroll relative z-10 flex snap-x gap-3 overflow-x-auto overflow-y-visible pb-6 pt-4 sm:gap-5 sm:pb-8 sm:pt-6"
          >
            {items.map((item, index) => (
              <div key={item.Id} className="snap-start">
                <MediaCard
                  item={item}
                  to={getItemTo(item)}
                  variant={variant}
                  index={index}
                  animateIn
                />
              </div>
            ))}
          </div>
          <div
            aria-hidden="true"
            className={`pointer-events-none absolute inset-y-0 left-0 z-[60] w-24 bg-gradient-to-r from-black/90 via-black/45 to-transparent transition-opacity duration-200 lg:w-32 ${
              canScrollLeft ? "opacity-100" : "opacity-0"
            }`}
          />
          <div
            aria-hidden="true"
            className={`pointer-events-none absolute inset-y-0 right-0 z-[60] w-24 bg-gradient-to-l from-black/90 via-black/45 to-transparent transition-opacity duration-200 lg:w-32 ${
              canScrollRight ? "opacity-100" : "opacity-0"
            }`}
          />
          <button
            type="button"
            onClick={() => scrollByCards("left")}
            className={`absolute left-3 top-[calc(50%-0.75rem)] z-[90] hidden h-20 w-12 -translate-y-1/2 items-center justify-center rounded-full border border-white/10 bg-gray-700/90 text-white shadow-[0_18px_70px_rgba(0,0,0,0.72),0_0_0_1px_rgba(255,255,255,0.06)] transition-[opacity,transform,background-color] duration-200 ease-out hover:bg-gray-500 focus:outline-none focus:ring-2 focus:ring-[var(--accent)] lg:flex ${
              canScrollLeft
                ? "pointer-events-auto opacity-0 group-hover/viewport:opacity-100 focus:opacity-100"
                : "pointer-events-none opacity-0"
            }`}
            aria-label={formatTemplate(t("common.scrollLeft"), { title })}
            aria-hidden={!canScrollLeft}
            tabIndex={canScrollLeft ? 0 : -1}
          >
            <ChevronLeft size={30} />
          </button>
          <button
            type="button"
            onClick={() => scrollByCards("right")}
            className={`absolute right-3 top-[calc(50%-0.75rem)] z-[90] hidden h-20 w-12 -translate-y-1/2 items-center justify-center rounded-full border border-white/10 bg-gray-700/90 text-white shadow-[0_18px_70px_rgba(0,0,0,0.72),0_0_0_1px_rgba(255,255,255,0.06)] transition-[opacity,transform,background-color] duration-200 ease-out hover:bg-gray-500 focus:outline-none focus:ring-2 focus:ring-[var(--accent)] lg:flex ${
              canScrollRight
                ? "pointer-events-auto opacity-0 group-hover/viewport:opacity-100 focus:opacity-100"
                : "pointer-events-none opacity-0"
            }`}
            aria-label={formatTemplate(t("common.scrollRight"), { title })}
            aria-hidden={!canScrollRight}
            tabIndex={canScrollRight ? 0 : -1}
          >
            <ChevronRight size={30} />
          </button>
        </div>
      ) : (
        <p className="rounded-xl border border-white/10 bg-[var(--surface)] p-5 text-sm text-white/[0.62]">
          {emptyMessage ? (
            <AnimatedWidth value={emptyMessage}>
              <AnimatedText value={emptyMessage} />
            </AnimatedWidth>
          ) : null}
        </p>
      )}
    </MotionReveal>
  );
}
