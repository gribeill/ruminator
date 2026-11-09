-- Explicit author metadata can enrich archived batches without rewriting them.
CREATE TABLE IF NOT EXISTS paper_authors (
  arxiv_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  names_json TEXT NOT NULL,
  PRIMARY KEY (arxiv_id, version)
);

-- Source data lives separately from disposable application state.
CREATE TABLE IF NOT EXISTS batches (
  category TEXT NOT NULL,
  announcement_date TEXT NOT NULL,
  source_url TEXT NOT NULL,
  papers_json TEXT NOT NULL,
  fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (category, announcement_date)
);

-- Freshness tracks download time, not announcement date (e.g. on weekends).
CREATE TABLE IF NOT EXISTS feed_downloads (
  category TEXT PRIMARY KEY,
  checked_at TEXT NOT NULL,
  batch_json TEXT NOT NULL
);
