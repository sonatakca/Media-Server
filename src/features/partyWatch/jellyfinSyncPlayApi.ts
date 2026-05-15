import { getAuthHeaders, getAuthSession } from "../../lib/authStorage";
import { buildJellyfinUrl } from "../../lib/jellyfinApi";
import type {
  JellyfinSyncPlayGroupInfo,
  JellyfinSyncPlayPlayerStatus,
} from "./partyWatchTypes";

type SyncPlayMethod = "GET" | "POST";

interface SyncPlayRequestOptions {
  method?: SyncPlayMethod;
  body?: unknown;
}

interface SetNewQueueOptions {
  itemId: string;
  startPositionTicks?: number;
}

function requireSyncPlaySession() {
  const session = getAuthSession();

  if (!session?.serverUrl || !session.accessToken) {
    throw new Error("Missing Jellyfin access token. Please sign in again.");
  }

  return session;
}

async function parseSyncPlayError(response: Response): Promise<string> {
  const fallback = `Jellyfin SyncPlay request failed with ${response.status} ${response.statusText}.`;

  try {
    const text = await response.text();

    if (!text) {
      return fallback;
    }

    try {
      const json = JSON.parse(text) as {
        message?: string;
        Message?: string;
        error?: string;
      };
      return json.message || json.Message || json.error || text;
    } catch {
      return text;
    }
  } catch {
    return fallback;
  }
}

async function requestSyncPlay<TResponse>(
  path: string,
  { method = "GET", body }: SyncPlayRequestOptions = {},
): Promise<TResponse> {
  const session = requireSyncPlaySession();
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...getAuthHeaders(),
  };

  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(buildJellyfinUrl(session.serverUrl, path), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(await parseSyncPlayError(response));
  }

  if (response.status === 204) {
    return undefined as TResponse;
  }

  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as TResponse;
}

export async function createSyncPlayGroup(
  groupName: string,
): Promise<JellyfinSyncPlayGroupInfo> {
  return requestSyncPlay<JellyfinSyncPlayGroupInfo>("/SyncPlay/New", {
    method: "POST",
    body: {
      GroupName: groupName,
    },
  });
}

export async function joinSyncPlayGroup(groupId: string): Promise<void> {
  await requestSyncPlay<void>("/SyncPlay/Join", {
    method: "POST",
    body: {
      GroupId: groupId,
    },
  });
}

export async function leaveSyncPlayGroup(): Promise<void> {
  await requestSyncPlay<void>("/SyncPlay/Leave", {
    method: "POST",
  });
}

export async function getSyncPlayGroup(
  groupId: string,
): Promise<JellyfinSyncPlayGroupInfo> {
  return requestSyncPlay<JellyfinSyncPlayGroupInfo>(
    `/SyncPlay/${encodeURIComponent(groupId)}`,
  );
}

export async function getSyncPlayGroups(): Promise<
  JellyfinSyncPlayGroupInfo[]
> {
  return requestSyncPlay<JellyfinSyncPlayGroupInfo[]>("/SyncPlay/List");
}

export async function setSyncPlayNewQueue({
  itemId,
  startPositionTicks = 0,
}: SetNewQueueOptions): Promise<void> {
  await requestSyncPlay<void>("/SyncPlay/SetNewQueue", {
    method: "POST",
    body: {
      PlayingQueue: [itemId],
      PlayingItemPosition: 0,
      StartPositionTicks: startPositionTicks,
    },
  });
}

export async function sendSyncPlayPlayCommand(): Promise<void> {
  await requestSyncPlay<void>("/SyncPlay/Unpause", {
    method: "POST",
  });
}

export async function sendSyncPlayPauseCommand(): Promise<void> {
  await requestSyncPlay<void>("/SyncPlay/Pause", {
    method: "POST",
  });
}

export async function sendSyncPlaySeekCommand(
  positionTicks: number,
): Promise<void> {
  await requestSyncPlay<void>("/SyncPlay/Seek", {
    method: "POST",
    body: {
      PositionTicks: positionTicks,
    },
  });
}

export async function sendSyncPlayReadyCommand({
  when = new Date().toISOString(),
  positionTicks,
  isPlaying,
  playlistItemId,
}: JellyfinSyncPlayPlayerStatus): Promise<void> {
  await requestSyncPlay<void>("/SyncPlay/Ready", {
    method: "POST",
    body: {
      When: when,
      PositionTicks: positionTicks,
      IsPlaying: isPlaying,
      PlaylistItemId: playlistItemId,
    },
  });
}

export async function sendSyncPlayBufferingCommand({
  when = new Date().toISOString(),
  positionTicks,
  isPlaying,
  playlistItemId,
}: JellyfinSyncPlayPlayerStatus): Promise<void> {
  await requestSyncPlay<void>("/SyncPlay/Buffering", {
    method: "POST",
    body: {
      When: when,
      PositionTicks: positionTicks,
      IsPlaying: isPlaying,
      PlaylistItemId: playlistItemId,
    },
  });
}

export async function sendSyncPlayPingCommand(pingMs: number): Promise<void> {
  await requestSyncPlay<void>("/SyncPlay/Ping", {
    method: "POST",
    body: {
      Ping: Math.max(0, Math.round(pingMs)),
    },
  });
}
