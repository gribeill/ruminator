import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { Batch } from './arxiv.ts';
import { createDigest, type Digest } from './digest.ts';

/** Node-specific boundary; core generation/rendering do not depend on this driver. */
export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  const version = db.prepare('PRAGMA user_version').get() as { user_version: number };
  const migrations = ['001_initial.sql', '002_download_cache.sql'];
  if (version.user_version > migrations.length) {
    db.close();
    throw new Error(`Unsupported database schema: ${version.user_version}`);
  }
  for (const file of migrations.slice(version.user_version)) {
    db.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
  }
  return db;
}

interface DigestRow {
  announcement_date: string;
  categories_json: string;
  papers_json: string;
  featured_ids_json: string;
}

function decode(row: DigestRow): Digest {
  return {
    date: row.announcement_date, categories: JSON.parse(row.categories_json),
    papers: JSON.parse(row.papers_json), featuredIds: JSON.parse(row.featured_ids_json),
  };
}

export function latestDigest(db: DatabaseSync, categories: string[]): Digest | undefined {
  const row = db.prepare(`SELECT * FROM digests WHERE categories_json = ?
    ORDER BY announcement_date DESC LIMIT 1`).get(JSON.stringify([...categories].sort())) as DigestRow | undefined;
  return row ? decode(row) : undefined;
}

export interface Download {
  batch: Batch;
  checkedAt: string;
}

/** Old batch snapshots also count as downloads when upgrading an existing DB. */
export function cachedDownload(db: DatabaseSync, category: string): Download | undefined {
  const cached = db.prepare('SELECT checked_at, batch_json FROM feed_downloads WHERE category = ?')
    .get(category) as { checked_at: string; batch_json: string } | undefined;
  if (cached) return { batch: JSON.parse(cached.batch_json), checkedAt: cached.checked_at };
  const old = db.prepare('SELECT * FROM batches WHERE category = ? ORDER BY fetched_at DESC LIMIT 1')
    .get(category) as { announcement_date: string; source_url: string; papers_json: string; fetched_at: string } | undefined;
  if (!old) return undefined;
  return {
    batch: { category, date: old.announcement_date, sourceUrl: old.source_url, papers: JSON.parse(old.papers_json) },
    checkedAt: old.fetched_at.replace(' ', 'T') + 'Z',
  };
}

export function saveDownload(db: DatabaseSync, download: Download): void {
  db.prepare(`INSERT INTO feed_downloads (category, checked_at, batch_json) VALUES (?, ?, ?)
    ON CONFLICT (category) DO UPDATE SET checked_at = excluded.checked_at, batch_json = excluded.batch_json`)
    .run(download.batch.category, download.checkedAt, JSON.stringify(download.batch));
}

/** Commit a whole snapshot; reruns never replace an already published digest. */
export function saveDigest(db: DatabaseSync, batches: Batch[]): Digest {
  db.exec('BEGIN');
  try {
    const saveBatch = db.prepare(`INSERT INTO batches
      (category, announcement_date, source_url, papers_json) VALUES (?, ?, ?, ?)
      ON CONFLICT (category, announcement_date) DO NOTHING`);
    for (const batch of batches) {
      saveBatch.run(batch.category, batch.date, batch.sourceUrl, JSON.stringify(batch.papers));
    }
    // Reuse the first downloaded source snapshot for new category combinations too.
    const savedBatches = batches.map(batch => {
      const row = db.prepare('SELECT papers_json FROM batches WHERE category = ? AND announcement_date = ?')
        .get(batch.category, batch.date) as { papers_json: string };
      return { ...batch, papers: JSON.parse(row.papers_json) };
    });
    const digest = createDigest(savedBatches);
    const categories = JSON.stringify(digest.categories);
    db.prepare(`INSERT INTO digests
      (announcement_date, categories_json, papers_json, featured_ids_json) VALUES (?, ?, ?, ?)
      ON CONFLICT (announcement_date, categories_json) DO NOTHING`).run(
      digest.date, categories, JSON.stringify(digest.papers), JSON.stringify(digest.featuredIds),
    );
    const row = db.prepare('SELECT * FROM digests WHERE announcement_date = ? AND categories_json = ?')
      .get(digest.date, categories) as unknown as DigestRow;
    db.exec('COMMIT');
    return decode(row);
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
