CREATE TABLE config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  pincode TEXT NOT NULL CHECK (length(pincode) = 6 AND pincode NOT GLOB '*[^0-9]*'),
  revision INTEGER NOT NULL DEFAULT 1,
  paused INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0, 1)),
  last_attempt_at INTEGER,
  last_success_at INTEGER,
  last_error TEXT,
  catalog_at INTEGER,
  upstream_retry_at INTEGER NOT NULL DEFAULT 0,
  telegram_retry_at INTEGER NOT NULL DEFAULT 0
);
INSERT INTO config (id, pincode) VALUES (1, '500032');

CREATE TABLE operation_lease (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  token TEXT,
  expires_at INTEGER NOT NULL DEFAULT 0
);
INSERT INTO operation_lease (id) VALUES (1);

-- A failed fence aborts the entire D1 batch, not just its first statement.
CREATE TABLE write_guard (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  valid INTEGER NOT NULL CHECK (valid = 1)
);
INSERT INTO write_guard (id, valid) VALUES (1, 1);

CREATE TABLE products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alias TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  active INTEGER NOT NULL CHECK (active IN (0, 1)),
  catalog_available INTEGER CHECK (catalog_available IN (0, 1)),
  last_seen_at INTEGER NOT NULL
);

CREATE TABLE tracked_products (
  product_id INTEGER PRIMARY KEY REFERENCES products(id),
  epoch TEXT NOT NULL UNIQUE
);

CREATE TABLE observations (
  product_id INTEGER NOT NULL REFERENCES products(id),
  pincode TEXT NOT NULL,
  watch_epoch TEXT NOT NULL,
  available INTEGER NOT NULL CHECK (available IN (0, 1)),
  checked_at INTEGER NOT NULL,
  transition_seq INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (product_id, pincode, watch_epoch)
);

CREATE TABLE telegram_updates (
  update_id INTEGER PRIMARY KEY,
  callback_id TEXT UNIQUE,
  processed_at INTEGER NOT NULL
);

CREATE TABLE outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dedupe_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('alert', 'reply', 'callback')),
  method TEXT NOT NULL CHECK (method IN ('sendMessage', 'editMessageText', 'answerCallbackQuery')),
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  pincode TEXT,
  product_id INTEGER REFERENCES products(id),
  watch_epoch TEXT,
  config_revision INTEGER,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'acknowledged', 'cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  next_attempt_at INTEGER NOT NULL,
  expires_at INTEGER,
  acknowledged_at INTEGER,
  last_error TEXT
);
CREATE INDEX outbox_pending ON outbox(state, next_attempt_at);
CREATE INDEX outbox_archive ON outbox(state, created_at);
CREATE INDEX updates_age ON telegram_updates(processed_at);
