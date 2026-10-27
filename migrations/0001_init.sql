-- id = source + immutable source node id (GitHub node IDs survive renames and transfers).
CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  kind TEXT NOT NULL,
  title TEXT,
  body TEXT,
  url TEXT,
  state TEXT,
  state_reason TEXT,
  author TEXT,
  assignees TEXT,
  labels TEXT,
  milestone TEXT,
  milestone_due TEXT,
  issue_type TEXT,
  priority TEXT,
  priority_source TEXT,
  project_status TEXT,
  created_at TEXT,
  updated_at TEXT,
  closed_at TEXT,
  merged_at TEXT,
  is_draft INTEGER,
  comments_count INTEGER,
  timeline TEXT,
  timeline_truncated INTEGER,
  blocked_by TEXT,
  facts TEXT,
  fix_env TEXT,
  tracked TEXT,
  first_seen_sync INTEGER,
  last_seen_sync INTEGER,
  missing_since TEXT,
  synced_at TEXT
);
CREATE INDEX IF NOT EXISTS tickets_repo ON tickets(repo);

CREATE TABLE IF NOT EXISTS snapshots (
  ticket_id TEXT NOT NULL,
  sync_id INTEGER NOT NULL,
  captured_at TEXT NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (ticket_id, sync_id)
);

CREATE TABLE IF NOT EXISTS changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id TEXT NOT NULL,
  sync_id INTEGER NOT NULL,
  at TEXT NOT NULL,
  field TEXT NOT NULL,
  old TEXT,
  new TEXT
);
CREATE INDEX IF NOT EXISTS changes_at ON changes(at);
CREATE INDEX IF NOT EXISTS changes_ticket ON changes(ticket_id);

CREATE TABLE IF NOT EXISTS syncs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  trigger TEXT,
  mode TEXT,
  stats TEXT,
  errors TEXT,
  policy_version TEXT
);

CREATE TABLE IF NOT EXISTS cursors (
  scope TEXT PRIMARY KEY,
  since TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS policy_versions (
  version TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  policies TEXT NOT NULL
);
