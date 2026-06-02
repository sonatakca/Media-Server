import { useEffect, useState } from "react";
import { RotateCw } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useLanguage } from "../i18n/LanguageContext";
import { clearContinueWatchingHistory } from "../lib/continueWatchingActions";
import { getDisplayTitle } from "../lib/format";
import { getWatchRouteForItem } from "../lib/routes";
import type { JellyfinItem } from "../lib/types";
import { Tooltip } from "./ui/Tooltip";

interface RestartWatchingButtonProps {
  item: JellyfinItem;
  className: string;
  iconSize?: number;
}

export function RestartWatchingButton({
  item,
  className,
  iconSize = 16,
}: RestartWatchingButtonProps) {
  const navigate = useNavigate();
  const { t } = useLanguage();
  const [isRestarting, setIsRestarting] = useState(false);
  const [didRestartFail, setDidRestartFail] = useState(false);
  const title = getDisplayTitle(item);
  const accessibleLabel = `${t("home.startOver")} ${title}`;

  useEffect(() => {
    setIsRestarting(false);
    setDidRestartFail(false);
  }, [item.Id]);

  const handleRestart = async () => {
    if (isRestarting) {
      return;
    }

    setIsRestarting(true);
    setDidRestartFail(false);

    try {
      const playbackItem = await clearContinueWatchingHistory(item);

      navigate(`${getWatchRouteForItem(playbackItem)}?restart=1`);
    } catch (error) {
      console.warn(
        "[Seyirlik Continue Watching] Could not restart item",
        error,
      );
      setDidRestartFail(true);
      setIsRestarting(false);
    }
  };

  const tooltipLabel = didRestartFail
    ? t("home.couldNotStartOver")
    : t("home.startOver");

  return (
    <Tooltip content={tooltipLabel}>
      <button
        type="button"
        onClick={() => void handleRestart()}
        disabled={isRestarting}
        aria-label={accessibleLabel}
        className={`${className} disabled:cursor-wait disabled:opacity-65`}
      >
        <RotateCw
          size={iconSize}
          className={isRestarting ? "animate-spin" : undefined}
        />
      </button>
    </Tooltip>
  );
}
