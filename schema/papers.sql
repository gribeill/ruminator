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
