import { ownApiClient } from "../../api/ownApi/client";

/**
 * Native Party Watch client.
 *
 * Commands go over the ordinary authenticated REST surface; authoritative state
 * arrives on a server-sent event stream. There is no separate socket token: the
 * session cookie authorizes both, so a group id can never be replayed by
 * someone who is not a member.
 */

export interface PartyWatchMember {
  userId: string;
  displayName: string;
  isReady: boolean;
  isBuffering: boolean;
  positionMs: number;
}

export interface PartyWatchGroup {
  id: string;
  name: string;
  ownerUserId: string;
  itemId: string | null;
  sequence: number;
  isPlaying: boolean;
  positionMs: number;
  /** Server anchor, for clients that trust their own clock. */
  anchor: { positionMs: number; serverTimeMs: number };
  serverTimeMs: number;
  isWaiting: boolean;
  waitingFor: string[];
  members: PartyWatchMember[];
}

export interface PartyWatchGroupSummary {
  id: string;
  name: string;
  itemId: string | null;
  memberCount: number;
  isPlaying: boolean;
}

export async function listPartyWatchGroups(): Promise<PartyWatchGroupSummary[]> {
  return ownApiClient.request<PartyWatchGroupSummary[]>("/syncplay/groups");
}

export async function createPartyWatchGroup(input: {
  name?: string;
  itemId?: string;
}): Promise<PartyWatchGroup> {
  return ownApiClient.request<PartyWatchGroup>("/syncplay/groups", {
    method: "POST",
    body: {
      ...(input.name ? { name: input.name } : {}),
      ...(input.itemId ? { itemId: input.itemId } : {}),
    },
  });
}

export async function getPartyWatchGroup(
  groupId: string,
): Promise<PartyWatchGroup> {
  return ownApiClient.request<PartyWatchGroup>(
    `/syncplay/groups/${encodeURIComponent(groupId)}`,
  );
}

export async function joinPartyWatchGroup(
  groupId: string,
): Promise<PartyWatchGroup> {
  return ownApiClient.request<PartyWatchGroup>(
    `/syncplay/groups/${encodeURIComponent(groupId)}/join`,
    { method: "POST", body: {} },
  );
}

export async function leavePartyWatchGroup(groupId: string): Promise<void> {
  await ownApiClient.request<void>(
    `/syncplay/groups/${encodeURIComponent(groupId)}/leave`,
    { method: "POST", body: {} },
  );
}

export async function closePartyWatchGroup(groupId: string): Promise<void> {
  await ownApiClient.request<void>(
    `/syncplay/groups/${encodeURIComponent(groupId)}`,
    { method: "DELETE" },
  );
}

/**
 * Command sequences are per-client and monotonic. The server keeps the highest
 * one it has applied and rejects anything at or below it, so a command delayed
 * in flight cannot rewind the group.
 */
let commandSequence = Date.now();

function nextSequence(): number {
  commandSequence += 1;
  return commandSequence;
}

/** Raises the local counter past a sequence the server has already applied. */
export function observeServerSequence(sequence: number): void {
  if (sequence >= commandSequence) commandSequence = sequence;
}

async function sendCommand(
  groupId: string,
  command: "play" | "pause" | "seek",
  positionMs?: number,
): Promise<PartyWatchGroup | null> {
  try {
    return await ownApiClient.request<PartyWatchGroup>(
      `/syncplay/groups/${encodeURIComponent(groupId)}/${command}`,
      {
        method: "POST",
        body: {
          sequence: nextSequence(),
          ...(positionMs === undefined
            ? {}
            : { positionMs: Math.max(0, Math.round(positionMs)) }),
        },
      },
    );
  } catch (error) {
    // Losing a race is an expected outcome when two people press play at once,
    // not an error the overlay should show.
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "COMMAND_STALE"
    ) {
      return null;
    }
    throw error;
  }
}

export function sendPartyWatchPlay(
  groupId: string,
  positionMs?: number,
): Promise<PartyWatchGroup | null> {
  return sendCommand(groupId, "play", positionMs);
}

export function sendPartyWatchPause(
  groupId: string,
  positionMs: number,
): Promise<PartyWatchGroup | null> {
  return sendCommand(groupId, "pause", positionMs);
}

export function sendPartyWatchSeek(
  groupId: string,
  positionMs: number,
): Promise<PartyWatchGroup | null> {
  return sendCommand(groupId, "seek", positionMs);
}

export async function reportPartyWatchStatus(
  groupId: string,
  status: { isReady?: boolean; isBuffering?: boolean; positionMs?: number },
): Promise<void> {
  await ownApiClient.request<void>(
    `/syncplay/groups/${encodeURIComponent(groupId)}/report`,
    {
      method: "POST",
      body: {
        ...(status.isReady === undefined ? {} : { isReady: status.isReady }),
        ...(status.isBuffering === undefined
          ? {}
          : { isBuffering: status.isBuffering }),
        ...(status.positionMs === undefined
          ? {}
          : { positionMs: Math.max(0, Math.round(status.positionMs)) }),
      },
    },
  );
}

export type PartyWatchStreamStatus =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "closed";

export interface PartyWatchStreamHandlers {
  onState(group: PartyWatchGroup): void;
  onClosed(): void;
  onStatusChange?(status: PartyWatchStreamStatus): void;
}

export interface PartyWatchStream {
  close(): void;
}

/**
 * Subscribes to authoritative group state.
 *
 * `EventSource` reconnects on its own, which is the behaviour we want: every
 * message carries the complete state, so a reconnected client is immediately
 * correct without replaying anything it missed.
 */
export function connectPartyWatchStream(
  groupId: string,
  handlers: PartyWatchStreamHandlers,
): PartyWatchStream {
  const source = new EventSource(
    `/ownAPI/v1/syncplay/groups/${encodeURIComponent(groupId)}/events`,
    { withCredentials: true },
  );

  handlers.onStatusChange?.("connecting");

  source.addEventListener("open", () => {
    handlers.onStatusChange?.("connected");
  });

  source.addEventListener("state", (message) => {
    try {
      const group = JSON.parse((message as MessageEvent<string>).data) as
        PartyWatchGroup;
      observeServerSequence(group.sequence);
      handlers.onState(group);
    } catch {
      // A malformed frame is dropped; the next state message is authoritative.
    }
  });

  source.addEventListener("closed", () => {
    handlers.onClosed();
    source.close();
    handlers.onStatusChange?.("closed");
  });

  source.addEventListener("error", () => {
    handlers.onStatusChange?.(
      source.readyState === EventSource.CLOSED ? "closed" : "reconnecting",
    );
  });

  return {
    close: () => {
      source.close();
      handlers.onStatusChange?.("closed");
    },
  };
}
