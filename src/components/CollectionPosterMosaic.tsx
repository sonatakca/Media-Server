import type { CSSProperties } from "react";
import { getCollectionPosterItems } from "../lib/collectionPoster";
import { getPrimaryImageUrl } from "../lib/jellyfinApi";
import type { JellyfinItem } from "../lib/types";

interface CollectionPosterMosaicProps {
  title: string;
  items: JellyfinItem[];
  imageSize?: number;
}

function getGridStyle(count: number): CSSProperties {
  if (count <= 1) {
    return {};
  }

  return {
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gridTemplateRows: count >= 3 ? "repeat(2, minmax(0, 1fr))" : undefined,
  };
}

function getCellStyle(count: number, index: number): CSSProperties {
  if (count === 3 && index === 0) {
    return { gridRow: "span 2" };
  }

  return {};
}

export function CollectionPosterMosaic({
  title,
  items,
  imageSize = 520,
}: CollectionPosterMosaicProps) {
  const posterItems = getCollectionPosterItems(items);

  if (posterItems.length === 0) {
    return null;
  }

  return (
    <div
      aria-label={title}
      className="relative h-full w-full overflow-hidden bg-zinc-950"
      style={getGridStyle(posterItems.length)}
    >
      {posterItems.map((posterItem, index) => {
        const imageTag = posterItem.ImageTags?.Primary;

        if (!imageTag) {
          return null;
        }

        return (
          <img
            key={posterItem.Id}
            src={getPrimaryImageUrl(posterItem.Id, imageTag, imageSize)}
            alt={posterItem.Name}
            loading="lazy"
            decoding="async"
            className="h-full w-full object-cover"
            style={getCellStyle(posterItems.length, index)}
          />
        );
      })}
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(145deg,rgba(255,255,255,0.08),rgba(0,0,0,0.22)_55%,rgba(0,0,0,0.58))]" />
    </div>
  );
}
