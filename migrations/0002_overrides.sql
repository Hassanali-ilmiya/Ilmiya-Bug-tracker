-- Manual tracker overrides set from the dashboard. Sync never writes here, so an edit or a deletion
-- (hidden = 1) survives every sync until it is changed or restored from the dashboard.
CREATE TABLE IF NOT EXISTS overrides (
  ticket_id TEXT PRIMARY KEY,
  status TEXT,
  status_at TEXT,
  priority TEXT,
  fix_env TEXT,
  note TEXT,
  hidden INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
