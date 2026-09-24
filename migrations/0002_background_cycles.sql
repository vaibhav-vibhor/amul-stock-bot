-- Add periodic-check bookkeeping without changing configuration or observations.
CREATE TABLE background_cycles (
  scheduled_at INTEGER PRIMARY KEY,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  pincode TEXT NOT NULL,
  config_revision INTEGER NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('checking', 'available', 'unavailable', 'partial', 'error', 'paused', 'empty', 'expired')),
  selected_count INTEGER NOT NULL DEFAULT 0,
  available_count INTEGER NOT NULL DEFAULT 0,
  unknown_count INTEGER NOT NULL DEFAULT 0,
  error TEXT
);
CREATE INDEX background_success ON background_cycles(outcome, scheduled_at);
ALTER TABLE outbox ADD COLUMN scheduled_at INTEGER REFERENCES background_cycles(scheduled_at);
