PRAGMA foreign_keys = ON;

CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('editor', 'publisher', 'administrator')),
  created_at TEXT NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  csrf_secret TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE login_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  success INTEGER NOT NULL,
  attempted_at TEXT NOT NULL
);

CREATE TABLE sites (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE user_sites (
  user_id TEXT NOT NULL REFERENCES users(id),
  site_id TEXT NOT NULL REFERENCES sites(id),
  PRIMARY KEY (user_id, site_id)
);

CREATE TABLE locales (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  fallback_locale_id TEXT REFERENCES locales(id),
  UNIQUE (site_id, code)
);

CREATE TABLE content_types (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id),
  api_key TEXT NOT NULL,
  name TEXT NOT NULL,
  schema_json TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (site_id, api_key)
);

CREATE TABLE entries (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id),
  content_type_id TEXT NOT NULL REFERENCES content_types(id),
  locale_id TEXT NOT NULL REFERENCES locales(id),
  slug TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'published', 'archived')),
  published_revision_id TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  UNIQUE (site_id, locale_id, slug)
);

CREATE TABLE revisions (
  id TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL REFERENCES entries(id),
  revision_number INTEGER NOT NULL,
  schema_version INTEGER NOT NULL,
  fields_json TEXT NOT NULL,
  blocks_json TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  UNIQUE (entry_id, revision_number)
);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  revision_id TEXT NOT NULL UNIQUE REFERENCES revisions(id),
  approved_by TEXT NOT NULL REFERENCES users(id),
  approved_at TEXT NOT NULL
);

CREATE TABLE publications (
  id TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL REFERENCES entries(id),
  revision_id TEXT NOT NULL REFERENCES revisions(id),
  actor_id TEXT NOT NULL REFERENCES users(id),
  event_type TEXT NOT NULL CHECK (event_type IN ('publish', 'schedule', 'rollback')),
  job_id TEXT UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL REFERENCES entries(id),
  actor_id TEXT NOT NULL REFERENCES users(id),
  event_type TEXT NOT NULL,
  revision_id TEXT,
  detail_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE preview_tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  revision_id TEXT NOT NULL REFERENCES revisions(id),
  site_id TEXT NOT NULL REFERENCES sites(id),
  locale_id TEXT NOT NULL REFERENCES locales(id),
  expires_at TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE scheduled_jobs (
  id TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL REFERENCES entries(id),
  revision_id TEXT NOT NULL REFERENCES revisions(id),
  run_at TEXT NOT NULL,
  timezone TEXT NOT NULL,
  local_input TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'claimed', 'succeeded', 'failed')),
  claimed_by TEXT,
  claimed_at TEXT,
  lease_until TEXT,
  claim_token TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  not_before TEXT NOT NULL,
  last_error TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE TABLE job_attempts (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES scheduled_jobs(id),
  attempt INTEGER NOT NULL,
  worker_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  outcome TEXT,
  error TEXT
);

CREATE TABLE webhook_endpoints (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id),
  url TEXT NOT NULL,
  secret TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE webhook_events (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id),
  publication_id TEXT NOT NULL REFERENCES publications(id),
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE webhook_outbox (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES webhook_events(id),
  endpoint_id TEXT NOT NULL REFERENCES webhook_endpoints(id),
  status TEXT NOT NULL CHECK (status IN ('pending', 'delivered', 'terminal')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  last_error TEXT,
  last_response_status INTEGER,
  UNIQUE (event_id, endpoint_id)
);

CREATE TABLE webhook_attempts (
  id TEXT PRIMARY KEY,
  outbox_id TEXT NOT NULL REFERENCES webhook_outbox(id),
  attempt INTEGER NOT NULL,
  response_status INTEGER,
  error TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE media (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id),
  storage_key TEXT NOT NULL UNIQUE,
  original_name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  alt TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE redirects (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id),
  locale_id TEXT NOT NULL REFERENCES locales(id),
  from_path TEXT NOT NULL,
  to_path TEXT NOT NULL,
  status_code INTEGER NOT NULL CHECK (status_code IN (301, 302)),
  created_at TEXT NOT NULL,
  UNIQUE (site_id, locale_id, from_path)
);

CREATE INDEX idx_entries_site_status ON entries (site_id, status);
CREATE INDEX idx_revisions_entry ON revisions (entry_id, revision_number);
CREATE INDEX idx_jobs_due ON scheduled_jobs (status, run_at);
CREATE INDEX idx_outbox_due ON webhook_outbox (status, next_attempt_at);
CREATE INDEX idx_login_attempts_email ON login_attempts (email, attempted_at);
CREATE INDEX idx_publications_entry ON publications (entry_id, created_at);

CREATE TRIGGER revisions_no_update BEFORE UPDATE ON revisions
BEGIN
  SELECT RAISE(ABORT, 'revisions are immutable');
END;

CREATE TRIGGER revisions_no_delete BEFORE DELETE ON revisions
BEGIN
  SELECT RAISE(ABORT, 'revisions are immutable');
END;

CREATE TRIGGER approvals_no_update BEFORE UPDATE ON approvals
BEGIN
  SELECT RAISE(ABORT, 'approvals are immutable');
END;

CREATE TRIGGER approvals_no_delete BEFORE DELETE ON approvals
BEGIN
  SELECT RAISE(ABORT, 'approvals are immutable');
END;

CREATE TRIGGER publications_no_update BEFORE UPDATE ON publications
BEGIN
  SELECT RAISE(ABORT, 'publications are immutable');
END;

CREATE TRIGGER publications_no_delete BEFORE DELETE ON publications
BEGIN
  SELECT RAISE(ABORT, 'publications are immutable');
END;

CREATE TRIGGER audit_events_no_update BEFORE UPDATE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit events are immutable');
END;

CREATE TRIGGER audit_events_no_delete BEFORE DELETE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit events are immutable');
END;

CREATE TRIGGER webhook_events_no_update BEFORE UPDATE ON webhook_events
BEGIN
  SELECT RAISE(ABORT, 'webhook events are immutable');
END;

CREATE TRIGGER webhook_events_no_delete BEFORE DELETE ON webhook_events
BEGIN
  SELECT RAISE(ABORT, 'webhook events are immutable');
END;
