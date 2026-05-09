import { Copy, Link2, Loader2, LogOut, Plus, Users, Wifi, WifiOff } from "lucide-react";
import { useLanguage } from "../../i18n/LanguageContext";
import type { PartyWatchController } from "./partyWatchTypes";

interface PartyWatchControlsProps {
  controller: PartyWatchController;
  visible: boolean;
}

function getSocketLabel(status: PartyWatchController["socketStatus"], t: ReturnType<typeof useLanguage>["t"]): string {
  if (status === "connected") {
    return t("party.socketConnected");
  }

  if (status === "connecting") {
    return t("party.socketConnecting");
  }

  return t("party.socketDisconnected");
}

export function PartyWatchControls({ controller, visible }: PartyWatchControlsProps) {
  const { t } = useLanguage();

  if (!visible && !controller.isInGroup) {
    return null;
  }

  const isBusy = controller.isLoading || controller.isApplyingRemoteCommand;

  const roleLabel =
    controller.role === "host"
      ? t("party.roleHost")
      : controller.role === "member"
        ? t("party.roleMember")
        : null;

  const participantLabel =
    controller.participantCount !== null
      ? `${controller.participantCount} ${t("party.participants")}`
      : null;

  const socketLabel = getSocketLabel(controller.socketStatus, t);

  return (
    <section
      className={`w-[min(22rem,calc(100vw-2rem))] rounded-lg bg-gray p-3 text-white shadow-[0_18px_80px_rgba(0,0,0,0.48)] backdrop-blur-xl transition duration-300 ${
        visible || controller.isInGroup ? "translate-y-0 opacity-100" : "-translate-y-2 opacity-0"
      }`}
      aria-label={t("party.title")}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/10 text-[var(--accent)]">
            <Users size={17} />
          </span>

          <div className="min-w-0">
            <p className="truncate text-sm font-bold">{t("party.title")}</p>
            <p className="truncate text-[0.72rem] font-medium text-white/55">
              {[roleLabel, participantLabel, controller.groupState].filter(Boolean).join(" · ") || socketLabel}
            </p>
          </div>
        </div>

        <span
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${
            controller.socketStatus === "connected" ? "text-[var(--accent)]" : "text-white/45"
          }`}
          title={socketLabel}
          aria-label={socketLabel}
        >
          {controller.socketStatus === "connected" ? <Wifi size={16} /> : <WifiOff size={16} />}
        </span>
      </div>

      {controller.isInGroup ? (
        <div className="mt-3 space-y-2">
          <div className="flex items-center gap-2 rounded-md border border-white/10 bg-white/[0.055] px-2.5 py-2">
            <Link2 className="shrink-0 text-white/55" size={15} />
            <span className="min-w-0 flex-1 truncate text-xs font-semibold text-white/72">
              {controller.groupName ?? controller.groupId}
            </span>
          </div>

          {controller.participantNames.length > 0 ? (
            <div className="rounded-md border border-white/10 bg-white/[0.045] px-2.5 py-2">
              <p className="mb-1.5 text-[0.68rem] font-black uppercase tracking-[0.14em] text-white/38">
                Katılımcılar
              </p>

              <div className="flex flex-wrap gap-1.5">
                {controller.participantNames.map((name, index) => (
                  <span
                    key={`${name}-${index}`}
                    className="inline-flex max-w-full items-center rounded-full border border-white/10 bg-black/32 px-2 py-1 text-xs font-semibold text-white/75"
                    title={name}
                  >
                    <span className="max-w-[9rem] truncate">{name}</span>
                  </span>
                ))}
              </div>
            </div>
          ) : null}

          <div className="grid grid-cols-[1fr_auto] gap-2">
            <button
              type="button"
              onClick={controller.copyInvite}
              disabled={!controller.inviteUrl || isBusy}
              className="inline-flex min-h-10 items-center justify-center gap-2 rounded-md bg-white text-sm font-bold text-black transition hover:bg-[var(--accent)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-55"
            >
              <Copy size={16} />
              {t("party.copyInvite")}
            </button>

            <button
              type="button"
              onClick={controller.leaveGroup}
              disabled={isBusy}
              className="flex h-10 w-10 items-center justify-center rounded-md  border-white/12 text-white/82 transition hover:bg-white/12 hover:text-white focus:outline-none focus:ring-2 focus:ring-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-55"
              aria-label={t("party.leave")}
              title={t("party.leave")}
            >
              {controller.isLoading ? <Loader2 className="animate-spin" size={16} /> : <LogOut size={16} />}
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-3 space-y-2">
          <button
            type="button"
            onClick={controller.createGroup}
            disabled={!controller.isAvailable || isBusy}
            className="inline-flex min-h-10 w-full items-center justify-center gap-2 rounded-md bg-white text-sm font-bold text-black transition hover:bg-[var(--accent)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-55"
          >
            {controller.isLoading ? <Loader2 className="animate-spin" size={16} /> : <Plus size={16} />}
            {t("party.createRoom")}
          </button>

          <div className="grid grid-cols-[1fr_auto] gap-2">
            <input
              value={controller.joinInput}
              onChange={(event) => controller.setJoinInput(event.target.value)}
              placeholder={t("party.joinPlaceholder")}
              disabled={!controller.isAvailable || isBusy}
              className="h-10 min-w-0 rounded-md border border-white/12 bg-white/[0.07] px-3 text-sm font-semibold text-white outline-none transition placeholder:text-white/36 focus:border-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-55"
            />

            <button
              type="button"
              onClick={() => void controller.joinGroup()}
              disabled={!controller.isAvailable || isBusy || controller.joinInput.trim().length === 0}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-white/12 px-3 text-sm font-bold text-white transition hover:bg-white/12 focus:outline-none focus:ring-2 focus:ring-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-55"
            >
              <Link2 size={15} />
              {t("party.joinRoom")}
            </button>
          </div>
        </div>
      )}

      
    </section>
  );
}