-- Why a download exists, which release it is, and what has happened to it.
--
-- Seyirlik is the control plane and SABnzbd is the execution engine. That
-- split decides the shape of this table: every column here answers a question
-- SABnzbd cannot ("why", "for what", "chosen how", "what do we do if it
-- fails"), and the two columns that point at SABnzbd are the whole of the
-- coupling.

CREATE TABLE acquisitions (
  id uuid PRIMARY KEY,

  -- What this is for. Nullable item_id because a manual acquisition may be
  -- made against a target that is not catalogued yet.
  target_kind text NOT NULL,
  target_item_id uuid REFERENCES items(id) ON DELETE SET NULL,
  target_title varchar(500) NOT NULL,
  target_year integer,
  target_season integer,
  target_episode integer,

  -- Which release. The guid is the indexer's own stable identifier; the URL
  -- that fetches it carries the provider's API key and is deliberately absent.
  indexer_id varchar(64) NOT NULL,
  release_guid text NOT NULL,
  release_title text NOT NULL,

  state text NOT NULL,
  origin text NOT NULL,

  /*
   * The idempotency key is generated once, before anything is sent, and is the
   * name SABnzbd is asked to give the job. It is what makes a lost submission
   * response recoverable: the reply may be gone, but the job — if it was
   * accepted — is findable by a name only this acquisition would have used.
   */
  idempotency_key varchar(128) NOT NULL UNIQUE,
  -- SABnzbd's own identifier, once known. Null until the job is found.
  external_id varchar(128),

  attempt integer NOT NULL DEFAULT 0,
  failure_class text,
  failure_detail text,
  retry_after timestamptz,

  -- Where SABnzbd says the finished bytes are. Phase 5 reads this; nothing in
  -- this phase may act on it.
  download_path text,
  size_bytes bigint,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

-- The reconciler asks for exactly this set, and only this set.
CREATE INDEX acquisitions_active_idx
  ON acquisitions (state)
  WHERE state NOT IN ('downloaded', 'cancelled', 'superseded', 'failed');

CREATE INDEX acquisitions_external_idx
  ON acquisitions (external_id)
  WHERE external_id IS NOT NULL;

CREATE INDEX acquisitions_target_idx ON acquisitions (target_item_id);

-- Why this release was chosen, kept separately because it is written once and
-- never updated, while the acquisition row changes constantly.
--
-- The policy is stored as a snapshot rather than as a foreign key. A profile
-- edited next month must not silently rewrite the answer to "why did Seyirlik
-- download this", which is the only question this table exists to answer.
CREATE TABLE acquisition_decisions (
  acquisition_id uuid PRIMARY KEY REFERENCES acquisitions(id) ON DELETE CASCADE,
  profile_id uuid,
  profile_name varchar(200) NOT NULL,
  policy_snapshot jsonb NOT NULL,
  release_facts jsonb NOT NULL,
  score integer NOT NULL DEFAULT 0,
  reasons jsonb NOT NULL,
  -- Everything considered and rejected, so the answer to "why not that one"
  -- survives as long as the answer to "why this one".
  rejected jsonb NOT NULL DEFAULT '[]'::jsonb,
  decided_at timestamptz NOT NULL DEFAULT now()
);

-- Every state change, in order. Append-only.
CREATE TABLE acquisition_events (
  id bigserial PRIMARY KEY,
  acquisition_id uuid NOT NULL REFERENCES acquisitions(id) ON DELETE CASCADE,
  from_state text,
  to_state text NOT NULL,
  failure_class text,
  detail text,
  at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX acquisition_events_acquisition_idx
  ON acquisition_events (acquisition_id, id);

COMMENT ON COLUMN acquisitions.idempotency_key IS
  'Generated before submission and used as the SABnzbd job name, so a lost '
  'response can be resolved by looking for the job instead of sending it again.';

COMMENT ON COLUMN acquisitions.download_path IS
  'Where SABnzbd left the finished bytes. Read by the import phase; this phase '
  'never acts on it.';

COMMENT ON TABLE acquisition_decisions IS
  'A snapshot, not a reference: a profile edited later must not rewrite the '
  'recorded reason a past download happened.';
