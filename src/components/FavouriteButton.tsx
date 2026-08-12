import type { CSSProperties, MouseEvent } from "react";
import { Check, Loader2, Plus } from "lucide-react";
import { useLanguage } from "../i18n/LanguageContext";
import { useFavouriteState } from "../hooks/useFavouriteState";
import type { MediaItem } from "../lib/types";
import { Tooltip } from "./ui/Tooltip";

interface FavouriteButtonProps {
  item: MediaItem;
  className: string;
  style?: CSSProperties;
  iconSize?: number;
  showLabel?: boolean;
  tooltipGroup?: string;
}

export function FavouriteButton({
  item,
  className,
  style,
  iconSize = 18,
  showLabel = false,
  tooltipGroup,
}: FavouriteButtonProps) {
  const { t } = useLanguage();
  const { isFavourite, isSaving, didFail, toggle } = useFavouriteState(item);

  const label = isFavourite
    ? t("myList.removeFromMyList")
    : t("myList.addToMyList");
  const tooltipLabel = didFail ? t("myList.couldNotSave") : label;

  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    // Cards and hero panels wrap this control in their own link/overlay, and a
    // bubbled click there would navigate away mid-save.
    event.preventDefault();
    event.stopPropagation();
    toggle();
  };

  return (
    <Tooltip content={tooltipLabel} group={tooltipGroup}>
      <button
        type="button"
        onClick={handleClick}
        aria-label={label}
        aria-pressed={isFavourite}
        style={style}
        className={`${className} disabled:cursor-wait`}
      >
        {isSaving ? (
          <Loader2 size={iconSize} className="animate-spin" />
        ) : isFavourite ? (
          <Check size={iconSize} />
        ) : (
          <Plus size={iconSize} />
        )}
        {showLabel ? <span>{label}</span> : null}
      </button>
    </Tooltip>
  );
}
