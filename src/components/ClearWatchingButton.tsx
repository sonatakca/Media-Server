import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { useLanguage } from "../i18n/LanguageContext";
import { clearContinueWatchingHistory } from "../lib/continueWatchingActions";
import { getDisplayTitle } from "../lib/format";
import type { JellyfinItem } from "../lib/types";

interface ClearWatchingButtonProps {
  item: JellyfinItem;
  className: string;
  iconSize?: number;
  onCleared: (item: JellyfinItem) => void;
}

export function ClearWatchingButton({
  item,
  className,
  iconSize = 16,
  onCleared,
}: ClearWatchingButtonProps) {
  const { t } = useLanguage();
  const [isClearing, setIsClearing] = useState(false);
  const [didClearFail, setDidClearFail] = useState(false);
  const title = getDisplayTitle(item);

  useEffect(() => {
    setIsClearing(false);
    setDidClearFail(false);
  }, [item.Id]);

  const handleClear = async () => {
    if (isClearing) {
      return;
    }

    setIsClearing(true);
    setDidClearFail(false);

    try {
      await clearContinueWatchingHistory(item);
      onCleared(item);
    } catch (error) {
      console.warn(
        "[Seyirlik Continue Watching] Could not clear history",
        error,
      );
      setDidClearFail(true);
      setIsClearing(false);
    }
  };

  return (
    <button
      type="button"
      onClick={() => void handleClear()}
      disabled={isClearing}
      aria-label={`${t("home.clearHistory")} ${title}`}
      title={
        didClearFail ? t("home.couldNotClearHistory") : t("home.clearHistory")
      }
      className={`${className} disabled:cursor-wait disabled:opacity-65`}
    >
      <X size={iconSize} />
    </button>
  );
}
