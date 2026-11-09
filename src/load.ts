import type { DatabaseSync } from 'node:sqlite';
import { fetchBatch, type Batch } from './arxiv.ts';
import { cachedDownload, saveDigest, saveDownload } from './store.ts';
import type { Digest } from './digest.ts';

/** Use arXiv's timezone for download freshness, independently of batch dates. */
export function downloadDay(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

interface LoadOptions {
  refresh?: boolean;
  now?: Date;
  download?: (category: string) => Promise<Batch>;
  log?: (message: string) => void;
}

/** Cache each category once per day, including across different category sets. */
export async function loadDailyDigest(db: DatabaseSync, categories: string[], {
  refresh = false, now = new Date(), download = fetchBatch, log = console.log,
}: LoadOptions = {}): Promise<Digest> {
  const batches: Batch[] = [];
  for (const category of categories) {
    const cached = cachedDownload(db, category);
    if (!refresh && cached && downloadDay(new Date(cached.checkedAt)) === downloadDay(now)) {
      log(`Using cached ${category} announcements (batch ${cached.batch.date}).`);
      batches.push(cached.batch);
      continue;
    }
    // Fetch serially and persist successful downloads even if a later feed fails.
    log(`Downloading ${category} announcements…`);
    const batch = await download(category);
    saveDownload(db, { batch, checkedAt: now.toISOString() });
    batches.push(batch);
  }
  return saveDigest(db, batches);
}
