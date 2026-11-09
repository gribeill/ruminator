BEGIN;

-- Download freshness is independent of the feed's announcement date: weekends
-- and holidays can return the same announcement batch on different days.
CREATE TABLE feed_downloads (
  category TEXT PRIMARY KEY,
  checked_at TEXT NOT NULL,
  batch_json TEXT NOT NULL
);

PRAGMA user_version = 2;
COMMIT;
