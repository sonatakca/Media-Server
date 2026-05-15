import { Loader2, Users } from "lucide-react";
import { useLanguage } from "../../i18n/LanguageContext";
import type { PartyWatchController } from "./partyWatchTypes";

interface PartyWatchOverlayProps {
  controller: PartyWatchController;
}

export function PartyWatchOverlay({ controller }: PartyWatchOverlayProps) {
  const { t } = useLanguage();

  if (!controller.isInGroup && !controller.errorKey && !controller.statusKey) {
    return null;
  }

  const messageKey =
    controller.errorKey ??
    controller.statusKey ??
    (controller.isInGroup ? "party.syncingWithJellyfinSyncPlay" : null);

  if (!messageKey) {
    return null;
  }

  return (
    <div className="pointer-events-none absolute left-1/2 top-[max(5.25rem,calc(env(safe-area-inset-top)+4.75rem))] z-40 w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2">
      <div
        className={`mx-auto flex w-fit max-w-full items-center gap-2 rounded-2xl px-3 py-2 text-sm font-semibold shadow-[0_18px_80px_rgba(0,0,0,0.45)] bg-black/70 backdrop-blur-xl ${
          controller.errorKey
            ? "border-rose-300/25 bg-rose-950/68 text-rose-100"
            : "border-white/12 bg-black/66 text-white"
        }`}
      >
        {controller.isApplyingRemoteCommand || controller.isLoading ? (
          <Loader2
            className="shrink-0 animate-spin text-[var(--accent)]"
            size={16}
          />
        ) : (
          <Users className="shrink-0 text-[var(--accent)]" size={16} />
        )}
        <span className="min-w-0 truncate">{t(messageKey)}</span>
      </div>
    </div>
  );
}
