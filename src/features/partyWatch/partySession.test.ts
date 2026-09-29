import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OwnApiClientError } from "../../api/ownApi/client";
import type {
  PartyCommandResult,
  PartyStreamHandlers,
  PartyTransport,
} from "./partyWatchApi";
import { createPartySession, PARTY_SESSION_TUNING } from "./partySession";
import type { PartyCommand, PartySnapshot } from "./partyWatchTypes";

const GROUP = "aaaaaaaa-0000-4000-8000-000000000001";
const USER = "user-1";

function snapshot(overrides: Partial<PartySnapshot> = {}): PartySnapshot {
  return {
    id: GROUP,
    name: "Party",
    ownerUserId: USER,
    itemId: "item-1",
    epoch: "epoch-1",
    version: 1,
    revision: 1,
    intent: "paused",
    positionMs: 0,
    anchorMs: Date.now(),
    serverTimeMs: Date.now(),
    hold: null,
    participants: [],
    cause: null,
    ...overrides,
  };
}

function apiError(status: number, code: string) {
  return new OwnApiClientError({ status, code, message: code });
}

/** A server the test scripts one call at a time. */
function fakeTransport() {
  const streams: Array<{
    clientId: string;
    handlers: PartyStreamHandlers;
    closed: boolean;
  }> = [];
  const calls: Array<{ kind: string; body?: unknown; clientId?: string }> = [];
  let joinResult: () => Promise<PartySnapshot> = async () => snapshot();
  let commandResult: (
    body: { sequence: number } & PartyCommand,
  ) => Promise<PartyCommandResult> = async (body) => ({
    accepted: true,
    snapshot: snapshot({ version: 99, revision: 9 }),
    lastSequence: body.sequence,
  });
  let statusResult: () => Promise<{ serverTimeMs: number }> = async () => ({
    serverTimeMs: Date.now(),
  });

  const transport: PartyTransport = {
    create: vi.fn(),
    join: async (_groupId, clientId) => {
      calls.push({ kind: "join", clientId });
      return joinResult();
    },
    leave: async (_groupId, clientId) => {
      calls.push({ kind: "leave", clientId });
    },
    end: async () => {
      calls.push({ kind: "end" });
    },
    command: async (_groupId, body) => {
      calls.push({ kind: "command", body });
      return commandResult(body);
    },
    status: async (_groupId, body) => {
      calls.push({ kind: "status", body });
      return statusResult();
    },
    openStream: (_groupId, clientId, handlers) => {
      const stream = { clientId, handlers, closed: false };
      streams.push(stream);
      return {
        close: () => {
          stream.closed = true;
        },
      };
    },
  };

  return {
    transport,
    streams,
    calls,
    latestStream: () => streams[streams.length - 1]!,
    count: (kind: string) => calls.filter((call) => call.kind === kind).length,
    onJoin: (next: typeof joinResult) => {
      joinResult = next;
    },
    onCommand: (next: typeof commandResult) => {
      commandResult = next;
    },
    onStatus: (next: typeof statusResult) => {
      statusResult = next;
    },
  };
}

