import { getAuthSession } from "../../lib/authStorage";
import { buildJellyfinUrl } from "../../lib/jellyfinApi";
import type {
  JellyfinSyncPlaySocketMessage,
  JellyfinSyncPlaySocketStatus,
} from "./partyWatchTypes";

interface JellyfinSyncPlaySocketOptions {
  onMessage: (message: JellyfinSyncPlaySocketMessage) => void;
  onStatus?: (status: JellyfinSyncPlaySocketStatus) => void;
  onError?: (error: Event) => void;
}

export interface JellyfinSyncPlaySocketConnection {
  close: () => void;
}

const RECONNECT_INITIAL_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 30_000;

function buildSocketUrl(): string {
  const session = getAuthSession();

  if (!session?.serverUrl || !session.accessToken) {
    throw new Error("Missing Jellyfin access token. Please sign in again.");
  }

  return buildJellyfinUrl(session.serverUrl, "/socket", {
    ApiKey: session.accessToken,
    deviceId: session.deviceId,
  }).replace(/^http/i, "ws");
}

function parseSocketMessage(
  rawData: unknown,
): JellyfinSyncPlaySocketMessage | null {
  if (typeof rawData !== "string") {
    return null;
  }

  try {
    const parsed = JSON.parse(
      rawData,
    ) as Partial<JellyfinSyncPlaySocketMessage>;

    if (typeof parsed.MessageType !== "string") {
      return null;
    }

    return parsed as JellyfinSyncPlaySocketMessage;
  } catch {
    return null;
  }
}

export function connectJellyfinSyncPlaySocket({
  onMessage,
  onStatus,
  onError,
}: JellyfinSyncPlaySocketOptions): JellyfinSyncPlaySocketConnection {
  let socket: WebSocket | null = null;
  let reconnectTimeout: number | null = null;
  let keepAliveTimeout: number | null = null;
  let reconnectAttempts = 0;
  let isClosed = false;

  const clearTimers = () => {
    if (reconnectTimeout !== null) {
      window.clearTimeout(reconnectTimeout);
      reconnectTimeout = null;
    }

    if (keepAliveTimeout !== null) {
      window.clearTimeout(keepAliveTimeout);
      keepAliveTimeout = null;
    }
  };

  const sendKeepAlive = () => {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ MessageType: "KeepAlive" }));
    }
  };

  const scheduleReconnect = () => {
    if (isClosed) {
      return;
    }

    reconnectAttempts += 1;
    const delay = Math.min(
      RECONNECT_INITIAL_DELAY_MS * 1.5 ** Math.max(0, reconnectAttempts - 1),
      RECONNECT_MAX_DELAY_MS,
    );

    reconnectTimeout = window.setTimeout(connect, delay);
  };

  const connect = () => {
    if (isClosed) {
      return;
    }

    try {
      onStatus?.("connecting");
      socket = new WebSocket(buildSocketUrl());
    } catch (error) {
      onStatus?.("error");
      console.warn(
        "[Seyirlik SyncPlay] Could not create Jellyfin websocket",
        error,
      );
      scheduleReconnect();
      return;
    }

    socket.addEventListener("open", () => {
      reconnectAttempts = 0;
      onStatus?.("connected");
    });

    socket.addEventListener("message", (event) => {
      const message = parseSocketMessage(event.data);

      if (!message) {
        return;
      }

      if (
        message.MessageType === "ForceKeepAlive" &&
        typeof message.Data === "number"
      ) {
        if (keepAliveTimeout !== null) {
          window.clearTimeout(keepAliveTimeout);
        }

        keepAliveTimeout = window.setTimeout(
          sendKeepAlive,
          Math.max(1000, message.Data / 2),
        );
        return;
      }

      onMessage(message);
    });

    socket.addEventListener("error", (event) => {
      onStatus?.("error");
      onError?.(event);
    });

    socket.addEventListener("close", () => {
      if (keepAliveTimeout !== null) {
        window.clearTimeout(keepAliveTimeout);
        keepAliveTimeout = null;
      }

      socket = null;
      onStatus?.("disconnected");
      scheduleReconnect();
    });
  };

  connect();

  return {
    close: () => {
      isClosed = true;
      clearTimers();
      socket?.close();
      socket = null;
      onStatus?.("disconnected");
    },
  };
}
