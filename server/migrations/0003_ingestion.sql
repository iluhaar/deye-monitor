-- Last confirmed observation is independent of the latest (possibly unknown)
-- snapshot. Gaps do not erase it or manufacture a utility-grid transition.
CREATE TABLE grid_context (
  station_id TEXT PRIMARY KEY REFERENCES stations(id),
  status TEXT NOT NULL CHECK (status IN ('online', 'offline')),
  observed_at TEXT NOT NULL,
  gap_since TEXT
);

INSERT INTO grid_context (station_id, status, observed_at)
SELECT station_id, status, observed_at FROM (
  SELECT station_id, status, observed_at,
    row_number() OVER (PARTITION BY station_id ORDER BY observed_at DESC, id DESC) AS rank
  FROM grid_events
) WHERE rank = 1;

ALTER TABLE grid_events ADD COLUMN gap_since TEXT;
ALTER TABLE poll_runs ADD COLUMN observation_key TEXT;
ALTER TABLE poll_runs ADD COLUMN outcome TEXT;
ALTER TABLE poll_runs ADD COLUMN fencing_epoch INTEGER;
CREATE INDEX idx_poll_runs_station_epoch ON poll_runs (station_id, fencing_epoch DESC);
