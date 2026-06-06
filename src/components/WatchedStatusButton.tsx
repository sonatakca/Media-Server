import { useEffect, useState } from "react";
import { Eye, EyeOff, Loader2 } from "lucide-react";
import { useLanguage } from "../i18n/LanguageContext";
import {
  markWatchedStatusForItem,
  markWatchedStatusForSeason,
  markWatchedStatusForShow,
  removeWatchedStatusForItem,
  removeWatchedStatusForSeason,
  removeWatchedStatusForShow,
} from "../lib/watchedStatusActions";
import type { JellyfinItem } from "../lib/types";
import { isItemCompleted } from "../lib/watchStatus";
import { Tooltip } from "./ui/Tooltip";

type WatchedStatusScope = "item" | "season" | "show";
type WatchedStatusAction = "mark" | "remove";

interface WatchedStatusButtonProps {
  scope: WatchedStatusScope;
  action?: WatchedStatusAction;
  item?: JellyfinItem;
  seriesId?: string;
  seasonId?: string;
  className: string;
  iconSize?: number;
  label?: string;
  confirm?: boolean;
  onReset?: (items: JellyfinItem[]) => void;
}

export function WatchedStatusButton({
  scope,
  action = "remove",
  item,
  seriesId,
  seasonId,
  className,
  iconSize = 18,
  label,
  confirm = false,
  onReset,
}: WatchedStatusButtonProps) {
  const { t } = useLanguage();
  const [isResetting, setIsResetting] = useState(false);
  const [didResetFail, setDidResetFail] = useState(false);
  const fallbackLabel =
    action === "mark"
      ? scope === "show"
        ? t("details.markWatchedStatusForShow")
        : scope === "season"
          ? t("details.markWatchedStatusForSeason")
          : t("details.markWatchedStatus")
      : scope === "show"
        ? t("details.removeWatchedStatusForShow")
        : scope === "season"
          ? t("details.removeWatchedStatusForSeason")
          : t("details.removeWatchedStatus");
  const buttonLabel = label ?? fallbackLabel;

  useEffect(() => {
    setIsResetting(false);
    setDidResetFail(false);
  }, [action, item?.Id, scope, seasonId, seriesId]);

  if (scope === "item") {
    if (!item) {
      return null;
    }

    const completed = isItemCompleted(item);

    if (
      (action === "remove" && !completed) ||
      (action === "mark" && completed)
    ) {
      return null;
    }
  }

  const handleChange = async () => {
    if (isResetting) {
      return;
    }

    const confirmLabel =
      action === "mark"
        ? t("details.confirmMarkWatchedStatus")
        : t("details.confirmRemoveWatchedStatus");

    if (confirm && !window.confirm(confirmLabel)) {
      return;
    }

    setIsResetting(true);
    setDidResetFail(false);

    try {
      let changedItems: JellyfinItem[];

      if (action === "mark" && scope === "item" && item) {
        changedItems = await markWatchedStatusForItem(item);
      } else if (
        action === "mark" &&
        scope === "season" &&
        seriesId &&
        seasonId
      ) {
        changedItems = await markWatchedStatusForSeason(seriesId, seasonId);
      } else if (action === "mark" && scope === "show" && seriesId) {
        changedItems = await markWatchedStatusForShow(seriesId);
      } else if (scope === "item" && item) {
        changedItems = await removeWatchedStatusForItem(item);
      } else if (scope === "season" && seriesId && seasonId) {
        changedItems = await removeWatchedStatusForSeason(seriesId, seasonId);
      } else if (scope === "show" && seriesId) {
        changedItems = await removeWatchedStatusForShow(seriesId);
      } else {
        throw new Error("Missing watched-status change target.");
      }

      onReset?.(changedItems);
      setIsResetting(false);
    } catch (error) {
      console.warn(
        "[Seyirlik Watch Status] Could not change watched status",
        error,
      );
      setDidResetFail(true);
      setIsResetting(false);
    }
  };

  const tooltipLabel = didResetFail
    ? action === "mark"
      ? t("details.couldNotMarkWatchedStatus")
      : t("details.couldNotRemoveWatchedStatus")
    : buttonLabel;

  return (
    <Tooltip content={tooltipLabel}>
      <button
        type="button"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          void handleChange();
        }}
        disabled={isResetting}
        aria-label={buttonLabel}
        className={`${className} disabled:cursor-wait disabled:opacity-65`}
      >
        {isResetting ? (
          <Loader2 size={iconSize} className="animate-spin" />
        ) : action === "mark" ? (
          <Eye size={iconSize} />
        ) : (
          <EyeOff size={iconSize} />
        )}
        {/* {label ? <span>{label}</span> : null} */}
      </button>
    </Tooltip>
  );
}
