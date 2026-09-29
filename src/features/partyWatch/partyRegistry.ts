import { randomUuid } from "../../lib/randomId";
import { partyLog } from "./partyDiagnostics";
import { partyTransport, type PartyTransport } from "./partyWatchApi";
import { createPartySession, type PartySession } from "./partySession";
import type { PartySnapshot } from "./partyWatchTypes";

/**
 * Which party sessions this tab holds, and who this tab is.
 *
 * A session outlives the component that asked for it by a short grace. That
 * covers the two ordinary ways a component goes away and comes straight back —
 * React's development double-mount, and the player page re-rendering onto the
 * next episode — without leaving and re-joining, which everyone else would see
 * as "left… joined". A component that is really gone releases its session and,
 * after the grace, the tab leaves the party.
 */

const CLIENT_ID_KEY = "seyirlik.party.client";
/** Long enough to cover a remount, short enough that leaving feels immediate. */
const RELEASE_GRACE_MS = 1_500;

let memoryClientId: string | null = null;

/**
 * This tab's participant id. Kept in session storage, so a reload is the same
 * participant (the server keeps its place during the reconnect) while another
 * tab is a different one.
 */
export function partyClientId(): string {
  try {
    const stored = globalThis.sessionStorage?.getItem(CLIENT_ID_KEY);
    if (stored) return stored;
    const created = randomUuid();
    globalThis.sessionStorage?.setItem(CLIENT_ID_KEY, created);
    return created;
  } catch {
    memoryClientId ??= randomUuid();
    return memoryClientId;
  }
}

export function replacePartyClientId(): string {
  const created = randomUuid();
  try {
    globalThis.sessionStorage?.setItem(CLIENT_ID_KEY, created);
  } catch {
    memoryClientId = created;
  }
  return created;
}

interface Entry {
  session: PartySession;
  holders: number;
  releaseTimer: ReturnType<typeof setTimeout> | null;
}

const entries = new Map<string, Entry>();

let transport: PartyTransport = partyTransport;

/** Tests substitute the network here. */
export function setPartyTransportForTesting(next: PartyTransport | null): void {
  transport = next ?? partyTransport;
  for (const entry of entries.values()) {
    if (entry.releaseTimer) clearTimeout(entry.releaseTimer);
  }
  entries.clear();
}

export function getPartyTransport(): PartyTransport {
  return transport;
}

export function acquirePartySession(input: {
  groupId: string;
  userId: string;
  initialSnapshot?: PartySnapshot;
}): PartySession {
  const existing = entries.get(input.groupId);
  if (existing && existing.session.getState().connection !== "ended") {
    existing.holders += 1;
    if (existing.releaseTimer) {
      clearTimeout(existing.releaseTimer);
      existing.releaseTimer = null;
    }
    return existing.session;
  }

  const session = createPartySession({
    groupId: input.groupId,
    userId: input.userId,
    clientId: partyClientId(),
    transport,
    replaceClientId: replacePartyClientId,
    ...(input.initialSnapshot
      ? { initialSnapshot: input.initialSnapshot }
      : {}),
  });
  entries.set(input.groupId, { session, holders: 1, releaseTimer: null });
  session.start();
  return session;
}

export function releasePartySession(session: PartySession): void {
  const groupId = session.getState().groupId;
  const entry = entries.get(groupId);
  if (!entry || entry.session !== session) return;
  entry.holders = Math.max(0, entry.holders - 1);
  if (entry.holders > 0 || entry.releaseTimer) return;

  entry.releaseTimer = setTimeout(() => {
    if (entries.get(groupId) !== entry || entry.holders > 0) return;
    entries.delete(groupId);
    partyLog("registry.released", { groupId });
    void session.leave();
  }, RELEASE_GRACE_MS);
}

/** Drops a session the tab has explicitly left or that has ended. */
export function forgetPartySession(session: PartySession): void {
  const groupId = session.getState().groupId;
  const entry = entries.get(groupId);
  if (entry?.session !== session) return;
  if (entry.releaseTimer) clearTimeout(entry.releaseTimer);
  entries.delete(groupId);
}
