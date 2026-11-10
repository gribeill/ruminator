-- Current development schema only; recreate this DB when the schema changes.
-- One visible artifact and one working generation; never expose staging to readers.
CREATE TABLE IF NOT EXISTS publication (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  generation_id TEXT NOT NULL,
  digest_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS working_listing (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  generation_id TEXT NOT NULL,
  announcement_date TEXT NOT NULL,
  categories_json TEXT NOT NULL,
  inputs_json TEXT
);
-- Local CLI writers serialize across async inference/HTTP without holding a DB transaction.
CREATE TABLE IF NOT EXISTS generation_lock (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  owner_pid INTEGER NOT NULL,
  token TEXT NOT NULL
);
-- Append-only changes preserve vote history; IDs intentionally exclude versions.
CREATE TABLE IF NOT EXISTS vote_events (
  event_id INTEGER PRIMARY KEY,
  arxiv_id TEXT NOT NULL,
  value INTEGER NOT NULL CHECK (value IN (-1, 0, 1)),
  paper_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS vote_events_by_paper ON vote_events (arxiv_id, event_id);

-- Capture feedback before the first asynchronous scoring step, not when publishing.
CREATE TABLE IF NOT EXISTS feedback_snapshots (
  announcement_date TEXT NOT NULL,
  categories_json TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  PRIMARY KEY (announcement_date, categories_json)
);

-- Runs record the latest invoked settings and retain input spent across invocations.
CREATE TABLE IF NOT EXISTS summary_runs (
  announcement_date TEXT NOT NULL,
  categories_json TEXT NOT NULL,
  config_json TEXT NOT NULL,
  used_input_tokens INTEGER NOT NULL DEFAULT 0,
  budget_exhausted INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (announcement_date, categories_json)
);

-- Each featured paper gets one immutable outcome (including failures/skips).
-- A pre-request interrupted state prevents duplicate paid calls on resumption.
CREATE TABLE IF NOT EXISTS digest_summaries (
  announcement_date TEXT NOT NULL,
  categories_json TEXT NOT NULL,
  arxiv_id TEXT NOT NULL,
  result_json TEXT NOT NULL,
  PRIMARY KEY (announcement_date, categories_json, arxiv_id)
);

-- Reuse successful scientific summaries across digests with identical inputs.
CREATE TABLE IF NOT EXISTS summary_cache (
  cache_key TEXT PRIMARY KEY,
  result_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS rankings (
  announcement_date TEXT NOT NULL,
  categories_json TEXT NOT NULL,
  ranking_json TEXT NOT NULL,
  PRIMARY KEY (announcement_date, categories_json)
);

CREATE TABLE IF NOT EXISTS digests (
  id INTEGER PRIMARY KEY,
  announcement_date TEXT NOT NULL,
  categories_json TEXT NOT NULL,
  papers_json TEXT NOT NULL,
  featured_ids_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (announcement_date, categories_json)
);

CREATE TABLE IF NOT EXISTS embeddings (
  fingerprint TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  vector_json TEXT NOT NULL,
  PRIMARY KEY (fingerprint, content_hash)
);

CREATE TABLE IF NOT EXISTS semantic_scores (
  announcement_date TEXT NOT NULL,
  categories_json TEXT NOT NULL,
  scores_json TEXT NOT NULL,
  PRIMARY KEY (announcement_date, categories_json)
);
