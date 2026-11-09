BEGIN;

-- Keep source and published snapshots intact, even if a feed is later corrected.
CREATE TABLE batches (
  category TEXT NOT NULL,
  announcement_date TEXT NOT NULL,
  source_url TEXT NOT NULL,
  papers_json TEXT NOT NULL,
  fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (category, announcement_date)
);

CREATE TABLE digests (
  id INTEGER PRIMARY KEY,
  announcement_date TEXT NOT NULL,
  categories_json TEXT NOT NULL,
  papers_json TEXT NOT NULL,
  featured_ids_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (announcement_date, categories_json)
);

PRAGMA user_version = 1;
COMMIT;
