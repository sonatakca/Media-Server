# Alerts

Push notifications about Seyirlik that still arrive when the Seyirlik server,
the Windows host and the Mac are all down.

## Shape

```
Seyirlik server ──signed events + heartbeat──▶ alert service (Cloudflare Worker, D1)
                                                 │  cron, every minute: silent? backups stale?
                                                 ▼
phone / laptop ◀── empty Web Push ─────────────┘
      └── service worker fetches the newest alert with its viewer token
```

- **The service** (`alerts/`) runs on Cloudflare, independent of every machine
  it watches. It stores alerts in D1 and answers `alerts.seyirlik.org`.
- **The server** reports events and a heartbeat every minute, signed with
  `SEYIRLIK_ALERTS_SECRET` (`src/server/ownApi/alerts/alertClient.ts`).
- **Silence is the alert.** The Worker's minute cron raises "Seyirlik is down"
  when no heartbeat has arrived for three minutes, saying whether the public
  health endpoint still answers (a wedged process) or not (the host or tunnel).
  The next heartbeat closes it with "Seyirlik is back" and how long it was.
- **Pushes carry nothing.** They only wake the device's service worker
  (`public/alerts-sw.js`), which fetches the newest alert itself. No payload
  encryption, and the push services never see alert text.
- **Reading needs no server.** An administrator's device gets a viewer token
  from `POST /ownAPI/v1/alerts/viewer-token` while the server is up; the Worker
  checks it with the shared secret, so `/alerts` opens when the server cannot.

## What raises an alert

| Condition                               | Where it is noticed              | Severity           |
| --------------------------------------- | -------------------------------- | ------------------ |
| No heartbeat for 3 minutes              | Worker cron                      | critical           |
| Storage guard holds the media volume    | server (`storage.*` transitions) | critical / warning |
| A backup run failed or was not verified | `scripts/record-backup-run.ts`   | critical           |
| No verified backup for 36 hours         | Worker cron, from the heartbeat  | warning            |

Each has a key, so a condition that persists is one alert, not one per minute,
and its resolution is recorded as its own entry.

Alert text never carries a path: storage alerts send only the guard's first,
classifying sentence.

## Setup (once)

From `alerts/`, after `npm install`:

1. `npx wrangler login` — authorises this machine for the Cloudflare account.
2. `npx wrangler d1 create seyirlik-alerts` — put the printed `database_id` in
   `wrangler.toml`.
3. `npx wrangler d1 execute seyirlik-alerts --remote --file=schema.sql`
4. `node scripts/vapid.mjs` — put `publicKey` in `wrangler.toml`
   (`VAPID_PUBLIC_KEY`), then `npx wrangler secret put VAPID_PRIVATE_JWK` and
   paste the `privateJwk` JSON.
5. Generate a secret of at least 32 characters (`openssl rand -base64 48`),
   `npx wrangler secret put ALERTS_SECRET`, and set the same value as
   `SEYIRLIK_ALERTS_SECRET` in the server's secrets, with
   `SEYIRLIK_ALERTS_URL=https://alerts.seyirlik.org` in its settings.
6. `npx wrangler deploy` — the route in `wrangler.toml` creates the
   `alerts.seyirlik.org` custom domain on the `seyirlik.org` zone.

Then open `/alerts` on each device, press **Notify this device**, and
**Send a test alert**. On iPhone and iPad, Web Push works only from Seyirlik
added to the home screen.

## Local development

`alerts/.dev.vars` (ignored) holds local secrets; `npm run dev` in `alerts/`
runs the Worker with a local D1, and `GET /__scheduled` runs the cron once.
