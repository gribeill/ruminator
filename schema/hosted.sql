-- Copyright 2026 Guilhem Ribeill
-- SPDX-License-Identifier: Apache-2.0

-- Accounts and a normalized reading projection for the local hosted-auth slice.
-- Full source caches, generation snapshots/claims, and retention are a subsequent slice.
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  access_issuer TEXT NOT NULL,
  access_subject TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  interests TEXT NOT NULL,
  interests_revision INTEGER NOT NULL DEFAULT 1,
  csrf_secret TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (access_issuer, access_subject)
);
CREATE UNIQUE INDEX IF NOT EXISTS sole_admin ON users(role) WHERE role = 'admin';

CREATE TABLE IF NOT EXISTS reading_listings (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  metadata_json TEXT NOT NULL CHECK (length(CAST(metadata_json AS BLOB)) <= 1048576),
  UNIQUE (user_id, id)
);
CREATE TABLE IF NOT EXISTS reading_papers (
  listing_id TEXT NOT NULL REFERENCES reading_listings(id),
  ordinal INTEGER NOT NULL,
  paper_id TEXT NOT NULL,
  paper_json TEXT NOT NULL CHECK (length(CAST(paper_json AS BLOB)) <= 1048576),
  semantic_json TEXT,
  relevance_json TEXT,
  summary_json TEXT,
  PRIMARY KEY (listing_id, ordinal),
  UNIQUE (listing_id, paper_id)
);
CREATE TABLE IF NOT EXISTS current_readings (
  user_id TEXT PRIMARY KEY,
  listing_id TEXT NOT NULL,
  FOREIGN KEY (user_id, listing_id) REFERENCES reading_listings(user_id, id)
);
CREATE TABLE IF NOT EXISTS user_votes (
  user_id TEXT NOT NULL REFERENCES users(id),
  paper_id TEXT NOT NULL,
  value INTEGER NOT NULL CHECK (value IN (-1, 0, 1)),
  paper_json TEXT NOT NULL,
  changed_at TEXT NOT NULL,
  PRIMARY KEY (user_id, paper_id)
);
