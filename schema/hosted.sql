-- Copyright 2026 Guilhem Ribeill
-- SPDX-License-Identifier: Apache-2.0

-- Current local hosted schema. Production updates require separate approval.
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

-- One saved global document. Saving limits is not authorization to run summaries;
-- live execution and schedule activation remain separately gated.
CREATE TABLE IF NOT EXISTS saved_config (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  text TEXT NOT NULL CHECK (length(CAST(text AS BLOB)) <= 65536),
  revision INTEGER NOT NULL CHECK (revision >= 1)
);

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

-- Frozen generation-start inputs and their lifecycle share one row. Only batch
-- readiness and output/state fields advance. Captured documents/identities stay fixed.
-- Batch bytes are staged in bounded pages, then sealed after hash verification.
CREATE TABLE IF NOT EXISTS generation_inputs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  started_at TEXT NOT NULL,
  interests TEXT NOT NULL CHECK (length(CAST(interests AS BLOB)) <= 65536),
  interests_revision INTEGER NOT NULL,
  config TEXT NOT NULL CHECK (length(CAST(config AS BLOB)) <= 65536),
  config_revision INTEGER NOT NULL,
  model_identity TEXT NOT NULL CHECK (length(CAST(model_identity AS BLOB)) BETWEEN 1 AND 4096),
  batch_hash TEXT NOT NULL,
  batch_bytes INTEGER NOT NULL CHECK (batch_bytes > 0),
  batch_chunks INTEGER NOT NULL CHECK (batch_chunks > 0),
  batch_complete INTEGER NOT NULL DEFAULT 0 CHECK (batch_complete IN (0, 1)),
  batch_key TEXT NOT NULL,
  summaries_requested INTEGER NOT NULL CHECK (summaries_requested IN (0, 1)),
  action TEXT NOT NULL DEFAULT 'daily' CHECK (action IN ('daily', 'rebuild', 'summaries')),
  base_publication TEXT,
  summary_config TEXT CHECK (summary_config IS NULL OR length(CAST(summary_config AS BLOB)) <= 65536),
  summary_config_revision INTEGER,
  state TEXT NOT NULL DEFAULT 'working' CHECK (state IN ('working', 'staging', 'ready', 'published', 'failed')),
  output_hash TEXT,
  paper_count INTEGER CHECK (paper_count >= 0),
  CHECK ((summary_config IS NULL) = (summary_config_revision IS NULL)),
  UNIQUE (user_id, id)
);
-- One latest daily admission/status per user, not a job history. No generation
-- foreign key: duplicate-delivery protection and last success survive cleanup.
CREATE TABLE IF NOT EXISTS generation_runs (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  run_date TEXT NOT NULL,
  generation_id TEXT,
  deadline TEXT NOT NULL,
  finished_at TEXT,
  failure_reason TEXT CHECK (failure_reason IN ('preparation', 'launch', 'run', 'deadline', 'waiting', 'disabled')),
  last_success_at TEXT,
  CHECK (generation_id IS NOT NULL OR finished_at IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS generation_run_id ON generation_runs(generation_id);

-- One latest cohort pass. Scheduled dates are consumed even on ingestion failure;
-- an attempt ID also consumes each freshly confirmed manual Populate feed form.
-- No history, leases, takeover, or automatic recovery of interrupted passes.
CREATE TABLE IF NOT EXISTS scheduled_pass (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  run_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'complete', 'feed-failed', 'failed')),
  attempt_id TEXT,
  batch_date TEXT
);

