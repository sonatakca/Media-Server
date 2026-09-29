import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import type { TranslationKey } from "../../i18n/translations";
import { getCachedSession } from "../../lib/authStorage";
import { partyLog } from "./partyDiagnostics";
import {
  acquirePartySession,
  forgetPartySession,
  getPartyTransport,
  partyClientId,
  releasePartySession,
} from "./partyRegistry";
import type { PartySession, PartySessionState } from "./partySession";
import type { PartySnapshot } from "./partyWatchTypes";

/**
 * Party Watch for a player page.
 *
 * The URL is where this tab's intent lives: `?party=<id>` means "I am in that
 * party". Creating or joining one sets it, leaving removes it, and everything
 * else follows — a reload rejoins, an invite link is just the URL, and moving
 * to the next episode carries it along. The server is where the party's state
 * lives. Nothing in between keeps a third copy.
 */

export interface PartyStart {
  positionMs: number;
  playing: boolean;
}

export interface PartyWatch {
  groupId: string | null;
  session: PartySession | null;
  state: PartySessionState | null;
  isCreating: boolean;
  /** Why the last create or join could not start. */
  errorKey: TranslationKey | null;
  inviteUrl: string | null;
  /** Starts a party from where this viewer already is. */
  create(start?: PartyStart): Promise<void>;
  /** Accepts a party link or a bare id; false if it is neither. */
  join(input: string): boolean;
  leave(): Promise<void>;
  end(): Promise<void>;
  /** Clears an ended party from the page. */
  dismiss(): void;
  /** Moves this page to the title the party is watching. */
  followItem(itemId: string): void;
}

const GROUP_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normalizeGroupId(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && GROUP_ID_PATTERN.test(trimmed)
    ? trimmed.toLowerCase()
    : null;
}

/** A pasted invite link or a bare id. */
export function extractPartyId(value: string): string | null {
  const direct = normalizeGroupId(value);
  if (direct) return direct;
  try {
    const url = new URL(value.trim(), window.location.origin);
    return normalizeGroupId(
      url.searchParams.get("party") ?? url.searchParams.get("syncplay"),
    );
  } catch {
    return null;
  }
}

const noopSubscribe = () => () => undefined;
const nullState = () => null;

export function usePartyWatch(itemId: string): PartyWatch {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const groupId = normalizeGroupId(
    searchParams.get("party") ?? searchParams.get("syncplay"),
  );
  const userId = getCachedSession()?.userId ?? null;

  const [session, setSession] = useState<PartySession | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [errorKey, setErrorKey] = useState<TranslationKey | null>(null);
  /** The create reply, handed to the session so it does not join twice. */
  const createdRef = useRef<PartySnapshot | null>(null);

  useEffect(() => {
    if (!groupId || !userId) {
      setSession(null);
      return undefined;
    }
    const created =
      createdRef.current?.id === groupId ? createdRef.current : undefined;
    createdRef.current = null;
    const acquired = acquirePartySession({
      groupId,
      userId,
      ...(created ? { initialSnapshot: created } : {}),
    });
    setSession(acquired);
    return () => releasePartySession(acquired);
  }, [groupId, userId]);

  const state = useSyncExternalStore(
    session?.subscribe ?? noopSubscribe,
    session?.getState ?? nullState,
  );

  const setPartyParam = useCallback(
    (next: string | null) => {
      setSearchParams(
        (current) => {
          const params = new URLSearchParams(current);
          params.delete("syncplay");
          if (next) params.set("party", next);
          else params.delete("party");
          return params;
        },
        { replace: true, state: location.state },
      );
    },
    [location.state, setSearchParams],
  );

  const create = useCallback(
    async (start?: PartyStart) => {
      if (isCreating) return;
      setIsCreating(true);
      setErrorKey(null);
      try {
        const snapshot = await getPartyTransport().create({
          clientId: partyClientId(),
          itemId,
          ...(start
            ? {
                positionMs: Math.max(0, Math.round(start.positionMs)),
                playing: start.playing,
              }
            : {}),
        });
        partyLog("party.created", { groupId: snapshot.id, itemId });
        createdRef.current = snapshot;
        setPartyParam(snapshot.id);
      } catch {
        setErrorKey("party.createFailed");
      } finally {
        setIsCreating(false);
      }
    },
    [isCreating, itemId, setPartyParam],
  );

  const join = useCallback(
    (input: string) => {
      const target = extractPartyId(input);
      if (!target) {
        setErrorKey("party.invalidLink");
        return false;
      }
      setErrorKey(null);
      setPartyParam(target);
      return true;
    },
    [setPartyParam],
  );

  const leave = useCallback(async () => {
    if (!session) return;
    forgetPartySession(session);
    setPartyParam(null);
    await session.leave();
  }, [session, setPartyParam]);

  const end = useCallback(async () => {
    if (!session) return;
    try {
      await session.end();
      forgetPartySession(session);
      setPartyParam(null);
    } catch {
      setErrorKey("party.endFailed");
    }
  }, [session, setPartyParam]);

  const dismiss = useCallback(() => {
    if (session) forgetPartySession(session);
    setErrorKey(null);
    setPartyParam(null);
  }, [session, setPartyParam]);

  const followItem = useCallback(
    (nextItemId: string) => {
      if (!groupId) return;
      partyLog("party.follow-item", { groupId, itemId: nextItemId });
      navigate(
        `/watch/${encodeURIComponent(nextItemId)}?party=${encodeURIComponent(groupId)}`,
        // Replaced, not pushed: going back must not land on a title the party
        // has left, which would only move this tab forward again.
        { replace: true, state: location.state },
      );
    },
    [groupId, location.state, navigate],
  );

  const inviteUrl = useMemo(() => {
    if (!groupId || typeof window === "undefined") return null;
    const target = state?.snapshot?.itemId ?? itemId;
    return `${window.location.origin}/watch/${encodeURIComponent(target)}?party=${groupId}`;
  }, [groupId, itemId, state?.snapshot?.itemId]);

  return {
    groupId,
    session,
    state: session ? state : null,
    isCreating,
    errorKey,
    inviteUrl,
    create,
    join,
    leave,
    end,
    dismiss,
    followItem,
  };
}
