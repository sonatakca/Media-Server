import {
  OwnApiClientError,
  ownApiClient,
  ownApiUrl,
} from "../../api/ownApi/client";
import type {
  PartyCloseReason,
  PartyCommand,
  PartyParticipantStatus,
  PartySnapshot,
} from "./partyWatchTypes";

/**
 * Party Watch transport: the REST calls and the event stream, and nothing
 * else. Lifecycle, ordering and retries belong to the session; this is the
 * seam tests replace.
 *
 * Every call is a background request: party traffic is not the page loading,
 * and the party UI shows its own progress.
 */

export interface PartyStreamHandlers {
  onOpen(): void;
  onSnapshot(snapshot: PartySnapshot): void;
  onPing(serverTimeMs: number): void;
  onClosed(reason: PartyCloseReason): void;
  onSuperseded(): void;
  /** The connection failed or dropped. The stream is already closed. */
  onError(): void;
}

export interface PartyStream {
  close(): void;
}

export interface PartyCommandResult {
  accepted: boolean;
  snapshot: PartySnapshot;
  lastSequence: number;
}

export interface PartyTransport {
  create(input: {
    clientId: string;
    itemId: string;
    positionMs?: number;
    playing?: boolean;
  }): Promise<PartySnapshot>;
  join(groupId: string, clientId: string): Promise<PartySnapshot>;
  leave(groupId: string, clientId: string): Promise<void>;
  end(groupId: string): Promise<void>;
  command(
    groupId: string,
    body: { clientId: string; sequence: number } & PartyCommand,
    signal?: AbortSignal,
  ): Promise<PartyCommandResult>;
  status(
    groupId: string,
    body: {
      clientId: string;
      status: PartyParticipantStatus;
      revision: number;
      latencyMs?: number;
    },
    signal?: AbortSignal,
  ): Promise<{ serverTimeMs: number }>;
  openStream(
    groupId: string,
    clientId: string,
    handlers: PartyStreamHandlers,
  ): PartyStream;
}

export type PartyFailure =
  /** The server could not be reached at all. */
  | "unreachable"
  | "group-not-found"
  | "participant-not-found"
  | "unauthorized"
  | "forbidden"
  | "transient";

/** What a failed call means for the session, not how it failed. */
export function classifyPartyFailure(error: unknown): PartyFailure {
  if (error instanceof OwnApiClientError) {
    if (error.code === "GROUP_NOT_FOUND") return "group-not-found";
    if (error.code === "PARTICIPANT_NOT_FOUND") return "participant-not-found";
    if (error.status === 401) return "unauthorized";
    if (error.status === 403 || error.code === "ITEM_NOT_FOUND") {
      return "forbidden";
    }
    if (error.code === "NETWORK_ERROR") return "unreachable";
  }
  return "transient";
}

const groupPath = (groupId: string, suffix = "") =>
  `/syncplay/groups/${encodeURIComponent(groupId)}${suffix}`;

function parseFrame<T>(event: Event): T | null {
  try {
    return JSON.parse((event as MessageEvent<string>).data) as T;
  } catch {
    return null;
  }
}

export const partyTransport: PartyTransport = {
  create: (input) =>
    ownApiClient.request<PartySnapshot>("/syncplay/groups", {
      method: "POST",
      body: input,
      background: true,
    }),

  join: (groupId, clientId) =>
    ownApiClient.request<PartySnapshot>(groupPath(groupId, "/join"), {
      method: "POST",
      body: { clientId },
      background: true,
    }),

  leave: async (groupId, clientId) => {
    await ownApiClient.request<void>(groupPath(groupId, "/leave"), {
      method: "POST",
      body: { clientId },
      background: true,
    });
  },

  end: async (groupId) => {
    await ownApiClient.request<void>(groupPath(groupId), {
      method: "DELETE",
      background: true,
    });
  },

  command: (groupId, body, signal) =>
    ownApiClient.request<PartyCommandResult>(groupPath(groupId, "/commands"), {
      method: "POST",
      body,
      background: true,
      ...(signal ? { signal } : {}),
    }),

  status: (groupId, body, signal) =>
    ownApiClient.request<{ serverTimeMs: number }>(
      groupPath(groupId, "/status"),
      {
        method: "POST",
        body,
        background: true,
        ...(signal ? { signal } : {}),
      },
    ),

  openStream: (groupId, clientId, handlers) => {
    const source = new EventSource(
      ownApiUrl(
        `/ownAPI/v1${groupPath(groupId, "/events")}?clientId=${encodeURIComponent(clientId)}`,
      ),
      { withCredentials: true },
    );
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      source.close();
    };

    source.addEventListener("open", () => handlers.onOpen());
    source.addEventListener("snapshot", (event) => {
      const snapshot = parseFrame<PartySnapshot>(event);
      // A malformed frame is dropped; the next one is the whole state again.
      if (snapshot && !closed) handlers.onSnapshot(snapshot);
    });
    source.addEventListener("ping", (event) => {
      const ping = parseFrame<{ serverTimeMs: number }>(event);
      if (ping && !closed) handlers.onPing(ping.serverTimeMs);
    });
    source.addEventListener("closed", (event) => {
      const frame = parseFrame<{ reason: PartyCloseReason }>(event);
      close();
      handlers.onClosed(frame?.reason ?? "ended");
    });
    source.addEventListener("superseded", () => {
      close();
      handlers.onSuperseded();
    });
    source.addEventListener("error", () => {
      if (closed) return;
      // EventSource would retry by itself, blindly, against a participant
      // that may no longer exist. The session reconnects deliberately instead:
      // re-join, then re-open.
      close();
      handlers.onError();
    });

    return { close };
  },
};