CREATE TABLE IF NOT EXISTS working_generations (
  user_id TEXT PRIMARY KEY,
  generation_id TEXT NOT NULL,
  FOREIGN KEY (user_id, generation_id) REFERENCES generation_inputs(user_id, id)
);
CREATE TABLE IF NOT EXISTS generation_input_votes (
  generation_id TEXT NOT NULL REFERENCES generation_inputs(id),
  paper_id TEXT NOT NULL,
  value INTEGER NOT NULL CHECK (value IN (-1, 1)),
  paper_json TEXT NOT NULL CHECK (json_valid(paper_json) AND length(CAST(paper_json AS BLOB)) <= 1048576),
  changed_at TEXT NOT NULL,
  PRIMARY KEY (generation_id, paper_id)
);
-- Private vectors reference frozen vote metadata instead of copying it. Expiring a
-- frozen vote removes its vector too, without touching a reading projection.
CREATE TABLE IF NOT EXISTS generation_feedback_examples (
  generation_id TEXT NOT NULL,
  paper_id TEXT NOT NULL,
  event_id INTEGER NOT NULL,
  vector_json TEXT NOT NULL CHECK (json_valid(vector_json) AND length(CAST(vector_json AS BLOB)) <= 65536),
  PRIMARY KEY (generation_id, paper_id),
  FOREIGN KEY (generation_id, paper_id) REFERENCES generation_input_votes(generation_id, paper_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS generation_batch_chunks (
  generation_id TEXT NOT NULL REFERENCES generation_inputs(id),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  bytes BLOB NOT NULL CHECK (length(bytes) > 0 AND length(bytes) <= 262144),
  PRIMARY KEY (generation_id, ordinal)
);

-- Membership is indexed separately from the immutable batch bytes for retention.
CREATE TABLE IF NOT EXISTS generation_paper_refs (
  generation_id TEXT NOT NULL REFERENCES generation_inputs(id),
  paper_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  PRIMARY KEY (generation_id, paper_id, version)
);

-- Admission and completed chunk-batch responses for embedding effects only.
-- Claimed rows are never retried. A later generation may attempt the same input
-- after the old generation has failed; no lease reclaim or provider retry.
CREATE TABLE IF NOT EXISTS embedding_requests (
  generation_id TEXT NOT NULL REFERENCES generation_inputs(id),
  request_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('claimed', 'complete')),
  vectors_json TEXT CHECK (vectors_json IS NULL OR (json_valid(vectors_json) AND length(CAST(vectors_json AS BLOB)) <= 131072)),
  CHECK ((state = 'claimed' AND vectors_json IS NULL) OR (state = 'complete' AND vectors_json IS NOT NULL)),
  PRIMARY KEY (generation_id, request_key)
);
CREATE INDEX IF NOT EXISTS embedding_request_key ON embedding_requests(request_key);

-- Small inference results are atomic rows, not staged blob artifacts. Paper
-- vectors are scientific/public inputs. Profile vectors belong to one generation.
CREATE TABLE IF NOT EXISTS paper_vectors (
  paper_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  model_identity TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  vector_json TEXT NOT NULL CHECK (json_valid(vector_json) AND length(CAST(vector_json AS BLOB)) <= 65536),
  PRIMARY KEY (paper_id, version, model_identity, input_hash)
);
CREATE TABLE IF NOT EXISTS generation_profile_vectors (
  generation_id TEXT NOT NULL REFERENCES generation_inputs(id),
  profile_id TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  vector_json TEXT NOT NULL CHECK (json_valid(vector_json) AND length(CAST(vector_json AS BLOB)) <= 65536),
  PRIMARY KEY (generation_id, profile_id)
);
-- Only successful scientific content is shared. Published text is copied into
-- reading_papers, so cache deletion cannot change a reader's saved summary.
CREATE TABLE IF NOT EXISTS summary_cache (
  cache_key TEXT PRIMARY KEY,
  paper_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  identity_json TEXT NOT NULL CHECK (length(CAST(identity_json AS BLOB)) <= 16384),
  summary TEXT NOT NULL CHECK (length(CAST(summary AS BLOB)) BETWEEN 1 AND 8192),
  actual_model TEXT CHECK (actual_model IS NULL OR length(CAST(actual_model AS BLOB)) <= 1024),
  created_at TEXT NOT NULL
);

-- Frozen featured order, per-user input reservations, and terminal outcomes.
-- A claimed row is never dispatched again, even if its response was lost.
CREATE TABLE IF NOT EXISTS summary_outcomes (
  generation_id TEXT NOT NULL REFERENCES generation_inputs(id),
  paper_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 0 AND 5),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'claimed', 'complete')),
  cache_key TEXT,
  charged_input INTEGER NOT NULL DEFAULT 0 CHECK (charged_input >= 0),
  budget_stopped INTEGER NOT NULL DEFAULT 0 CHECK (budget_stopped IN (0, 1)),
  outcome_json TEXT CHECK (outcome_json IS NULL OR (json_valid(outcome_json) AND length(CAST(outcome_json AS BLOB)) <= 16384)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK ((state = 'pending' AND outcome_json IS NULL AND charged_input = 0) OR
    (state = 'claimed' AND outcome_json IS NOT NULL AND cache_key IS NOT NULL AND charged_input > 0) OR
    (state = 'complete' AND outcome_json IS NOT NULL)),
  PRIMARY KEY (generation_id, paper_id),
  UNIQUE (generation_id, ordinal)
);
CREATE INDEX IF NOT EXISTS summary_request_key ON summary_outcomes(cache_key);