function start(
  server = fakeTransport(),
  options: { initial?: PartySnapshot } = {},
) {
  let replacements = 0;
  const session = createPartySession({
    groupId: GROUP,
    userId: USER,
    clientId: "client-1",
    transport: server.transport,
    replaceClientId: () => `client-replacement-${(replacements += 1)}`,
    random: () => 0.5,
    ...(options.initial ? { initialSnapshot: options.initial } : {}),
  });
  session.start();
  return { session, server };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("joining", () => {
  it("joins, opens the stream, and is live once the stream speaks", async () => {
    const { session, server } = start();
    expect(session.getState().connection).toBe("joining");

    await vi.advanceTimersByTimeAsync(0);
    expect(server.count("join")).toBe(1);
    expect(server.streams).toHaveLength(1);
    // The server re-registered this client as loading; it is told the truth.
    expect(server.count("status")).toBe(1);

    server.latestStream().handlers.onSnapshot(snapshot({ version: 2 }));
    expect(session.getState().connection).toBe("live");
  });

  it("starts from the create reply without joining twice", async () => {
    const { server } = start(fakeTransport(), { initial: snapshot() });
    await vi.advanceTimersByTimeAsync(0);
    expect(server.count("join")).toBe(0);
    expect(server.streams).toHaveLength(1);
  });

  it("ends plainly when the party does not exist", async () => {
    const server = fakeTransport();
    server.onJoin(async () => {
      throw apiError(404, "GROUP_NOT_FOUND");
    });
    const { session } = start(server);
    await vi.advanceTimersByTimeAsync(0);
    expect(session.getState().connection).toBe("ended");
    expect(session.getState().endReason).toBe("not-found");
  });

  it("keeps trying to join through a server that is briefly down", async () => {
    const server = fakeTransport();
    let failures = 2;
    server.onJoin(async () => {
      if (failures > 0) {
        failures -= 1;
        throw apiError(0, "NETWORK_ERROR");
      }
      return snapshot();
    });
    const { session } = start(server);
    await vi.advanceTimersByTimeAsync(0);
    expect(session.getState().connection).toBe("joining");

    await vi.advanceTimersByTimeAsync(PARTY_SESSION_TUNING.reconnectMaxMs * 2);
    expect(server.count("join")).toBe(3);
    server.latestStream().handlers.onSnapshot(snapshot({ version: 2 }));
    expect(session.getState().connection).toBe("live");
  });
});

describe("ordering what the server says", () => {
  it("never goes back to an older version", async () => {
    const { session, server } = start();
    await vi.advanceTimersByTimeAsync(0);
    const stream = server.latestStream().handlers;

    stream.onSnapshot(snapshot({ version: 5, positionMs: 5_000 }));
    stream.onSnapshot(snapshot({ version: 4, positionMs: 4_000 }));
    expect(session.getState().snapshot?.positionMs).toBe(5_000);
  });

  it("accepts a restarted server's fresh numbering, and never the old one again", async () => {
    const { session, server } = start();
    await vi.advanceTimersByTimeAsync(0);
    const stream = server.latestStream().handlers;

    stream.onSnapshot(snapshot({ epoch: "epoch-1", version: 40 }));
    stream.onSnapshot(
      snapshot({ epoch: "epoch-2", version: 1, positionMs: 7 }),
    );
    expect(session.getState().snapshot?.positionMs).toBe(7);

    stream.onSnapshot(snapshot({ epoch: "epoch-1", version: 41 }));
    expect(session.getState().snapshot?.epoch).toBe("epoch-2");
  });

  it("raises a notice for what someone else did, not for this tab or a catch-up", async () => {
    const { session, server } = start();
    await vi.advanceTimersByTimeAsync(0);
    const stream = server.latestStream().handlers;
    const other = { participantId: "user-2:c", displayName: "Deniz" };

    // The first frame on a stream is the state to catch up with, not news.
    stream.onSnapshot(
      snapshot({ version: 2, cause: { kind: "pause", ...other } }),
    );
    expect(session.getState().notice).toBeNull();

    stream.onSnapshot(
      snapshot({
        version: 3,
        cause: {
          kind: "play",
          participantId: `${USER}:client-1`,
          displayName: "Me",
        },
      }),
    );
    expect(session.getState().notice).toBeNull();

    stream.onSnapshot(
      snapshot({ version: 4, cause: { kind: "seek", ...other } }),
    );
    expect(session.getState().notice?.cause.kind).toBe("seek");
  });
});

describe("staying connected", () => {
  it("reconnects through join-then-stream when the stream fails", async () => {
    const { session, server } = start();
    await vi.advanceTimersByTimeAsync(0);
    server.latestStream().handlers.onSnapshot(snapshot({ version: 2 }));

    server.latestStream().handlers.onError();
    expect(session.getState().connection).toBe("reconnecting");
    expect(server.streams[0]!.closed).toBe(true);

    await vi.advanceTimersByTimeAsync(
      PARTY_SESSION_TUNING.reconnectInitialMs * 2,
    );
    expect(server.count("join")).toBe(2);
    server.latestStream().handlers.onSnapshot(snapshot({ version: 3 }));
    expect(session.getState().connection).toBe("live");
  });

  it("treats a stream that has gone quiet as dead", async () => {
    const { session, server } = start();
    await vi.advanceTimersByTimeAsync(0);
    server.latestStream().handlers.onSnapshot(snapshot({ version: 2 }));

    // Pings keep it alive…
    for (let i = 0; i < 5; i += 1) {
      await vi.advanceTimersByTimeAsync(15_000);
      server.latestStream().handlers.onPing(Date.now());
    }
    expect(server.count("join")).toBe(1);

    // …silence does not.
    await vi.advanceTimersByTimeAsync(
      PARTY_SESSION_TUNING.streamSilenceLimitMs +
        PARTY_SESSION_TUNING.watchdogIntervalMs +
        1_000,
    );
    expect(server.count("join")).toBe(2);
    expect(session.getState().connection).not.toBe("ended");
  });

  it("recovers at once when a request cannot reach the server", async () => {
    const { session, server } = start();
    await vi.advanceTimersByTimeAsync(0);
    server.latestStream().handlers.onSnapshot(snapshot({ version: 2 }));
    server.onStatus(async () => {
      throw apiError(0, "NETWORK_ERROR");
    });

    session.setStatus("ready", 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(session.getState().connection).toBe("reconnecting");
  });

  it("rejoins when the server has forgotten this client", async () => {
    const { server, session } = start();
    await vi.advanceTimersByTimeAsync(0);
    server.latestStream().handlers.onSnapshot(snapshot({ version: 2 }));
    server.onStatus(async () => {
      throw apiError(404, "PARTICIPANT_NOT_FOUND");
    });

    session.setStatus("ready", 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(server.count("join")).toBe(2);
  });

  it("steps aside under a new id when another tab takes this one's", async () => {
    const { session, server } = start();
    await vi.advanceTimersByTimeAsync(0);
    server.latestStream().handlers.onSnapshot(snapshot({ version: 2 }));

    server.latestStream().handlers.onSuperseded();
    await vi.advanceTimersByTimeAsync(0);
    expect(session.getState().clientId).toBe("client-replacement-1");
    expect(server.calls.filter((c) => c.kind === "join").pop()?.clientId).toBe(
      "client-replacement-1",
    );
  });

  it("sends a keepalive while live, and nothing while reconnecting", async () => {
    const { server } = start();
    await vi.advanceTimersByTimeAsync(0);
    server.latestStream().handlers.onSnapshot(snapshot({ version: 2 }));
    const before = server.count("status");

    await vi.advanceTimersByTimeAsync(
      PARTY_SESSION_TUNING.keepaliveIntervalMs * 3,
    );
    expect(server.count("status") - before).toBe(3);

    server.onJoin(() => new Promise(() => undefined));
    server.latestStream().handlers.onError();
    const during = server.count("status");
    await vi.advanceTimersByTimeAsync(
      PARTY_SESSION_TUNING.keepaliveIntervalMs * 3,
    );
    expect(server.count("status")).toBe(during);
  });

  it("only reports readiness when it changes", async () => {
    const { session, server } = start();
    await vi.advanceTimersByTimeAsync(0);
    const before = server.count("status");
    session.setStatus("ready", 3);
    session.setStatus("ready", 3);
    await vi.advanceTimersByTimeAsync(0);
    expect(server.count("status") - before).toBe(1);
  });
});

describe("commands", () => {
  it("counts a command as pending until the group answers", async () => {
    const server = fakeTransport();
    let answer!: (result: PartyCommandResult) => void;
    server.onCommand(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    const { session } = start(server);
    await vi.advanceTimersByTimeAsync(0);

    const outcome = session.command({ type: "play" });
    expect(session.getState().pendingCommands).toBe(1);
    answer({
      accepted: true,
      snapshot: snapshot({ version: 5 }),
      lastSequence: 1,
    });
    await expect(outcome).resolves.toBe("applied");
    expect(session.getState().pendingCommands).toBe(0);
    expect(session.getState().snapshot?.version).toBe(5);
  });

  it("resends its latest command once if a reloaded tab's numbering was behind", async () => {
    const server = fakeTransport();
    let attempts = 0;
    server.onCommand(async (body) => {
      attempts += 1;
      return attempts === 1
        ? {
            accepted: false,
            snapshot: snapshot({ version: 2 }),
            lastSequence: body.sequence + 1_000,
          }
        : {
            accepted: true,
            snapshot: snapshot({ version: 3 }),
            lastSequence: body.sequence,
          };
    });
    const { session } = start(server);
    await vi.advanceTimersByTimeAsync(0);

    await expect(session.command({ type: "pause" })).resolves.toBe("applied");
    const sequences = server.calls
      .filter((c) => c.kind === "command")
      .map((c) => (c.body as { sequence: number }).sequence);
    expect(sequences[1]).toBeGreaterThan(sequences[0]! + 1_000);
  });

  it("does not resend a command that a newer one of its own overtook", async () => {
    const server = fakeTransport();
    const pending: Array<(r: PartyCommandResult) => void> = [];
    server.onCommand(() => new Promise((resolve) => pending.push(resolve)));
    const { session } = start(server);
    await vi.advanceTimersByTimeAsync(0);

    const first = session.command({ type: "pause" });
    const second = session.command({ type: "play" });
    // The server saw the second first and rejects the first as stale.
    pending[1]!({
      accepted: true,
      snapshot: snapshot({ version: 3 }),
      lastSequence: 99,
    });
    pending[0]!({
      accepted: false,
      snapshot: snapshot({ version: 3 }),
      lastSequence: 99,
    });

    await expect(first).resolves.toBe("ignored");
    await expect(second).resolves.toBe("applied");
    expect(server.count("command")).toBe(2);
  });

  it("reports a command that could not reach the group", async () => {
    const server = fakeTransport();
    server.onCommand(async () => {
      throw apiError(0, "NETWORK_ERROR");
    });
    const { session } = start(server);
    await vi.advanceTimersByTimeAsync(0);

    await expect(session.command({ type: "play" })).resolves.toBe("failed");
    expect(session.getState().commandFailed).toBe(true);
    expect(session.getState().pendingCommands).toBe(0);
  });

  it("does not end the party because one title was refused", async () => {
    const server = fakeTransport();
    server.onCommand(async () => {
      throw apiError(404, "ITEM_NOT_FOUND");
    });
    const { session } = start(server);
    await vi.advanceTimersByTimeAsync(0);

    await session.command({
      type: "setItem",
      itemId: "x",
      fromItemId: "item-1",
    });
    expect(session.getState().connection).not.toBe("ended");
  });
});

describe("leaving", () => {
  it("leaves once and goes quiet", async () => {
    const { session, server } = start();
    await vi.advanceTimersByTimeAsync(0);
    await session.leave();
    expect(session.getState().endReason).toBe("left");
    expect(server.count("leave")).toBe(1);
    expect(server.latestStream().closed).toBe(true);

    const calls = server.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(server.calls.length).toBe(calls);
    await session.leave();
    expect(server.count("leave")).toBe(1);
  });

  it("ends when the group is ended from elsewhere, and rejoins when only expired", async () => {
    const { session, server } = start();
    await vi.advanceTimersByTimeAsync(0);
    server.latestStream().handlers.onSnapshot(snapshot({ version: 2 }));

    server.latestStream().handlers.onClosed("expired");
    await vi.advanceTimersByTimeAsync(0);
    expect(server.count("join")).toBe(2);

    server.latestStream().handlers.onSnapshot(snapshot({ version: 3 }));
    server.latestStream().handlers.onClosed("ended");
    expect(session.getState().endReason).toBe("ended");
  });
});
