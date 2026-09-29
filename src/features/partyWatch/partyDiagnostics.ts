/**
 * Party Watch diagnostics.
 *
 * Every lifecycle and recovery event goes into a small in-memory ring, always,
 * so a report of "it got out of sync" can be answered from the tab that saw it:
 * `window.__seyirlikParty()` returns the ring. It reaches the console only in
 * development, or when `localStorage["seyirlik.debug.party"] === "1"`, so
 * production consoles stay quiet. Nothing per-frame is ever logged here.
 */

export interface PartyLogEntry {
  at: string;
  event: string;
  detail?: Record<string, unknown>;
}

const RING_SIZE = 300;
const ring: PartyLogEntry[] = [];

function consoleEnabled(): boolean {
  if (import.meta.env?.DEV) return true;
  try {
    return globalThis.localStorage?.getItem("seyirlik.debug.party") === "1";
  } catch {
    return false;
  }
}

export function partyLog(
  event: string,
  detail?: Record<string, unknown>,
): void {
  const entry: PartyLogEntry = {
    at: new Date().toISOString(),
    event,
    ...(detail ? { detail } : {}),
  };
  ring.push(entry);
  if (ring.length > RING_SIZE) ring.shift();
  if (consoleEnabled() && import.meta.env?.MODE !== "test") {
    console.info(`[Seyirlik Party] ${event}`, detail ?? "");
  }
}

export function partyLogEntries(): PartyLogEntry[] {
  return [...ring];
}

if (typeof window !== "undefined") {
  (
    window as unknown as { __seyirlikParty?: () => PartyLogEntry[] }
  ).__seyirlikParty = partyLogEntries;
}
