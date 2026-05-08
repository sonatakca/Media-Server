import type { JellyfinItem } from "./types";

const TICKS_PER_MINUTE = 600_000_000;

export function formatRuntime(runTimeTicks?: number): string | null {
  if (!runTimeTicks) {
    return null;
  }

  const totalMinutes = Math.round(runTimeTicks / TICKS_PER_MINUTE);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours <= 0) {
    return `${minutes}m`;
  }

  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
}

export function getDisplayTitle(item: JellyfinItem): string {
  
  if (item.Type === "Season") {
    if (typeof item.IndexNumber === "number" && item.IndexNumber > 0) {
      return `${item.IndexNumber}. Sezon`;
    }
    return item.Name;
  }

  if (item.Type === "Episode" && item.SeriesName) {
    const episodeNumber = item.IndexNumber ? `E${item.IndexNumber}` : "";
    const seasonNumber = item.ParentIndexNumber ? `S${item.ParentIndexNumber}` : "";
    const prefix = `${seasonNumber}${episodeNumber}`;
    return prefix ? `${item.SeriesName} ${prefix}` : item.SeriesName;
  }

  return item.Name;
}

export function getItemSubtitle(item: JellyfinItem): string | null {
  if (item.Type === "Season") {
    const parts = [item.SeriesName, item.ProductionYear?.toString()].filter(Boolean);
    return parts.length > 0 ? parts.join(" / ") : null;
  }

  const parts = [
    item.ProductionYear?.toString(),
    item.Type === "Episode" ? item.Name : undefined,
    formatRuntime(item.RunTimeTicks) ?? undefined,
  ].filter(Boolean);

  return parts.length > 0 ? parts.join(" / ") : null;
}
