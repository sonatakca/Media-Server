import { Link } from "react-router-dom";
import { ChevronRight, Film, Tv } from "lucide-react";
import { useLanguage } from "../i18n/LanguageContext";
import { getBackdropImageUrl, getPrimaryImageUrl } from "../lib/jellyfinApi";
import type { JellyfinLibrary } from "../lib/types";
import { AnimatedText } from "./AnimatedText";
import { AnimatedWidth } from "./AnimatedWidth";

interface LibraryTileProps {
  library: JellyfinLibrary;
}

function getLibraryImage(library: JellyfinLibrary): string {
  if (library.BackdropImageTags?.[0]) {
    return getBackdropImageUrl(library.Id, library.BackdropImageTags[0], 1100);
  }

  if (library.ImageTags?.Primary) {
    return getPrimaryImageUrl(library.Id, library.ImageTags.Primary, 900);
  }

  return "";
}

export function LibraryTile({ library }: LibraryTileProps) {
  const { t } = useLanguage();
  const imageUrl = getLibraryImage(library);
  const Icon = library.CollectionType === "tvshows" ? Tv : Film;
  const collectionLabel =
    library.CollectionType === "movies"
      ? t("common.movies")
      : library.CollectionType === "boxsets"
        ? t("common.boxsets")
        : library.CollectionType || t("library.library");

  return (
    <Link
      to={`/library/${library.Id}`}
      className="group relative block w-72 shrink-0 snap-start overflow-hidden rounded-2xl border border-white/10 bg-[var(--surface)] shadow-[0_20px_70px_rgba(0,0,0,0.36)] transition duration-300 hover:-translate-y-1 hover:border-white/20 hover:shadow-[0_24px_90px_rgba(0,0,0,0.52)] sm:w-96"
    >
      <div className="aspect-[16/9] bg-zinc-900">
        {imageUrl ? (
          <img
            src={imageUrl}
            alt={library.Name}
            loading="lazy"
            className="h-full w-full object-cover opacity-76 transition duration-500 group-hover:scale-[1.06] group-hover:opacity-95"
          />
        ) : (
          <div className="h-full w-full bg-[linear-gradient(135deg,#27272a,#050506)]" />
        )}
      </div>
      <div className="absolute inset-0 bg-gradient-to-t from-black via-black/24 to-transparent" />
      <div className="absolute inset-x-0 bottom-0 flex items-end justify-between gap-4 p-5">
        <div>
          <span className="mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-white/[0.12] text-white backdrop-blur">
            <Icon size={21} />
          </span>
          <h3 className="text-2xl font-black text-white">{library.Name}</h3>
          <p className="mt-1 text-sm font-semibold uppercase tracking-[0.18em] text-white/[0.48]">
            <AnimatedWidth value={collectionLabel}>
              <AnimatedText value={collectionLabel} />
            </AnimatedWidth>
          </p>
        </div>
        <span className="flex h-11 w-11 items-center justify-center rounded-full bg-[var(--accent)] text-black opacity-0 shadow-xl transition group-hover:opacity-100">
          <ChevronRight size={22} />
        </span>
      </div>
    </Link>
  );
}
