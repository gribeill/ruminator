import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { Batch } from './arxiv.ts';
import { createDigest, type Digest } from './digest.ts';
import type { SemanticScores } from './scoring.ts';
import type { Ranking } from './ranking.ts';

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
  return { ...digest, ...(semantic ? { semantic } : {}), ...(ranking ? { ranking } : {}) };
}

export function saveSemanticScores(db: DatabaseSync, digest: Digest, scores: SemanticScores): SemanticScores {
  db.prepare(`INSERT INTO semantic_scores (announcement_date, categories_json, scores_json) VALUES (?, ?, ?)
    ON CONFLICT DO NOTHING`).run(digest.date, JSON.stringify([...digest.categories].sort()), JSON.stringify(scores));
  return readSemanticScores(db, digest)!;
}

/** Save an immutable digest; canonical source archives stay in the paper DB. */
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

/** Archive the first source snapshot and update freshness atomically. */
export function saveDownload(db: DatabaseSync, { batch, checkedAt }: Download): void {
  db.exec('BEGIN');
  try {
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

/** Rebuild application state from the latest announcement shared by all categories. */
export function latestBatches(db: DatabaseSync, categories: string[]): Batch[] {
  const unique = [...new Set(categories)].sort();
  if (!unique.length) return [];
  const placeholders = unique.map(() => '?').join(',');
  const row = db.prepare(`SELECT announcement_date FROM batches WHERE category IN (${placeholders})
    GROUP BY announcement_date HAVING COUNT(*) = ? ORDER BY announcement_date DESC LIMIT 1`)
    .get(...unique, unique.length) as { announcement_date: string } | undefined;
  return row ? unique.map(category => archivedBatch(db, category, row.announcement_date)!) : [];
}
