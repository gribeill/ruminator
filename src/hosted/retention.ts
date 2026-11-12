// Copyright 2026 Guilhem Ribeill
// SPDX-License-Identifier: Apache-2.0

import type { D1Database } from '@cloudflare/workers-types';
import { cleanupSourcePage } from './source-retention.ts';
import { cleanupInferencePage } from './inference-retention.ts';

export function voteCutoff(now = new Date()): string {
  return new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000).toISOString();
}

/** SQL-only reference checks are repeated inside every destructive statement.
 * column is an internal SQL identifier, never user input.
 */
const unreferenced = (column: string) => `
  NOT EXISTS (SELECT 1 FROM current_readings c WHERE c.listing_id = ${column})
  AND NOT EXISTS (SELECT 1 FROM working_generations w WHERE w.generation_id = ${column})`;

export interface CleanupResult { rowsDeleted: number; complete: boolean }

/** Internal generation maintenance, never a page-request operation. A small
 * fixed work budget bounds D1 cost; an interrupted/incomplete sweep resumes by
 * calling again. No reader leases or grace period: readers validate and retry.
 * Users/configuration and every current/working artifact remain untouched.
 */
export async function cleanupHostedState(db: D1Database, now = new Date(), maxPasses = 32): Promise<CleanupResult> {
  if (!Number.isSafeInteger(maxPasses) || maxPasses < 1 || maxPasses > 32) throw new Error('Expected 1–32 cleanup passes');
  const cutoff = voteCutoff(now);
  let rowsDeleted = 0;
  for (let pass = 0; pass < maxPasses; pass++) {
    const expired = await db.batch([
      db.prepare(`DELETE FROM user_votes WHERE (user_id, paper_id) IN
        (SELECT user_id, paper_id FROM user_votes WHERE value = 0 OR changed_at < ? LIMIT 64)`)
        .bind(cutoff),
      // ON DELETE CASCADE also removes private example vectors, not scientific output.
      db.prepare(`DELETE FROM generation_input_votes WHERE (generation_id, paper_id) IN
        (SELECT generation_id, paper_id FROM generation_input_votes WHERE changed_at < ? LIMIT 64)`)
        .bind(cutoff),
    ]);
    const expiredCount = expired.reduce((sum, result) => sum + result.meta.changes, 0);
    rowsDeleted += expiredCount;
    const candidate = await db.prepare(`SELECT r.id FROM reading_listings r WHERE ${unreferenced('r.id')}
      UNION SELECT g.id FROM generation_inputs g WHERE ${unreferenced('g.id')} LIMIT 1`).first<{ id: string }>();
    if (candidate) {
      const id = candidate.id;
      const deleted = await db.batch([
      db.prepare(`DELETE FROM reading_papers WHERE listing_id = ? AND ordinal IN
        (SELECT ordinal FROM reading_papers WHERE listing_id = ? LIMIT 64)
        AND ${unreferenced('reading_papers.listing_id')}`).bind(id, id),
      db.prepare(`DELETE FROM reading_listings WHERE id = ? AND ${unreferenced('reading_listings.id')}
        AND NOT EXISTS (SELECT 1 FROM reading_papers p WHERE p.listing_id = reading_listings.id)`).bind(id),
      db.prepare(`DELETE FROM generation_batch_chunks WHERE generation_id = ? AND ordinal IN
        (SELECT ordinal FROM generation_batch_chunks WHERE generation_id = ? LIMIT 64)
        AND ${unreferenced('generation_batch_chunks.generation_id')}`).bind(id, id),
      db.prepare(`DELETE FROM generation_input_votes WHERE generation_id = ? AND paper_id IN
        (SELECT paper_id FROM generation_input_votes WHERE generation_id = ? LIMIT 64)
        AND ${unreferenced('generation_input_votes.generation_id')}`).bind(id, id),
      db.prepare(`DELETE FROM generation_text_refs WHERE generation_id = ? AND (paper_id, version, extractor) IN
        (SELECT paper_id, version, extractor FROM generation_text_refs WHERE generation_id = ? LIMIT 64)
        AND ${unreferenced('generation_text_refs.generation_id')}`).bind(id, id),
      db.prepare(`DELETE FROM generation_paper_refs WHERE generation_id = ? AND (paper_id, version) IN
        (SELECT paper_id, version FROM generation_paper_refs WHERE generation_id = ? LIMIT 64)
        AND ${unreferenced('generation_paper_refs.generation_id')}
        AND NOT EXISTS (SELECT 1 FROM generation_text_refs r WHERE r.generation_id = generation_paper_refs.generation_id
          AND r.paper_id = generation_paper_refs.paper_id AND r.version = generation_paper_refs.version)`).bind(id, id),
      db.prepare(`DELETE FROM generation_profile_vectors WHERE generation_id = ? AND profile_id IN
        (SELECT profile_id FROM generation_profile_vectors WHERE generation_id = ? LIMIT 64)
        AND ${unreferenced('generation_profile_vectors.generation_id')}`).bind(id, id),
      db.prepare(`DELETE FROM summary_outcomes WHERE generation_id = ?
        AND ${unreferenced('summary_outcomes.generation_id')}`).bind(id),
      db.prepare(`DELETE FROM embedding_requests WHERE generation_id = ? AND request_key IN
        (SELECT request_key FROM embedding_requests WHERE generation_id = ? LIMIT 64)
        AND ${unreferenced('embedding_requests.generation_id')}`).bind(id, id),
      db.prepare(`DELETE FROM generation_inputs WHERE id = ? AND ${unreferenced('generation_inputs.id')}
        AND NOT EXISTS (SELECT 1 FROM reading_listings r WHERE r.id = generation_inputs.id)
        AND NOT EXISTS (SELECT 1 FROM generation_batch_chunks b WHERE b.generation_id = generation_inputs.id)
        AND NOT EXISTS (SELECT 1 FROM generation_input_votes v WHERE v.generation_id = generation_inputs.id)
        AND NOT EXISTS (SELECT 1 FROM generation_paper_refs p WHERE p.generation_id = generation_inputs.id)
        AND NOT EXISTS (SELECT 1 FROM generation_profile_vectors p WHERE p.generation_id = generation_inputs.id)
        AND NOT EXISTS (SELECT 1 FROM summary_outcomes o WHERE o.generation_id = generation_inputs.id)
        AND NOT EXISTS (SELECT 1 FROM embedding_requests e WHERE e.generation_id = generation_inputs.id)`).bind(id),
      ]);
      rowsDeleted += deleted.reduce((sum, result) => sum + result.meta.changes, 0);
    }
    const source = await cleanupSourcePage(db, cutoff);
    rowsDeleted += source.rowsDeleted;
    const inference = await cleanupInferencePage(db, cutoff);
    rowsDeleted += inference;
    if (!candidate && !expiredCount && !source.pending && !inference) return { rowsDeleted, complete: true };
  }
  return { rowsDeleted, complete: false };
}
