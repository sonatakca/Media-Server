import {
  BACKUP_STALE_KEY,
  HOST_DOWN_KEY,
  assessHost,
  backupIsStale,
  decideEvent,
  describeDuration,
  parseEvent,
  verifyRequest,
  verifyViewerToken,
  type AlertEvent,
  type Heartbeat,
  type Severity,
  type StoredAlert,
} from "./core";
import { isPublicKey, sendEmptyPush, type VapidKeys } from "./webPush";

/*
 * The Seyirlik alert service, a Cloudflare Worker.
 *
 * Routes, all under /v1:
 *   POST events        the server reports an event            (signed)
 *   POST heartbeat     the server says it is alive            (signed)
 *   GET  alerts        a device reads recent alerts           (viewer token)
 *   POST subscriptions a device asks to be pushed            (viewer token)
 *   DELETE subscriptions                                     (viewer token)
 *   POST test          a device asks for a test alert        (viewer token)
 *   GET  vapid-public-key                                    (public)
 * and a scheduled check every minute that notices silence.
 */

/** The slice of Cloudflare's D1 binding this uses. */
interface D1Result<T> {
  results: T[];
}
interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<D1Result<T>>;
  run(): Promise<unknown>;
}
interface D1Database {
  prepare(sql: string): D1Statement;
}
interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

export interface Env {
  DB: D1Database;
  /** Shared with the Seyirlik server; signs its requests and viewer tokens. */
  ALERTS_SECRET: string;
  /** P-256 private key JWK, as JSON. */
  VAPID_PRIVATE_JWK: string;
  VAPID_PUBLIC_KEY: string;
  VAPID_SUBJECT: string;
  /** The server's public health endpoint, asked when heartbeats stop. */
  HEALTH_URL: string;
  /** Comma-separated origins allowed to read alerts from a browser. */
  ALLOWED_ORIGINS: string;
}

interface AlertRow {
  id: string;
  kind: string;
  severity: Severity;
  title: string;
  body: string;
  dedupe_key: string | null;
  created_at: number;
  resolved_at: number | null;
  last_seen_at: number;
}

function toAlert(row: AlertRow): StoredAlert {
  return {
    id: row.id,
    kind: row.kind,
    severity: row.severity,
    title: row.title,
    body: row.body,
    key: row.dedupe_key,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    lastSeenAt: row.last_seen_at,
  };
}

function corsHeaders(env: Env, request: Request): Record<string, string> {
  const origin = request.headers.get("Origin") ?? "";
  const allowed = env.ALLOWED_ORIGINS.split(",").map((value) => value.trim());
  return allowed.includes(origin)
    ? {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
        "Access-Control-Max-Age": "86400",
        Vary: "Origin",
      }
    : { Vary: "Origin" };
}

function json(
  env: Env,
  request: Request,
  status: number,
  body: unknown,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...corsHeaders(env, request),
    },
  });
}

function vapidKeys(env: Env): VapidKeys | null {
  if (!isPublicKey(env.VAPID_PUBLIC_KEY)) return null;
  try {
    return {
      privateJwk: JSON.parse(env.VAPID_PRIVATE_JWK),
      publicKey: env.VAPID_PUBLIC_KEY,
      subject: env.VAPID_SUBJECT,
    };
  } catch {
    return null;
  }
}

async function readState<T>(env: Env, key: string): Promise<T | null> {
  const row = await env.DB.prepare("SELECT value FROM state WHERE key = ?")
    .bind(key)
    .first<{ value: string }>();
  return row ? (JSON.parse(row.value) as T) : null;
}

