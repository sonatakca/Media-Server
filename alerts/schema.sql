-- The alert service's store (Cloudflare D1). Apply with:
--   npx wrangler d1 execute seyirlik-alerts --remote --file=schema.sql

CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('critical', 'warning', 'info')),
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  -- A condition's name while it is open; cleared on the resolution entry.
  dedupe_key TEXT,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  last_seen_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS alerts_created ON alerts (created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS alerts_open_key
  ON alerts (dedupe_key) WHERE resolved_at IS NULL AND dedupe_key IS NOT NULL;

-- Devices that asked to be woken. Pushes carry no payload, so no keys are kept.
CREATE TABLE IF NOT EXISTS subscriptions (
  endpoint TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
