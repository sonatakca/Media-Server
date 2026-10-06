import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowDownToLine, Check, RotateCw } from "lucide-react";
import { useLanguage } from "../../i18n/LanguageContext";
import type { MediaItem } from "../../lib/types";
import { notify } from "../../lib/notifications/notificationStore";
import {
  dismissDownloadFailure,
  startDownload,
  useActiveDownload,
} from "../../lib/offline/downloadController";
import { isOfflineSupported } from "../../lib/offline/offlineLibrary";
import { useOfflineTitle } from "../../lib/offline/useOfflineTitle";
import { formatBytes } from "../../lib/offline/formatBytes";
import { Tooltip } from "../ui/Tooltip";

interface DownloadButtonProps {
  item: MediaItem;
  className: string;
  iconSize?: number;
  /** Shows a short label beside the mark: what it would do, or how far it is. */
  showLabel?: boolean;
}

/** A ring that fills as the title arrives. */
function ProgressRing({ share }: { share: number }) {
  const radius = 9;
  const circumference = 2 * Math.PI * radius;
  return (
    <svg
      viewBox="0 0 24 24"
      width={22}
      height={22}
      aria-hidden="true"
      className="-rotate-90"
    >
      <circle
        cx="12"
        cy="12"
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeOpacity={0.25}
        strokeWidth={2.4}
      />
      <circle
        cx="12"
        cy="12"
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth={2.4}
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - Math.min(1, share))}
      />
    </svg>
  );
}

/**
 * Keeps a title on this device for watching without a connection.
 *
 * One control for the whole life of a download: start it, watch it fill,
 * resume one that stopped, and once it is complete, go to the Downloads page
 * where stored titles are played and removed.
 */
export function DownloadButton({
  item,
  className,
  iconSize = 19,
  showLabel = false,
}: DownloadButtonProps) {
  const { t } = useLanguage();
  const navigate = useNavigate();
  const stored = useOfflineTitle(item.Id);
  const active = useActiveDownload(item.Id);

  useEffect(() => {
    if (!active?.failure) return;
    notify({
      tone: active.failure === "failed" ? "error" : "info",
      title:
        active.failure === "not-allowed"
          ? t("downloads.notAllowed")
          : active.failure === "unavailable"
            ? t("downloads.unavailable")
            : t("downloads.failed"),
      key: `download-failure:${item.Id}`,
    });
    dismissDownloadFailure(item.Id);
  }, [active?.failure, item.Id, t]);

  if (!isOfflineSupported()) return null;

  const progress = active?.progress ?? null;
  const isDownloading = active !== null && active.failure === null;
  const share =
    progress && progress.estimatedBytes > 0
      ? progress.downloadedBytes / progress.estimatedBytes
      : 0;
  const isComplete = !isDownloading && stored?.state === "complete";
  const isResumable = !isDownloading && stored !== null && !isComplete;

  const label = isDownloading
    ? t("downloads.downloadingPercent").replace(
        "{percent}",
        String(Math.min(99, Math.round(share * 100))),
      )
    : isComplete
      ? t("downloads.downloadedSize").replace(
          "{size}",
          formatBytes(stored?.downloadedBytes ?? 0),
        )
      : isResumable
        ? t("downloads.resume")
        : t("downloads.download");

  const percent = String(Math.min(99, Math.round(share * 100)));
  const shortLabel = isDownloading
    ? t("downloads.percentShort").replace("{percent}", percent)
    : isComplete
      ? t("downloads.downloadedShort")
      : isResumable
        ? t("downloads.resume")
        : t("downloads.download");

  return (
    <Tooltip content={label} placement="top">
      <button
        type="button"
        aria-label={label}
        onClick={(event) => {
          // Also used inside a card that is itself a link.
          event.preventDefault();
          event.stopPropagation();
          if (isComplete || isDownloading) {
            navigate("/downloads");
            return;
          }
          startDownload(item);
        }}
        className={className}
      >
        {isDownloading ? (
          <ProgressRing share={share} />
        ) : isComplete ? (
          <Check size={iconSize} strokeWidth={2.4} />
        ) : isResumable ? (
          <RotateCw size={iconSize - 1} strokeWidth={2.2} />
        ) : (
          <ArrowDownToLine size={iconSize} strokeWidth={2.2} />
        )}
        {showLabel ? <span className="tabular-nums">{shortLabel}</span> : null}
      </button>
    </Tooltip>
  );
}