async function writeState(env: Env, key: string, value: unknown) {
  await env.DB.prepare(
    "INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  )
    .bind(key, JSON.stringify(value))
    .run();
}

async function pushEveryone(env: Env, now: number): Promise<void> {
  const keys = vapidKeys(env);
  if (!keys) return;
  const { results } = await env.DB.prepare(
    "SELECT endpoint FROM subscriptions",
  ).all<{ endpoint: string }>();
  await Promise.all(
    results.map(async ({ endpoint }) => {
      if ((await sendEmptyPush({ endpoint }, keys, now)) === "gone") {
        await env.DB.prepare("DELETE FROM subscriptions WHERE endpoint = ?")
          .bind(endpoint)
          .run();
      }
    }),
  );
}

/** Applies one event, and pushes if it is news. */
async function applyEvent(
  env: Env,
  event: AlertEvent,
  now: number,
): Promise<void> {
  const open = event.key
    ? await env.DB.prepare(
        "SELECT * FROM alerts WHERE dedupe_key = ? AND resolved_at IS NULL",
      )
        .bind(event.key)
        .first<AlertRow>()
    : null;
  const decision = decideEvent(event, open ? toAlert(open) : null);

  if (decision.action === "ignore") return;
  if (decision.action === "touch") {
    await env.DB.prepare("UPDATE alerts SET last_seen_at = ? WHERE id = ?")
      .bind(now, decision.alertId)
      .run();
    return;
  }
  if (decision.action === "resolve") {
    await env.DB.prepare("UPDATE alerts SET resolved_at = ? WHERE id = ?")
      .bind(now, decision.alertId)
      .run();
  }
  // A resolution is recorded as an entry of its own, so the history reads
  // "down at 23:47", "back at 00:12" rather than one row that changed.
  await env.DB.prepare(
    `INSERT INTO alerts (id, kind, severity, title, body, dedupe_key, created_at, resolved_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      event.kind,
      decision.action === "resolve" ? "info" : event.severity,
      event.title,
      event.body ?? "",
      decision.action === "resolve" ? null : (event.key ?? null),
      now,
      decision.action === "resolve" ? now : null,
      now,
    )
    .run();
  if (decision.notify) await pushEveryone(env, now);
}

async function requireViewer(env: Env, request: Request, now: number) {
  const header = request.headers.get("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  return verifyViewerToken(env.ALERTS_SECRET, token, now);
}

async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const now = Date.now();

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(env, request),
    });
  }

  if (url.pathname === "/v1/vapid-public-key" && request.method === "GET") {
    return json(env, request, 200, { publicKey: env.VAPID_PUBLIC_KEY });
  }

  if (
    (url.pathname === "/v1/events" || url.pathname === "/v1/heartbeat") &&
    request.method === "POST"
  ) {
    const body = await request.text();
    if (body.length > 16_384)
      return json(env, request, 413, { error: "too-large" });
    const signed = await verifyRequest(
      env.ALERTS_SECRET,
      request.headers.get("X-Seyirlik-Timestamp"),
      request.headers.get("X-Seyirlik-Signature"),
      body,
      now,
    );
    if (!signed) return json(env, request, 401, { error: "unsigned" });

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return json(env, request, 400, { error: "invalid-json" });
    }

    if (url.pathname === "/v1/heartbeat") {
      // Read before overwriting: the last heartbeat before a silence is when
      // the outage began, and the down alert was only raised minutes later.
      const previous = await readState<{ receivedAt: number }>(
        env,
        "heartbeat",
      );
      await writeState(env, "heartbeat", {
        heartbeat: parsed as Heartbeat,
        receivedAt: now,
      });
      await checkHost(env, now, true, previous?.receivedAt);
      return json(env, request, 202, { ok: true });
    }

    const event = parseEvent(parsed);
    if (!event) return json(env, request, 400, { error: "invalid-event" });
    await applyEvent(env, event, now);
    return json(env, request, 202, { ok: true });
  }

  const viewer = url.pathname.startsWith("/v1/")
    ? await requireViewer(env, request, now)
    : null;

  if (url.pathname === "/v1/alerts" && request.method === "GET") {
    if (!viewer) return json(env, request, 401, { error: "token" });
    const limit = Math.min(
      200,
      Math.max(1, Number(url.searchParams.get("limit")) || 50),
    );
    const { results } = await env.DB.prepare(
      "SELECT * FROM alerts ORDER BY created_at DESC LIMIT ?",
    )
      .bind(limit)
      .all<AlertRow>();
    const heartbeat = await readState<{
      heartbeat: Heartbeat;
      receivedAt: number;
    }>(env, "heartbeat");
    return json(env, request, 200, {
      alerts: results.map(toAlert),
      host: {
        lastHeartbeatAt: heartbeat?.receivedAt ?? null,
        storage: heartbeat?.heartbeat.storage ?? null,
        version: heartbeat?.heartbeat.version ?? null,
        lastVerifiedBackupAt: heartbeat?.heartbeat.lastVerifiedBackupAt ?? null,
        down: Boolean(
          await env.DB.prepare(
            "SELECT 1 AS open FROM alerts WHERE dedupe_key = ? AND resolved_at IS NULL",
          )
            .bind(HOST_DOWN_KEY)
            .first(),
        ),
      },
    });
  }

  if (url.pathname === "/v1/subscriptions") {
    if (!viewer) return json(env, request, 401, { error: "token" });
    const body = (await request.json().catch(() => null)) as {
      endpoint?: unknown;
    } | null;
    const endpoint = typeof body?.endpoint === "string" ? body.endpoint : "";
    if (!/^https:\/\//.test(endpoint) || endpoint.length > 1_000) {
      return json(env, request, 400, { error: "endpoint" });
    }
    if (request.method === "POST") {
      await env.DB.prepare(
        "INSERT INTO subscriptions (endpoint, subject, created_at) VALUES (?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET subject = excluded.subject",
      )
        .bind(endpoint, viewer.subject, now)
        .run();
      return json(env, request, 201, { ok: true });
    }
    if (request.method === "DELETE") {
      await env.DB.prepare("DELETE FROM subscriptions WHERE endpoint = ?")
        .bind(endpoint)
        .run();
      return json(env, request, 200, { ok: true });
    }
  }

  if (url.pathname === "/v1/test" && request.method === "POST") {
    if (!viewer) return json(env, request, 401, { error: "token" });
    await applyEvent(
      env,
      {
        kind: "test",
        severity: "warning",
        title: "Test alert",
        body: "Alerts reach this device.",
      },
      now,
    );
    return json(env, request, 202, { ok: true });
  }

  return json(env, request, 404, { error: "not-found" });
}

/** Whether the public health endpoint answers within ten seconds. */
async function healthAnswers(env: Env): Promise<boolean> {
  try {
    const response = await fetch(env.HEALTH_URL, {
      signal: AbortSignal.timeout(10_000),
      headers: { "Cache-Control": "no-store" },
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * The check nothing on the server can do for itself.
 *
 * `fromHeartbeat` is true when a heartbeat has just arrived, which can only
 * ever close the down alert — so the health endpoint is not asked for it.
 */
async function checkHost(
  env: Env,
  now: number,
  fromHeartbeat = false,
  silentSince?: number,
) {
  const state = await readState<{ heartbeat: Heartbeat; receivedAt: number }>(
    env,
    "heartbeat",
  );
  const open = await env.DB.prepare(
    "SELECT * FROM alerts WHERE dedupe_key = ? AND resolved_at IS NULL",
  )
    .bind(HOST_DOWN_KEY)
    .first<AlertRow>();

  const assessment = assessHost(
    state?.heartbeat ?? null,
    state?.receivedAt ?? null,
    fromHeartbeat ? true : await healthAnswers(env),
    now,
  );

  if (assessment.down && !open) {
    await applyEvent(
      env,
      {
        kind: "host",
        severity: "critical",
        title: "Seyirlik is down",
        body: assessment.detail,
        key: HOST_DOWN_KEY,
      },
      now,
    );
  } else if (!assessment.down && open) {
    await applyEvent(
      env,
      {
        kind: "host",
        severity: "info",
        title: "Seyirlik is back",
        body: `It was unreachable for ${describeDuration(
          now - Math.min(silentSince ?? open.created_at, open.created_at),
        )}.`,
        key: HOST_DOWN_KEY,
        resolve: true,
      },
      now,
    );
  }

  const staleBackup = backupIsStale(state?.heartbeat ?? null, now);
  const openBackup = await env.DB.prepare(
    "SELECT id FROM alerts WHERE dedupe_key = ? AND resolved_at IS NULL",
  )
    .bind(BACKUP_STALE_KEY)
    .first();
  if (staleBackup && !openBackup) {
    await applyEvent(
      env,
      {
        kind: "backup",
        severity: "warning",
        title: "No verified backup in 36 hours",
        body: "The last backup that was restored and checked is too old.",
        key: BACKUP_STALE_KEY,
      },
      now,
    );
  } else if (!staleBackup && openBackup) {
    await applyEvent(
      env,
      {
        kind: "backup",
        severity: "info",
        title: "Backups are current again",
        key: BACKUP_STALE_KEY,
        resolve: true,
      },
      now,
    );
  }
}

export default {
  fetch: (request: Request, env: Env) =>
    handle(request, env).catch(
      () =>
        new Response(JSON.stringify({ error: "internal" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        }),
    ),
  scheduled: (_controller: unknown, env: Env, context: ExecutionContext) => {
    context.waitUntil(checkHost(env, Date.now()));
  },
};
