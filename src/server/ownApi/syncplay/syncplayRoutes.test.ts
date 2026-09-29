// @vitest-environment node
import { createHmac, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createOwnApiRouter, type RoutePrincipal } from "../api/router";
import { createCsrfToken } from "../auth/csrf";
import {
  createOwnApiRequestHandler,
  createStaticHealthService,
} from "../ownApiHandler";
import { createMemorySyncplayRepository } from "./memorySyncplayRepository";
import { createSyncplayRoutes } from "./syncplayRoutes";
import {
  createSyncplayRuntime,
  type SyncplayRuntime,
  type SyncplaySnapshot,
} from "./syncplayRuntime";

/**
 * Party Watch over real HTTP: the router, CSRF, the runtime and actual
 * server-sent event streams read by several clients at once. The state machine
 * has its own tests; these are about what a client on the wire sees.
 */

const CSRF_SECRET = "s".repeat(32);
const ORIGIN = "https://seyirlik.test";
const FILM = "aaaaaaaa-0000-4000-8000-000000000001";
const SECRET_FILM = "aaaaaaaa-0000-4000-8000-00000000dead";
const NEXT_FILM = "aaaaaaaa-0000-4000-8000-000000000002";

const USERS = {
  ada: { userId: "11111111-0000-4000-8000-000000000001", displayName: "Ada" },
  bora: { userId: "11111111-0000-4000-8000-000000000002", displayName: "Bora" },
  cem: { userId: "11111111-0000-4000-8000-000000000003", displayName: "Cem" },
};
type UserName = keyof typeof USERS;

const servers: Server[] = [];
const runtimes: SyncplayRuntime[] = [];
const streams: AbortController[] = [];

