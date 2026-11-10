-- Current development schema only; recreate this DB when the schema changes.
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