CREATE TABLE IF NOT EXISTS source_papers (
  paper_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  metadata_json TEXT NOT NULL CHECK (length(CAST(metadata_json AS BLOB)) <= 1048576),
  metadata_hash TEXT NOT NULL,
  PRIMARY KEY (paper_id, version)
);
CREATE TABLE IF NOT EXISTS source_blobs (
  hash TEXT PRIMARY KEY,
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  chunk_count INTEGER NOT NULL CHECK (chunk_count >= 0),
  complete INTEGER NOT NULL DEFAULT 0 CHECK (complete IN (0, 1))
);
CREATE TABLE IF NOT EXISTS source_blob_chunks (
  hash TEXT NOT NULL REFERENCES source_blobs(hash),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  bytes BLOB NOT NULL CHECK (length(bytes) > 0 AND length(bytes) <= 262144),
  PRIMARY KEY (hash, ordinal)
);
-- Immutable outcomes separate cache identity from each generation's association.
CREATE TABLE IF NOT EXISTS source_texts (
  id TEXT PRIMARY KEY,
  paper_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  extractor TEXT NOT NULL,
  source_url TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('available', 'unavailable')),
  reason TEXT,
  html_hash TEXT REFERENCES source_blobs(hash),
  text_hash TEXT REFERENCES source_blobs(hash),
  complete INTEGER NOT NULL DEFAULT 0 CHECK (complete IN (0, 1)),
  CHECK ((status = 'available' AND html_hash IS NOT NULL AND text_hash IS NOT NULL)
    OR (status = 'unavailable' AND text_hash IS NULL AND reason IS NOT NULL)),
  UNIQUE (paper_id, version, extractor, id),
  FOREIGN KEY (paper_id, version) REFERENCES source_papers(paper_id, version)
);
CREATE TABLE IF NOT EXISTS source_text_cache (
  paper_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  extractor TEXT NOT NULL,
  text_id TEXT NOT NULL,
  PRIMARY KEY (paper_id, version, extractor),
  FOREIGN KEY (paper_id, version, extractor, text_id) REFERENCES source_texts(paper_id, version, extractor, id)
);
CREATE TABLE IF NOT EXISTS generation_text_refs (
  generation_id TEXT NOT NULL,
  paper_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  extractor TEXT NOT NULL,
  text_id TEXT NOT NULL,
  PRIMARY KEY (generation_id, paper_id, version, extractor),
  FOREIGN KEY (generation_id, paper_id, version) REFERENCES generation_paper_refs(generation_id, paper_id, version),
  FOREIGN KEY (paper_id, version, extractor, text_id) REFERENCES source_texts(paper_id, version, extractor, id)
);
