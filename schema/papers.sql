-- Copyright 2026 Guilhem Ribeill
--
-- Licensed under the Apache License, Version 2.0 (the "License");
-- you may not use this file except in compliance with the License.
-- You may obtain a copy of the License at
--
--     http://www.apache.org/licenses/LICENSE-2.0
--
-- Unless required by applicable law or agreed to in writing, software
-- distributed under the License is distributed on an "AS IS" BASIS,
-- WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
-- See the License for the specific language governing permissions and
-- limitations under the License.

-- Explicit author metadata can enrich archived batches without rewriting them.
CREATE TABLE IF NOT EXISTS paper_authors (
  arxiv_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  names_json TEXT NOT NULL,
  PRIMARY KEY (arxiv_id, version)
);

-- Full-text retrieval is independent of immutable digests and ranking.
-- Keep raw HTML for re-extraction and cache failures until an explicit retry.
CREATE TABLE IF NOT EXISTS paper_texts (
  arxiv_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  html TEXT,
  result_json TEXT NOT NULL,
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
