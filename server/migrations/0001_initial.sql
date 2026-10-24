-- Deye Monitor initial durable read model.
-- Credentials, access tokens, and raw upstream authentication material do not
-- belong in D1. This migration stores only normalized metadata and readings.

CREATE TABLE IF NOT EXISTS stations (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK (source = 'deye-cloud'),
  upstream_station_id TEXT,
  display_name TEXT,
  mapping_revision TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS latest_snapshots (
  station_id TEXT PRIMARY KEY REFERENCES stations(id),
  source TEXT NOT NULL CHECK (source = 'deye-cloud'),
  grid_status TEXT NOT NULL CHECK (grid_status IN ('online', 'offline', 'unknown')),
  grid_evidence_json TEXT NOT NULL,
  grid_confidence TEXT NOT NULL CHECK (grid_confidence IN ('confirmed', 'unverified')),
  grid_voltage_v REAL,
  grid_frequency_hz REAL,
  grid_power_w REAL,
  battery_soc_percent REAL,
  battery_power_w REAL,
  battery_mode TEXT NOT NULL CHECK (battery_mode IN ('charging', 'discharging', 'idle', 'unknown')),
  home_power_w REAL,
  measured_at TEXT,
  fetched_at TEXT NOT NULL,
  freshness_status TEXT NOT NULL CHECK (freshness_status IN ('fresh', 'stale', 'unavailable')),
  mapping_revision TEXT NOT NULL,
  stored_at TEXT NOT NULL,
  CHECK (json_valid(grid_evidence_json))
);

CREATE TABLE IF NOT EXISTS grid_events (
  id TEXT PRIMARY KEY,
  station_id TEXT NOT NULL REFERENCES stations(id),
  status TEXT NOT NULL CHECK (status IN ('online', 'offline')),
  observed_at TEXT NOT NULL,
  previous_status TEXT CHECK (previous_status IN ('online', 'offline')),
  previous_observed_at TEXT,
  evidence_json TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source = 'deye-cloud'),
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  CHECK (json_valid(evidence_json))
);

CREATE TABLE IF NOT EXISTS poll_runs (
  id TEXT PRIMARY KEY,
  station_id TEXT NOT NULL REFERENCES stations(id),
  window_key TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  result TEXT NOT NULL CHECK (result IN ('success', 'stale', 'unavailable', 'error')),
  latency_ms INTEGER,
  upstream_measured_at TEXT,
  error_category TEXT,
  UNIQUE (station_id, window_key)
);

-- Reserved for a future finite, durable refresh single-flight guard. No
-- refresh endpoint or scheduler is enabled by this foundation.
CREATE TABLE IF NOT EXISTS refresh_guards (
  station_id TEXT NOT NULL REFERENCES stations(id),
  operation TEXT NOT NULL,
  lease_owner TEXT NOT NULL,
  fencing_epoch INTEGER NOT NULL DEFAULT 0,
  lease_until TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (station_id, operation)
);

CREATE INDEX IF NOT EXISTS idx_grid_events_station_observed
  ON grid_events (station_id, observed_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_poll_runs_station_started
  ON poll_runs (station_id, started_at DESC, id DESC);
