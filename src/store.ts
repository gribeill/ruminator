import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { Batch } from './arxiv.ts';
import { createDigest, type Digest } from './digest.ts';
import type { SemanticScores } from './scoring.ts';

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
  return semantic ? { ...digest, semantic } : digest;
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
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function archivedBatch(db: DatabaseSync, category: string, date: string): Batch | undefined {
  const row = db.prepare('SELECT source_url, papers_json FROM batches WHERE category = ? AND announcement_date = ?')
    .get(category, date) as { source_url: string; papers_json: string } | undefined;
  return row ? { category, date, sourceUrl: row.source_url, papers: JSON.parse(row.papers_json) } : undefined;
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
