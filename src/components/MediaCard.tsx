import { useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { Link } from "react-router-dom";
import { Play } from "lucide-react";
import { getLogoImageUrl, getPrimaryImageUrl } from "../lib/jellyfinApi";
import { getDisplayTitle, getItemSubtitle } from "../lib/format";
import type { JellyfinItem } from "../lib/types";

interface MediaCardProps {
  item: JellyfinItem;
  to: string;
  variant?: "poster" | "landscape";
  layout?: "row" | "grid";
  index?: number;
  animateIn?: boolean;
}

function getProgressPercent(item: JellyfinItem): number | null {
  const explicitPercentage = item.UserData?.PlayedPercentage;

  if (typeof explicitPercentage === "number") {
    return Math.min(100, Math.max(0, explicitPercentage));
  }

  if (item.UserData?.PlaybackPositionTicks && item.RunTimeTicks) {
    return Math.min(100, Math.max(0, (item.UserData.PlaybackPositionTicks / item.RunTimeTicks) * 100));
  }

  return null;
}

function getCardMainLabel(item: JellyfinItem): string {
  return getDisplayTitle(item);
}

function getEpisodeLabel(item: JellyfinItem): string | null {
  if (item.Type !== "Episode") {
    return null;
  }

  const seasonNumber = item.ParentIndexNumber ? `S${item.ParentIndexNumber}` : "";
  const episodeNumber = item.IndexNumber ? `E${item.IndexNumber}` : "";
  const code = `${seasonNumber}${episodeNumber}`;

  return code && item.Name ? `${code} · ${item.Name}` : code || item.Name || null;
}

function getCountLabel(item: JellyfinItem): string | null {
  if (item.Type === "Series") {
    const parts: string[] = [];

    if (typeof item.ChildCount === "number" && item.ChildCount > 0) {
      parts.push(item.ChildCount === 1 ? "1 Sezon" : `${item.ChildCount} Sezon`);
    }

    if (typeof item.RecursiveItemCount === "number" && item.RecursiveItemCount > 0) {
      parts.push(item.RecursiveItemCount === 1 ? "1 Bölüm" : `${item.RecursiveItemCount} Bölüm`);
    }

    return parts.length > 0 ? parts.join(" · ") : null;
  }

  if (item.Type === "Season") {
    const seasonLabel =
      typeof item.IndexNumber === "number" && item.IndexNumber > 0
        ? `${item.IndexNumber}. Sezon`
        : item.Name;

    const episodeCount =
      typeof item.ChildCount === "number" && item.ChildCount > 0
        ? item.ChildCount
        : typeof item.RecursiveItemCount === "number" && item.RecursiveItemCount > 0
          ? item.RecursiveItemCount
          : null;

    if (!episodeCount) {
      return seasonLabel;
    }

    const episodeLabel = episodeCount === 1 ? "1 Bölüm" : `${episodeCount} Bölüm`;

    return `${seasonLabel} · ${episodeLabel}`;
  }

  return null;
}

export function MediaCard({ item, to, variant = "poster", layout = "row", index = 0, animateIn = false }: MediaCardProps) {
  const shouldReduceMotion = useReducedMotion();
  const [imageFailed, setImageFailed] = useState(false);
  const [imageLoaded, setImageLoaded] = useState(false);
  const title = getCardMainLabel(item);
  const subtitle = getItemSubtitle(item);
  const countLabel = getCountLabel(item);
  const episodeLabel = getEpisodeLabel(item);
  const progressPercent = getProgressPercent(item);
  const imageUrl = item.ImageTags?.Primary
    ? getPrimaryImageUrl(item.Id, item.ImageTags.Primary, variant === "poster" ? 720 : 1100)
    : "";
  const logoUrl = item.ImageTags?.Logo
    ? getLogoImageUrl(item.Id, item.ImageTags.Logo, 700)
    : item.ParentLogoItemId && item.ParentLogoImageTag
      ? getLogoImageUrl(item.ParentLogoItemId, item.ParentLogoImageTag, 700)
      : "";
  const secondaryLabel = episodeLabel ?? (item.Type === "Season" ? null : !logoUrl ? title : null);
  const isLandscape = variant === "landscape";
  const sizeClass = layout === "grid" ? "w-full" : isLandscape ? "w-72 sm:w-80 lg:w-96" : "w-44 sm:w-52 lg:w-60";
  const entranceDelay = Math.min(index * 0.025, 0.18);
  const motionProps = animateIn
    ? shouldReduceMotion
      ? {
          initial: { opacity: 0 },
          whileInView: { opacity: 1 },
          viewport: { once: true, margin: "80px" },
          transition: { duration: 0.01 },
        }
      : {
          initial: { opacity: 0, y: 14, scale: 0.985 },
          whileInView: { opacity: 1, y: 0, scale: 1 },
          viewport: { once: true, margin: "80px" },
          transition: { duration: 0.3, delay: entranceDelay, ease: [0.22, 1, 0.36, 1] as [number, number, number, number] },
        }
    : {};

  return (
    <motion.div
      className={`min-w-0 shrink-0 ${sizeClass}`}
      whileTap={shouldReduceMotion ? undefined : { scale: 0.985 }}
      {...motionProps}
    >
      <Link
        to={to}
        aria-label={title}
        className="group block h-full w-full min-w-0 scroll-ml-4 transform-gpu overflow-hidden rounded-xl border border-white/10 bg-[var(--surface)] shadow-[0_18px_60px_rgba(0,0,0,0.35)] transition-[background-color,border-color,box-shadow,transform] duration-300 will-change-transform hover:z-10 hover:-translate-y-1.5 hover:scale-[1.025] hover:border-white/20 hover:bg-[var(--surface-hover)] hover:shadow-[0_22px_80px_rgba(0,0,0,0.52)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)] motion-reduce:hover:translate-y-0 motion-reduce:hover:scale-100"
      >
        <div className={`relative overflow-hidden bg-zinc-900 ${isLandscape ? "aspect-video" : "aspect-[2/3]"}`}>
          {!imageLoaded && imageUrl && !imageFailed ? <div className="shimmer absolute inset-0" /> : null}
          {imageUrl && !imageFailed ? (
            <img
              src={imageUrl}
              alt={title}
              loading="lazy"
              className={`h-full w-full object-cover object-center transition duration-500 group-hover:scale-[1.08] group-focus:scale-[1.08] ${
                imageLoaded ? "opacity-100" : "opacity-0"
              }`}
              onLoad={() => setImageLoaded(true)}
              onError={() => setImageFailed(true)}
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center bg-[linear-gradient(145deg,#27272a,#09090b)] p-5 text-center text-sm font-bold text-zinc-100">
              {title}
            </div>
          )}
          <div className="absolute inset-0 bg-gradient-to-t from-black via-black/20 to-transparent opacity-65 transition group-hover:opacity-90 group-focus:opacity-90" />
          <div className="absolute inset-x-0 bottom-0 translate-y-2 p-3 opacity-0 transition duration-300 group-hover:translate-y-0 group-hover:opacity-100 group-focus:translate-y-0 group-focus:opacity-100">
            <div className="flex items-end justify-end">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--accent)] text-zinc-950 shadow-xl">
                <Play size={18} fill="currentColor" />
              </span>
            </div>
          </div>
          {progressPercent !== null ? (
            <div className="absolute inset-x-0 bottom-0 h-1.5 bg-white/[0.18]">
              <div className="h-full bg-[var(--accent)]" style={{ width: `${progressPercent}%` }} />
            </div>
          ) : null}
        </div>
        <div className="h-[5.9rem] overflow-hidden p-3.5">
          <div className="flex h-9 w-full items-center overflow-hidden">
            {logoUrl ? (
              <div className="flex h-9 w-full items-center">
                <img
                  src={logoUrl}
                  alt={title}
                  className="h-full w-[78%] object-contain object-left"
                />
              </div>
            ) : (
              <h3 className="truncate text-sm font-bold leading-9 text-white">
                {title}
              </h3>
            )}
          </div>

          {countLabel ? (
            <p className="mt-2 h-5 truncate text-sm font-bold leading-5 text-white">
              {countLabel}
            </p>
          ) : (
            <h3
              className={`mt-2 h-5 truncate text-sm font-bold leading-5 ${
                secondaryLabel ? "text-white" : "text-transparent"
              }`}
              aria-hidden={!secondaryLabel}
            >
              {secondaryLabel ?? "Reserved"}
            </h3>
          )}

          {subtitle ? (
            <p className="mt-1 h-4 truncate text-xs font-medium leading-4 text-white/50">
              {subtitle}
            </p>
          ) : (
            <p className="mt-1 h-4 text-xs leading-4 text-transparent" aria-hidden={true}>
              Reserved
            </p>
          )}
        </div>
      </Link>
    </motion.div>
  );
}
