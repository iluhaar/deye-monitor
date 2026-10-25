-- Durable throttle and observation high-water mark survive release/takeover.
ALTER TABLE refresh_guards ADD COLUMN next_allowed_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z';
ALTER TABLE refresh_guards ADD COLUMN last_observed_at TEXT;
ALTER TABLE refresh_guards ADD COLUMN last_observation_key TEXT;

-- Transaction-local assertion scratchpad. A failed CHECK aborts the entire
-- D1 batch, including any snapshot/event/poll-run writes in that batch.
CREATE TABLE refresh_commit_checks (
  valid INTEGER NOT NULL CHECK (valid = 1)
);
