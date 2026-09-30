-- Which seasons and films have been looked at for intros and credits.
--
-- `item_segments` holds what was found, and finding nothing leaves nothing
-- there — so without this a sweep could not tell a season it has analysed and
-- found no intro in from one it has never opened, and would decode every such
-- season again on every pass. A row here says "looked, with this version of
-- the detector, over this many episodes"; a new episode or a newer detector
-- makes it stale and the season is looked at again.

CREATE TABLE segment_detection_runs (
  subject_id uuid PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
  subject_kind text NOT NULL,
  detector_version integer NOT NULL,
  episode_count integer NOT NULL,
  segments_found integer NOT NULL,
  detected_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT segment_detection_runs_kind_known
    CHECK (subject_kind IN ('season', 'movie')),
  CONSTRAINT segment_detection_runs_counts
    CHECK (episode_count >= 0 AND segments_found >= 0)
);
