import { ChevronRight, Film, Tv } from "lucide-react";
import { Link } from "react-router-dom";
import { useLanguage } from "../../i18n/LanguageContext";
import { getBackdropImageUrl, getPrimaryImageUrl } from "../../lib/jellyfinApi";
import type { JellyfinLibrary } from "../../lib/types";

function getLibraryImage(library: JellyfinLibrary): string {
  if (library.BackdropImageTags?.[0]) {
    return getBackdropImageUrl(library.Id, library.BackdropImageTags[0], 720);
  }

  if (library.ImageTags?.Primary) {
    return getPrimaryImageUrl(library.Id, library.ImageTags.Primary, 560);
  }

  return "";
}

export function MobileLibraryTile({ library }: { library: JellyfinLibrary }) {
  const { t } = useLanguage();
  const imageUrl = getLibraryImage(library);
  const Icon = library.CollectionType === "tvshows" ? Tv : Film;
  const label =
    library.CollectionType === "movies"
      ? t("common.movies")
      : library.CollectionType === "tvshows"
        ? t("common.series")
        : library.CollectionType || t("library.library");

  return (
    <Link
      to={`/library/${library.Id}`}
      className="relative block w-[17rem] shrink-0 snap-start overflow-hidden rounded-2xl border border-white/10 bg-[var(--surface)]"
    >
      <div className="aspect-[16/9] bg-zinc-900">
        {imageUrl ? (
          <img
            src={imageUrl}
            alt={library.Name}
            loading="lazy"
            decoding="async"
            className="h-full w-full object-cover opacity-80"
          />
        ) : null}
      </div>
      <div className="absolute inset-0 bg-gradient-to-t from-black via-black/15 to-transparent" />
      <div className="absolute inset-x-0 bottom-0 flex items-end justify-between p-4">
        <div>
          <span className="mb-2 flex h-8 w-8 items-center justify-center rounded-full bg-white/15 text-white backdrop-blur">
            <Icon size={16} />
          </span>
          <h3 className="text-lg font-black text-white">{library.Name}</h3>
          <p className="text-[0.66rem] font-bold uppercase tracking-[0.18em] text-white/55">
            {label}
          </p>
        </div>
        <span className="flex h-9 w-9 items-center justify-center rounded-full bg-[var(--accent)] text-black">
          <ChevronRight size={18} />
        </span>
      </div>
    </Link>
  );
}
