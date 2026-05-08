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

export function MediaRow({ title, items, getItemTo, variant = "poster", emptyMessage, viewAllTo }: MediaRowProps) {
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
      left: direction === "left" ? -scroller.clientWidth * 0.82 : scroller.clientWidth * 0.82,
      behavior: "smooth",
    });
  };

  return (
    <MotionReveal className="py-6" direction="up">
      <div className="mb-0 flex items-end justify-between gap-4">
        <h2 className="text-xl font-black text-white sm:text-2xl">
          <AnimatedWidth value={title}>
            <AnimatedText value={title} />
          </AnimatedWidth>
        </h2>
        {viewAllTo ? (
          <Link to={viewAllTo} className="text-sm font-bold text-white/[0.55] transition hover:text-white">
            <AnimatedWidth value={t("common.viewAll")}>
              <AnimatedText value={t("common.viewAll")} />
            </AnimatedWidth>
          </Link>
        ) : null}
      </div>
      {items.length > 0 ? (
        <div className="group/viewport relative">
          <div
            ref={scrollerRef}
            onScroll={updateScrollState}
            className="media-scroll flex snap-x gap-5 overflow-x-auto overflow-y-visible pb-8 pt-6"
          >
            {items.map((item, index) => (
              <div key={item.Id} className="snap-start">
                <MediaCard item={item} to={getItemTo(item)} variant={variant} index={index} animateIn />
              </div>
            ))}
          </div>
          <div
            className={`pointer-events-none absolute bottom-6 left-0 top-2 z-10 hidden w-14 bg-gradient-to-r from-[rgba(5,6,7,0.82)] to-transparent transition-opacity duration-200 lg:block ${
              canScrollLeft ? "opacity-100" : "opacity-0"
            }`}
          />
          <div
            className={`pointer-events-none absolute bottom-6 right-0 top-2 z-10 hidden w-14 bg-gradient-to-l from-[rgba(5,6,7,0.82)] to-transparent transition-opacity duration-200 lg:block ${
              canScrollRight ? "opacity-100" : "opacity-0"
            }`}
          />
          {canScrollLeft ? (
            <button
              type="button"
              onClick={() => scrollByCards("left")}
              className="absolute left-3 top-[calc(50%-0.75rem)] z-20 hidden h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full border border-white/10 bg-black/[0.58] text-white opacity-0 shadow-2xl backdrop-blur-xl transition hover:bg-white/[0.14] focus:opacity-100 focus:outline-none focus:ring-2 focus:ring-[var(--accent)] group-hover/viewport:opacity-100 lg:flex"
              aria-label={`Scroll ${title} left`}
            >
              <ChevronLeft size={22} />
            </button>
          ) : null}
          {canScrollRight ? (
            <button
              type="button"
              onClick={() => scrollByCards("right")}
              className="absolute right-3 top-[calc(50%-0.75rem)] z-20 hidden h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full border border-white/10 bg-black/[0.58] text-white opacity-0 shadow-2xl backdrop-blur-xl transition hover:bg-white/[0.14] focus:opacity-100 focus:outline-none focus:ring-2 focus:ring-[var(--accent)] group-hover/viewport:opacity-100 lg:flex"
              aria-label={`Scroll ${title} right`}
            >
              <ChevronRight size={22} />
            </button>
          ) : null}
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
