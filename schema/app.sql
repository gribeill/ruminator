-- Current development schema only; recreate this DB when the schema changes.
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
