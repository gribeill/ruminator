import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { Batch, Paper } from './arxiv.ts';
import type { FeedbackConfig, FeedbackInput, VotedPaper, Votes, VoteValue } from './feedback.ts';
import { createDigest, type Digest } from './digest.ts';
import type { SemanticScores } from './scoring.ts';
import type { Ranking } from './ranking.ts';
import type { CachedPaperText } from './fulltext.ts';
import type { PaperSummary, SummaryConfig } from './summaries.ts';

function openDatabase(path: string, schema: 'app' | 'papers'): DatabaseSync {
  const db = new DatabaseSync(path);
  try {
    // Initialize the current schema only. Development databases are not upgraded.
    db.exec(readFileSync(new URL(`../schema/${schema}.sql`, import.meta.url), 'utf8'));
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function openAppDatabase(path: string): DatabaseSync {
  return openDatabase(path, 'app');
}

export function openPaperDatabase(path: string): DatabaseSync {
  return openDatabase(path, 'papers');
}

interface VoteRow {
  event_id: number;
  arxiv_id: string;
  value: -1 | 1;
  paper_json: string;
  created_at: string;
}

function activeVoteRows(db: DatabaseSync): VoteRow[] {
  return db.prepare(`SELECT * FROM vote_events WHERE event_id IN
    (SELECT MAX(event_id) FROM vote_events GROUP BY arxiv_id) AND value != 0 ORDER BY event_id`).all() as unknown as VoteRow[];
}

export function readVotes(db: DatabaseSync): Votes {
  return Object.fromEntries(activeVoteRows(db).map(row => [row.arxiv_id, row.value]));
}

/** Explicit desired state makes form resubmissions idempotent; never mutate old events. */
export function saveVote(db: DatabaseSync, paper: Paper, value: VoteValue): void {
  if (![-1, 0, 1].includes(value) || !/^(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})$/.test(paper.id)) {
    throw new Error('Invalid vote or base arXiv ID');
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    const current = db.prepare('SELECT value FROM vote_events WHERE arxiv_id = ? ORDER BY event_id DESC LIMIT 1')
      .get(paper.id) as { value: VoteValue } | undefined;
    if ((current?.value ?? 0) !== value) {
      db.prepare('INSERT INTO vote_events (arxiv_id, value, paper_json, created_at) VALUES (?, ?, ?, ?)')
        .run(paper.id, value, JSON.stringify(paper), new Date().toISOString());
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

/** Freeze feedback once, before inference: votes arriving mid-run belong to later digests. */
export function captureFeedback(db: DatabaseSync, digest: Digest, config: FeedbackConfig): FeedbackInput {
  db.exec('BEGIN IMMEDIATE');
  try {
    const previous = db.prepare('SELECT snapshot_json FROM feedback_snapshots WHERE announcement_date = ? AND categories_json = ?')
      .get(...digestKey(digest)) as { snapshot_json: string } | undefined;
    let snapshot: FeedbackInput;
    if (previous) snapshot = JSON.parse(previous.snapshot_json);
    else {
      const votes: VotedPaper[] = activeVoteRows(db).map(row => ({
        eventId: row.event_id, paper: JSON.parse(row.paper_json), value: row.value, createdAt: row.created_at,
      }));
      snapshot = { capturedAt: new Date().toISOString(), config: { ...config }, votes };
      db.prepare('INSERT INTO feedback_snapshots (announcement_date, categories_json, snapshot_json) VALUES (?, ?, ?)')
        .run(...digestKey(digest), JSON.stringify(snapshot));
    }
    db.exec('COMMIT');
    return snapshot;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

/** Paper-version HTML/text caches survive application DB resets. */
export function readPaperText(db: DatabaseSync, paper: { id: string; version: number }): CachedPaperText | undefined {
  const row = db.prepare('SELECT html, result_json FROM paper_texts WHERE arxiv_id = ? AND version = ?')
    .get(paper.id, paper.version) as { html: string | null; result_json: string } | undefined;
  return row ? { html: row.html, result: JSON.parse(row.result_json) } : undefined;
}

export function savePaperText(db: DatabaseSync, record: CachedPaperText): void {
  db.prepare(`INSERT INTO paper_texts (arxiv_id, version, html, result_json) VALUES (?, ?, ?, ?)
    ON CONFLICT (arxiv_id, version) DO UPDATE SET html = excluded.html, result_json = excluded.result_json`)
    .run(record.result.paperId, record.result.version, record.html, JSON.stringify(record.result));
}

/** Destructive opt-in reset for the CLI only; normal generation never calls this. */
export function clearSummaries(db: DatabaseSync): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec('DELETE FROM digest_summaries; DELETE FROM summary_cache; DELETE FROM summary_runs;');
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

export interface SummaryRun {
  config: SummaryConfig;
  usedInputTokens: number;
  budgetExhausted: boolean;
}

function digestKey(digest: Digest): [string, string] {
  return [digest.date, JSON.stringify([...digest.categories].sort())];
}

function readSummaryRun(db: DatabaseSync, digest: Digest): SummaryRun {
  const row = db.prepare('SELECT * FROM summary_runs WHERE announcement_date = ? AND categories_json = ?')
    .get(...digestKey(digest)) as { config_json: string; used_input_tokens: number; budget_exhausted: number };
  return { config: JSON.parse(row.config_json), usedInputTokens: row.used_input_tokens, budgetExhausted: !!row.budget_exhausted };
}

/** Refresh settings for this explicit invocation, retaining spent tokens and outcomes. */
export function startSummaryRun(db: DatabaseSync, digest: Digest, config: SummaryConfig): SummaryRun {
  // Explicit fields keep credentials and unrelated configuration out of snapshots.
  const snapshot = { llm: config.llm, tokenizer: config.tokenizer, summaries: config.summaries };
  db.prepare(`INSERT INTO summary_runs (announcement_date, categories_json, config_json) VALUES (?, ?, ?)
    ON CONFLICT (announcement_date, categories_json) DO UPDATE SET
      budget_exhausted = CASE
        WHEN json_extract(excluded.config_json, '$.summaries.run_input_tokens') > json_extract(summary_runs.config_json, '$.summaries.run_input_tokens')
        THEN 0 ELSE summary_runs.budget_exhausted END,
      config_json = excluded.config_json`).run(...digestKey(digest), JSON.stringify(snapshot));
  return readSummaryRun(db, digest);
}

export function readSummaries(db: DatabaseSync, digest: Digest): Record<string, PaperSummary> {
  const rows = db.prepare('SELECT arxiv_id, result_json FROM digest_summaries WHERE announcement_date = ? AND categories_json = ?')
    .all(...digestKey(digest)) as { arxiv_id: string; result_json: string }[];
  return Object.fromEntries(rows.map(row => [row.arxiv_id, JSON.parse(row.result_json)]));
}

export function readSummaryCache(db: DatabaseSync, key: string): PaperSummary | undefined {
  const row = db.prepare('SELECT result_json FROM summary_cache WHERE cache_key = ?').get(key) as { result_json: string } | undefined;
  return row ? JSON.parse(row.result_json) : undefined;
}

/** Claim once and reserve input atomically; resumption never repeats a paid attempt.
 * HTML-unavailable outcomes are preconditions, not attempts, and may be replaced
 * when a later manual summarize invocation finds usable cached text.
 */
export function claimSummary(db: DatabaseSync, digest: Digest, result: PaperSummary, inputTokens: number): boolean {
  db.exec('BEGIN IMMEDIATE');
  try {
    const previous = readSummaries(db, digest)[result.paperId];
    if (previous && (previous.status !== 'html_unavailable' || result.status === 'html_unavailable')) {
      db.exec('COMMIT'); return false;
    }
    const run = readSummaryRun(db, digest);
    let claimed = true;
    if (inputTokens > 0 && (run.budgetExhausted || inputTokens > run.config.summaries.run_input_tokens - run.usedInputTokens)) {
      result = { ...result, status: 'token_budget', detail: 'Run input allowance exhausted; no retry' };
      db.prepare('UPDATE summary_runs SET budget_exhausted = 1 WHERE announcement_date = ? AND categories_json = ?')
        .run(...digestKey(digest));
      claimed = false;
    } else if (inputTokens > 0) {
      db.prepare('UPDATE summary_runs SET used_input_tokens = used_input_tokens + ? WHERE announcement_date = ? AND categories_json = ?')
        .run(inputTokens, ...digestKey(digest));
    }
    db.prepare(`INSERT INTO digest_summaries (announcement_date, categories_json, arxiv_id, result_json) VALUES (?, ?, ?, ?)
      ON CONFLICT (announcement_date, categories_json, arxiv_id) DO UPDATE SET result_json = excluded.result_json`)
      .run(...digestKey(digest), result.paperId, JSON.stringify(result));
    db.exec('COMMIT');
    return claimed;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

/** Only the process that claimed a request completes it; readers see its stored outcome. */
export function completeSummary(db: DatabaseSync, digest: Digest, result: PaperSummary): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('UPDATE digest_summaries SET result_json = ? WHERE announcement_date = ? AND categories_json = ? AND arxiv_id = ?')
      .run(JSON.stringify(result), ...digestKey(digest), result.paperId);
    if (result.status === 'available' && result.cacheKey) {
      db.prepare('INSERT INTO summary_cache (cache_key, result_json) VALUES (?, ?) ON CONFLICT DO NOTHING')
        .run(result.cacheKey, JSON.stringify(result));
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

interface DigestRow {
  announcement_date: string;
  categories_json: string;
  papers_json: string;
  featured_ids_json: string;
}

function decodeDigest(row: DigestRow): Digest {
  return {
    date: row.announcement_date, categories: JSON.parse(row.categories_json),
    papers: JSON.parse(row.papers_json), featuredIds: JSON.parse(row.featured_ids_json),
  };
}

export function readDigest(db: DatabaseSync, date: string, categories: string[]): Digest | undefined {
  const row = db.prepare('SELECT * FROM digests WHERE announcement_date = ? AND categories_json = ?')
    .get(date, JSON.stringify([...categories].sort())) as DigestRow | undefined;
  return row ? withScores(db, decodeDigest(row)) : undefined;
}

export function latestDigest(db: DatabaseSync, categories: string[]): Digest | undefined {
  const row = db.prepare(`SELECT * FROM digests WHERE categories_json = ?
    ORDER BY announcement_date DESC LIMIT 1`).get(JSON.stringify([...categories].sort())) as DigestRow | undefined;
  return row ? withScores(db, decodeDigest(row)) : undefined;
}

export function readSemanticScores(db: DatabaseSync, digest: Digest): SemanticScores | undefined {
  const row = db.prepare('SELECT scores_json FROM semantic_scores WHERE announcement_date = ? AND categories_json = ?')
    .get(digest.date, JSON.stringify([...digest.categories].sort())) as { scores_json: string } | undefined;
  return row ? JSON.parse(row.scores_json) : undefined;
}

function withScores(db: DatabaseSync, digest: Digest): Digest {
  const semantic = readSemanticScores(db, digest);
  const ranking = readRanking(db, digest);
  const summaries = readSummaries(db, digest);
  return { ...digest, ...(semantic ? { semantic } : {}), ...(ranking ? { ranking } : {}),
    ...(Object.keys(summaries).length ? { summaries } : {}) };
}

export function saveSemanticScores(db: DatabaseSync, digest: Digest, scores: SemanticScores): SemanticScores {
  db.prepare(`INSERT INTO semantic_scores (announcement_date, categories_json, scores_json) VALUES (?, ?, ?)
    ON CONFLICT DO NOTHING`).run(digest.date, JSON.stringify([...digest.categories].sort()), JSON.stringify(scores));
  return readSemanticScores(db, digest)!;
}

/** Persist working membership; the listing lifecycle keeps only one working batch. */
export function saveDigest(db: DatabaseSync, batches: Batch[]): Digest {
  const digest = createDigest(batches);
  const categories = JSON.stringify(digest.categories);
  db.prepare(`INSERT INTO digests
    (announcement_date, categories_json, papers_json, featured_ids_json) VALUES (?, ?, ?, ?)
    ON CONFLICT (announcement_date, categories_json) DO NOTHING`).run(
    digest.date, categories, JSON.stringify(digest.papers), JSON.stringify(digest.featuredIds),
  );
  const row = db.prepare('SELECT * FROM digests WHERE announcement_date = ? AND categories_json = ?')
    .get(digest.date, categories) as unknown as DigestRow;
  return withScores(db, decodeDigest(row));
}

export function readRanking(db: DatabaseSync, digest: Digest): Ranking | undefined {
  const row = db.prepare('SELECT ranking_json FROM rankings WHERE announcement_date = ? AND categories_json = ?')
    .get(digest.date, JSON.stringify([...digest.categories].sort())) as { ranking_json: string } | undefined;
  return row ? JSON.parse(row.ranking_json) : undefined;
}

export function saveRanking(db: DatabaseSync, digest: Digest, ranking: Ranking): Ranking {
  db.prepare(`INSERT INTO rankings (announcement_date, categories_json, ranking_json) VALUES (?, ?, ?)
    ON CONFLICT DO NOTHING`).run(digest.date, JSON.stringify([...digest.categories].sort()), JSON.stringify(ranking));
  return readRanking(db, digest)!;
}

export interface Download {
  batch: Batch;
  checkedAt: string;
}

export function cachedDownload(db: DatabaseSync, category: string): Download | undefined {
  const row = db.prepare('SELECT checked_at, batch_json FROM feed_downloads WHERE category = ?')
    .get(category) as { checked_at: string; batch_json: string } | undefined;
  return row ? { batch: JSON.parse(row.batch_json), checkedAt: row.checked_at } : undefined;
}

/** Keep the current source snapshot per category and update freshness atomically. */
export function saveDownload(db: DatabaseSync, { batch, checkedAt }: Download): void {
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM batches WHERE category = ? AND announcement_date != ?').run(batch.category, batch.date);
    db.prepare(`INSERT INTO batches (category, announcement_date, source_url, papers_json, fetched_at)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT (category, announcement_date) DO NOTHING`)
      .run(batch.category, batch.date, batch.sourceUrl, JSON.stringify(batch.papers), checkedAt);
    db.prepare(`INSERT INTO feed_downloads (category, checked_at, batch_json) VALUES (?, ?, ?)
      ON CONFLICT (category) DO UPDATE SET checked_at = excluded.checked_at, batch_json = excluded.batch_json`)
      .run(batch.category, checkedAt, JSON.stringify(batch));
    const authors = db.prepare(`INSERT INTO paper_authors (arxiv_id, version, names_json) VALUES (?, ?, ?)
      ON CONFLICT (arxiv_id, version) DO UPDATE SET names_json = excluded.names_json`);
    for (const paper of batch.papers) {
      if (paper.authors?.length) authors.run(paper.id, paper.version, JSON.stringify(paper.authors));
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function archivedBatch(db: DatabaseSync, category: string, date: string): Batch | undefined {
  const row = db.prepare('SELECT source_url, papers_json FROM batches WHERE category = ? AND announcement_date = ?')
    .get(category, date) as { source_url: string; papers_json: string } | undefined;
  if (!row) return undefined;
  const authors = db.prepare('SELECT names_json FROM paper_authors WHERE arxiv_id = ? AND version = ?');
  const papers: Batch['papers'] = JSON.parse(row.papers_json);
  for (const paper of papers) {
    const names = authors.get(paper.id, paper.version) as { names_json: string } | undefined;
    if (names) paper.authors = JSON.parse(names.names_json);
  }
  return { category, date, sourceUrl: row.source_url, papers };
}