afterEach(async () => {
  for (const controller of streams.splice(0)) controller.abort();
  for (const runtime of runtimes.splice(0)) runtime.stop();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

function sessionHash(user: UserName): Buffer {
  return createHmac("sha256", "k").update(user).digest();
}

async function startServer(
  repository = createMemorySyncplayRepository(),
  now?: () => number,
) {
  const runtime = createSyncplayRuntime({
    repository,
    ...(now ? { now } : {}),
  });
  runtimes.push(runtime);
  const router = createOwnApiRouter({
    csrfSecret: CSRF_SECRET,
    csrfCookieName: "seyirlik_csrf",
    publicOrigin: ORIGIN,
    resolveSession: async (request): Promise<RoutePrincipal | null> => {
      const name = request.headers["x-test-user"] as UserName | undefined;
      if (!name || !USERS[name]) return null;
      return {
        ...USERS[name],
        username: name,
        isAdministrator: false,
        sessionId: `session-${name}`,
        sessionTokenHash: sessionHash(name),
      };
    },
    routes: createSyncplayRoutes({
      runtime,
      catalogue: {
        canUserAccessItem: async (_userId, itemId) => itemId !== SECRET_FILM,
      },
      heartbeatIntervalMs: 200,
    }),
  });
  const handler = createOwnApiRequestHandler({
    healthService: createStaticHealthService({
      database: "available",
      jobs: "available",
      ffmpeg: "available",
      ffprobe: "available",
      mediaStorage: "available",
      generatedStorage: "writable",
    }),
    routeHandlers: [router.handler],
  });
  const server = createServer((request, response) => {
    void handler(request, response).then((handled) => {
      if (!handled) {
        response.statusCode = 404;
        response.end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/ownAPI/v1`;
  return { base, runtime, repository };
}

/** One browser tab: a user, a client id, and its own command sequence. */
function client(base: string, user: UserName, clientId = randomUUID()) {
  let sequence = 0;

  async function call(method: string, path: string, body?: unknown) {
    const csrf = createCsrfToken(sessionHash(user), CSRF_SECRET);
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        "x-test-user": user,
        origin: ORIGIN,
        cookie: `seyirlik_csrf=${csrf}`,
        "x-csrf-token": csrf,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return {
      status: response.status,
      json: text ? (JSON.parse(text) as Record<string, any>) : null,
    };
  }

  return {
    user,
    clientId,
    id: `${USERS[user].userId}:${clientId}`,
    call,
    create: (itemId = FILM) =>
      call("POST", "/syncplay/groups", { clientId, itemId }),
    join: (groupId: string) =>
      call("POST", `/syncplay/groups/${groupId}/join`, { clientId }),
    leave: (groupId: string) =>
      call("POST", `/syncplay/groups/${groupId}/leave`, { clientId }),
    command: (
      groupId: string,
      command: Record<string, unknown>,
      seq?: number,
    ) =>
      call("POST", `/syncplay/groups/${groupId}/commands`, {
        clientId,
        sequence: seq ?? (sequence += 1),
        ...command,
      }),
    status: (groupId: string, status: string, revision: number) =>
      call("POST", `/syncplay/groups/${groupId}/status`, {
        clientId,
        status,
        revision,
      }),
    stream: (groupId: string) => openStream(base, user, groupId, clientId),
  };
}

interface StreamEvent {
  event: string;
  data: any;
}

/** A minimal EventSource: parses frames and lets a test wait for one. */
async function openStream(
  base: string,
  user: UserName,
  groupId: string,
  clientId: string,
) {
  const controller = new AbortController();
  streams.push(controller);
  const response = await fetch(
    `${base}/syncplay/groups/${groupId}/events?clientId=${clientId}`,
    { headers: { "x-test-user": user }, signal: controller.signal },
  );
  const events: StreamEvent[] = [];
  const waiters: Array<() => void> = [];
  let ended = false;

  if (response.ok && response.body) {
    void (async () => {
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let boundary = buffer.indexOf("\n\n");
          while (boundary >= 0) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            boundary = buffer.indexOf("\n\n");
            const event = /^event: (.+)$/m.exec(frame)?.[1];
            const data = /^data: (.+)$/m.exec(frame)?.[1];
            if (event && data) {
              events.push({ event, data: JSON.parse(data) });
              for (const wake of waiters.splice(0)) wake();
            }
          }
        }
      } catch {
        // Aborted.
      }
      ended = true;
      for (const wake of waiters.splice(0)) wake();
    })();
  }

  return {
    status: response.status,
    events,
    get ended() {
      return ended;
    },
    close: () => controller.abort(),
    /** Resolves with the first event (from now on, or already seen) matching. */
    async next(
      predicate: (event: StreamEvent) => boolean,
      timeoutMs = 2_000,
    ): Promise<StreamEvent> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = events.find(predicate);
        if (found) return found;
        if (ended || Date.now() > deadline) {
          throw new Error(
            `No matching event; saw ${events.map((e) => e.event).join(", ")}`,
          );
        }
        await new Promise<void>((resolve) => {
          waiters.push(resolve);
          setTimeout(resolve, 50);
        });
      }
    },
    latestSnapshot(): SyncplaySnapshot {
      const snapshots = events.filter((e) => e.event === "snapshot");
      return snapshots[snapshots.length - 1]!.data as SyncplaySnapshot;
    },
  };
}

describe("Party Watch over HTTP", () => {
  it("brings a second person into the group and keeps both streams current", async () => {
    const { base } = await startServer();
    const ada = client(base, "ada");
    const bora = client(base, "bora");

    const created = await ada.create();
    expect(created.status).toBe(201);
    const groupId = created.json!.data.id as string;
    const adaStream = await ada.stream(groupId);
    expect(adaStream.status).toBe(200);

    const joined = await bora.join(groupId);
    expect(joined.status).toBe(200);
    expect(
      joined.json!.data.participants.map(
        (p: { displayName: string }) => p.displayName,
      ),
    ).toEqual(["Ada", "Bora"]);
    const boraStream = await bora.stream(groupId);

    // Ada hears about Bora, and later about Bora's stream opening.
    await adaStream.next(
      (e) =>
        e.event === "snapshot" &&
        e.data.participants.some(
          (p: { id: string; presence: string }) =>
            p.id === bora.id && p.presence === "connected",
        ),
    );

    // Both ready, Bora presses play: both streams carry the same start.
    await ada.status(groupId, "ready", 0);
    await bora.status(groupId, "ready", 0);
    const played = await bora.command(groupId, { type: "play" });
    expect(played.json!.data.accepted).toBe(true);
    const revision = played.json!.data.snapshot.revision as number;

    const seenByAda = await adaStream.next(
      (e) => e.event === "snapshot" && e.data.revision === revision,
    );
    const seenByBora = await boraStream.next(
      (e) => e.event === "snapshot" && e.data.revision === revision,
    );
    expect(seenByAda.data.intent).toBe("playing");
    expect(seenByAda.data.anchorMs).toBe(seenByBora.data.anchorMs);
    expect(seenByAda.data.cause).toMatchObject({
      kind: "play",
      participantId: bora.id,
    });
  });

  it("starts a party from where its creator already is", async () => {
    const { base } = await startServer();
    const ada = client(base, "ada");
    const created = await ada.call("POST", "/syncplay/groups", {
      clientId: ada.clientId,
      itemId: FILM,
      positionMs: 754_000,
      playing: true,
    });
    const snapshot = created.json!.data as SyncplaySnapshot;
    expect(snapshot.intent).toBe("playing");
    expect(snapshot.hold).toBeNull();
    expect(
      snapshot.positionMs + (snapshot.serverTimeMs - snapshot.anchorMs),
    ).toBeGreaterThanOrEqual(754_000);
  });

  it("tells a client that was overtaken in flight that its command did nothing", async () => {
    const { base } = await startServer();
    const ada = client(base, "ada");
    const groupId = (await ada.create()).json!.data.id as string;

    await ada.command(groupId, { type: "seek", positionMs: 5_000 }, 2);
    const late = await ada.command(
      groupId,
      { type: "seek", positionMs: 9_000 },
      1,
    );
    expect(late.status).toBe(200);
    expect(late.json!.data.accepted).toBe(false);
    expect(late.json!.data.snapshot.positionMs).toBe(5_000);
    expect(late.json!.data.lastSequence).toBe(2);
  });

  it("refuses a stream or a command from a client that has not joined", async () => {
    const { base } = await startServer();
    const ada = client(base, "ada");
    const bora = client(base, "bora");
    const groupId = (await ada.create()).json!.data.id as string;

    const stream = await bora.stream(groupId);
    expect(stream.status).toBe(404);
    const command = await bora.command(groupId, { type: "play" });
    expect(command.status).toBe(404);
    expect(command.json!.error.code).toBe("PARTICIPANT_NOT_FOUND");
  });

  it("hides a group watching something the joiner may not see", async () => {
    const { base, runtime } = await startServer();
    // Created directly: a user cannot create one for a title they cannot see.
    const snapshot = await runtime.create({
      principal: USERS.cem,
      clientId: randomUUID(),
      itemId: SECRET_FILM,
    });
    const joined = await client(base, "bora").join(snapshot.id);
    expect(joined.status).toBe(404);
    expect(joined.json!.error.code).toBe("GROUP_NOT_FOUND");
  });

  it("hands a client's place to its newest connection", async () => {
    const { base } = await startServer();
    const ada = client(base, "ada");
    const groupId = (await ada.create()).json!.data.id as string;

    const first = await ada.stream(groupId);
    await first.next((e) => e.event === "snapshot");
    const second = await ada.stream(groupId);
    await second.next((e) => e.event === "snapshot");

    await first.next((e) => e.event === "superseded");
    expect(second.ended).toBe(false);
  });

  it("carries a ping so an idle client can tell the stream is alive", async () => {
    const { base } = await startServer();
    const ada = client(base, "ada");
    const groupId = (await ada.create()).json!.data.id as string;
    const stream = await ada.stream(groupId);

    const ping = await stream.next((e) => e.event === "ping");
    expect(typeof ping.data.serverTimeMs).toBe("number");
  });

  it("closes the group when its last participant leaves", async () => {
    const { base } = await startServer();
    const ada = client(base, "ada");
    const bora = client(base, "bora");
    const groupId = (await ada.create()).json!.data.id as string;
    await bora.join(groupId);
    const boraStream = await bora.stream(groupId);

    expect((await ada.leave(groupId)).status).toBe(204);
    const afterAdaLeft = await boraStream.next(
      (e) => e.event === "snapshot" && e.data.participants.length === 1,
    );
    expect(afterAdaLeft.data.cause).toMatchObject({
      kind: "left",
      participantId: ada.id,
    });

    await bora.leave(groupId);
    expect((await client(base, "cem").join(groupId)).status).toBe(404);
  });

  it("lets only the person who started the party end it for everyone", async () => {
    const { base } = await startServer();
    const ada = client(base, "ada");
    const bora = client(base, "bora");
    const groupId = (await ada.create()).json!.data.id as string;
    await bora.join(groupId);
    const boraStream = await bora.stream(groupId);

    expect(
      (await bora.call("DELETE", `/syncplay/groups/${groupId}`)).status,
    ).toBe(403);
    expect(
      (await ada.call("DELETE", `/syncplay/groups/${groupId}`)).status,
    ).toBe(204);
    const closed = await boraStream.next((e) => e.event === "closed");
    expect(closed.data.reason).toBe("ended");
  });

  it("checks access to the next title before moving the group to it", async () => {
    const { base } = await startServer();
    const ada = client(base, "ada");
    const groupId = (await ada.create()).json!.data.id as string;

    const refused = await ada.command(groupId, {
      type: "setItem",
      itemId: SECRET_FILM,
      fromItemId: FILM,
    });
    expect(refused.status).toBe(404);

    const moved = await ada.command(groupId, {
      type: "setItem",
      itemId: NEXT_FILM,
      fromItemId: FILM,
    });
    expect(moved.json!.data.snapshot.itemId).toBe(NEXT_FILM);
  });

  it("picks the party back up after a server restart", async () => {
    let clock = 5_000_000;
    const now = () => clock;
    const repository = createMemorySyncplayRepository();
    const first = await startServer(repository, now);
    const ada = client(first.base, "ada");
    const groupId = (await ada.create()).json!.data.id as string;
    await ada.status(groupId, "ready", 0);
    const played = await ada.command(groupId, { type: "play" });
    const anchorMs = played.json!.data.snapshot.anchorMs as number;
    // Let the write-behind persistence land.
    await new Promise((resolve) => setTimeout(resolve, 20));

    // A new process over the same database; Ada's tab reconnects 40 s later.
    clock = anchorMs + 40_000;
    const second = await startServer(repository, now);
    const rejoined = await client(second.base, "ada", ada.clientId).join(
      groupId,
    );
    expect(rejoined.status).toBe(200);
    const snapshot = rejoined.json!.data as SyncplaySnapshot;
    expect(snapshot.intent).toBe("playing");
    expect(snapshot.revision).toBe(played.json!.data.snapshot.revision);
    // The film kept playing through the restart; the timeline agrees.
    expect(snapshot.positionMs + (clock - snapshot.anchorMs)).toBe(40_000);
    expect(snapshot.epoch).not.toBe(played.json!.data.snapshot.epoch);
  });

  it("rejects malformed input before it reaches the group", async () => {
    const { base } = await startServer();
    const ada = client(base, "ada");
    const groupId = (await ada.create()).json!.data.id as string;

    expect(
      (await ada.command(groupId, { type: "rewind", positionMs: 0 })).status,
    ).toBe(422);
    expect((await ada.command(groupId, { type: "seek" })).status).toBe(422);
    expect((await ada.status(groupId, "bored", 0)).status).toBe(422);
    expect(
      (
        await ada.call("POST", `/syncplay/groups/${groupId}/join`, {
          clientId: "not-a-uuid",
        })
      ).status,
    ).toBe(422);
  });
});
