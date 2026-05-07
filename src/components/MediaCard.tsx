import { useState } from "react";
import { Link } from "react-router-dom";
import { Play } from "lucide-react";
import { getPrimaryImageUrl } from "../lib/jellyfinApi";
import { getDisplayTitle, getItemSubtitle } from "../lib/format";
import type { JellyfinItem } from "../lib/types";

interface MediaCardProps {
  item: JellyfinItem;
  to: string;
  variant?: "poster" | "landscape";
  layout?: "row" | "grid";
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

export function MediaCard({ item, to, variant = "poster", layout = "row" }: MediaCardProps) {
  const [imageFailed, setImageFailed] = useState(false);
  const [imageLoaded, setImageLoaded] = useState(false);
  const title = getDisplayTitle(item);
  const subtitle = getItemSubtitle(item);
  const progressPercent = getProgressPercent(item);
  const imageUrl = item.ImageTags?.Primary
    ? getPrimaryImageUrl(item.Id, item.ImageTags.Primary, variant === "poster" ? 720 : 1100)
    : "";
  const isLandscape = variant === "landscape";
  const sizeClass = layout === "grid" ? "w-full" : isLandscape ? "w-72 sm:w-80 lg:w-96" : "w-44 sm:w-52 lg:w-60";

  return (
    <Link
      to={to}
      className={`group block min-w-0 scroll-ml-4 transform-gpu overflow-hidden rounded-xl border border-white/10 bg-[var(--surface)] shadow-[0_18px_60px_rgba(0,0,0,0.35)] transition duration-300 will-change-transform hover:z-10 hover:-translate-y-1.5 hover:scale-[1.025] hover:border-white/20 hover:bg-[var(--surface-hover)] hover:shadow-[0_22px_80px_rgba(0,0,0,0.52)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)] ${
        sizeClass
      }`}
    >
      <div className={`relative overflow-hidden bg-zinc-900 ${isLandscape ? "aspect-video" : "aspect-[2/3]"}`}>
        {!imageLoaded && imageUrl && !imageFailed ? <div className="shimmer absolute inset-0" /> : null}
        {imageUrl && !imageFailed ? (
          <img
            src={imageUrl}
            alt={title}
            loading="lazy"
            className={`h-full w-full object-cover transition duration-500 group-hover:scale-[1.08] group-focus:scale-[1.08] ${
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
          <div className="flex items-end justify-between gap-3">
            <div className="min-w-0">
              <h3 className="line-clamp-2 text-sm font-black leading-tight text-white drop-shadow-lg sm:text-base">
                {title}
              </h3>
              {subtitle ? <p className="mt-1 truncate text-xs font-medium text-white/[0.68]">{subtitle}</p> : null}
            </div>
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
      <div className="min-h-[5.25rem] p-3.5">
        <h3 className="truncate text-sm font-bold text-white">{title}</h3>
        {subtitle ? <p className="mt-1 truncate text-xs font-medium text-white/50">{subtitle}</p> : null}
      </div>
    </Link>
  );
}
