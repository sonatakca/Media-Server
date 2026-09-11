-- A browser session for a subtitle provider that has no API keys.
--
-- TürkçeAltyazı trusts a browser that passed a Cloudflare check and signed in,
-- and nothing else. A person does that in their own browser and hands the
-- server the resulting Cookie header together with that browser's user agent;
-- the two only work together, so they are sealed together.
--
-- Only ciphertext is stored. `sealed` is AES-256-GCM over the JSON
-- {cookie, userAgent}, under a key derived from the session-hash secret in the
-- secrets file — never from anything in this database — with the provider id
-- as associated data, so a sealed value copied onto another row does not open.
-- A database backup therefore carries nothing usable on its own.
--
-- `rejected` is the provider having refused the session (or an anonymous
-- request) with a challenge. The material is dropped at that point rather than
-- kept: a dead cookie is still somebody's cookie.

CREATE TABLE provider_sessions (
  provider_id varchar(64) PRIMARY KEY,
  state text NOT NULL,
  sealed bytea,
  reason varchar(300),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT provider_sessions_id_slug
    CHECK (provider_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  CONSTRAINT provider_sessions_state_known
    CHECK (state IN ('active', 'rejected')),
  -- An active row always has material and a rejected one never does.
  CONSTRAINT provider_sessions_material_matches_state
    CHECK ((state = 'active') = (sealed IS NOT NULL))
);
