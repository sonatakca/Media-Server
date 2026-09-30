import { useEffect, useState } from "react";

/** How long the toast takes to leave before its text is dropped. */
const TOAST_EXIT_MS = 260;

/**
 * Holds the last party notice on screen long enough to animate it out.
 *
 * The notice itself disappears the instant the party state moves on; the
 * toast keeps its text for the exit so it does not go blank mid-fade.
 */
export function usePartyEventToast(partyNoticeMessage: string | null) {
  const [displayedPartyEventMessage, setDisplayedPartyEventMessage] = useState<
    string | null
  >(null);
  const [isPartyEventToastLeaving, setIsPartyEventToastLeaving] =
    useState(false);

  useEffect(() => {
    if (partyNoticeMessage) {
      setDisplayedPartyEventMessage(partyNoticeMessage);
      setIsPartyEventToastLeaving(false);
      return undefined;
    }

    if (!displayedPartyEventMessage) {
      return undefined;
    }

    setIsPartyEventToastLeaving(true);

    const timer = window.setTimeout(() => {
      setDisplayedPartyEventMessage(null);
      setIsPartyEventToastLeaving(false);
    }, TOAST_EXIT_MS);

    return () => {
      window.clearTimeout(timer);
    };
  }, [partyNoticeMessage, displayedPartyEventMessage]);

  return { displayedPartyEventMessage, isPartyEventToastLeaving };
}
