import { useEffect, useState } from "react";
import type { TranslationKey } from "../../i18n/translations";
import type { PartyNotice, PartySessionState } from "./partySession";
import type { PartySnapshot } from "./partyWatchTypes";

type Translate = (key: TranslationKey) => string;

/** How long a one-line notice about someone else's action stays up. */
const NOTICE_VISIBLE_MS = 3_500;

export function formatPartyTime(positionMs: number): string {
  const total = Math.max(0, Math.floor(positionMs / 1_000));
  const hours = Math.floor(total / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
    : `${minutes}:${seconds}`;
}

const fill = (template: string, values: Record<string, string>) =>
  Object.entries(values).reduce(
    (text, [key, value]) => text.replace(`{${key}}`, value),
    template,
  );

/** One line about what someone else just did, or null if nothing to say. */
export function describePartyNotice(
  notice: PartyNotice,
  t: Translate,
): string | null {
  const { cause, snapshot } = notice;
  const name = cause.displayName ?? "";
  switch (cause.kind) {
    case "play":
      return fill(t("party.notice.play"), { name });
    case "pause":
      return fill(t("party.notice.pause"), { name });
    case "seek":
      return fill(t("party.notice.seek"), {
        name,
        time: formatPartyTime(snapshot.positionMs),
      });
    case "setItem":
      return fill(t("party.notice.setItem"), { name });
    case "joined":
      return fill(t("party.notice.joined"), { name });
    case "left":
      return fill(t("party.notice.left"), { name });
    case "resumed": {
      const names = (cause.releasedPast ?? [])
        .map((entry) => entry.displayName)
        .filter(Boolean);
      return names.length > 0
        ? fill(t("party.notice.continuingWithout"), { name: names.join(", ") })
        : null;
    }
    case "hold":
      return null;
  }
}

/** "Waiting for Ece…" while the group holds for others, else null. */
export function describeWaiting(
  snapshot: PartySnapshot,
  selfId: string,
  t: Translate,
): string | null {
  if (!snapshot.hold) return null;
  const others = snapshot.hold.waitingFor.filter((id) => id !== selfId);
  if (others.length === 0) return null;
  if (others.length === 1) {
    const name =
      snapshot.participants.find((participant) => participant.id === others[0])
        ?.displayName ?? "";
    return fill(t("party.status.waitingFor"), { name });
  }
  return fill(t("party.status.waitingForMany"), {
    count: String(others.length),
  });
}

/** The current notice line, shown for a moment and then cleared. */
export function usePartyNoticeMessage(
  state: PartySessionState | null,
  t: Translate,
): string | null {
  const notice = state?.notice ?? null;
  const [visible, setVisible] = useState<{ id: number; text: string } | null>(
    null,
  );

  useEffect(() => {
    if (!notice) return undefined;
    const text = describePartyNotice(notice, t);
    if (!text) return undefined;
    setVisible({ id: notice.id, text });
    const timer = setTimeout(() => {
      setVisible((current) => (current?.id === notice.id ? null : current));
    }, NOTICE_VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [notice, t]);

  useEffect(() => {
    if (!state || state.connection === "ended") setVisible(null);
  }, [state]);

  return visible?.text ?? null;
}
