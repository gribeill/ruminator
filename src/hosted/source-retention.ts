// Copyright 2026 Guilhem Ribeill
// SPDX-License-Identifier: Apache-2.0

import type { D1Database } from '@cloudflare/workers-types';

// Internal SQL identifiers only. Frozen membership is indexed; no batch decoding
// or assumptions that one user's publication owns a shared source artifact.
export const listingNeeds = (paper: string, version: string) => `(
  EXISTS (SELECT 1 FROM generation_paper_refs p WHERE p.paper_id = ${paper} AND p.version = ${version}
    AND (EXISTS (SELECT 1 FROM working_generations w WHERE w.generation_id = p.generation_id)
      OR EXISTS (SELECT 1 FROM current_readings c WHERE c.listing_id = p.generation_id)))
  OR EXISTS (SELECT 1 FROM reading_papers p JOIN current_readings c ON c.listing_id = p.listing_id
    WHERE p.paper_id = ${paper} AND json_extract(p.paper_json, '$.version') = ${version}))`;
const blobUnused = (hash: string) => `NOT EXISTS (SELECT 1 FROM source_texts t WHERE t.html_hash = ${hash} OR t.text_hash = ${hash})`;

/** One bounded shared-cache cleanup page, called inside generation maintenance.
 * Every deletion rechecks reachability, including pins acquired after selection.
 */
export async function cleanupSourcePage(db: D1Database, cutoff: string): Promise<{ rowsDeleted: number; pending: boolean }> {
  let rowsDeleted = 0;
  const text = await db.prepare(`SELECT t.id FROM source_texts t
    WHERE NOT EXISTS (SELECT 1 FROM generation_text_refs r WHERE r.text_id = t.id)
      AND (NOT EXISTS (SELECT 1 FROM source_text_cache c WHERE c.text_id = t.id)
        OR NOT ${listingNeeds('t.paper_id', 't.version')}) LIMIT 1`).first<{ id: string }>();
  if (text) {
    const results = await db.batch([
      db.prepare(`DELETE FROM source_text_cache WHERE text_id = ?
        AND NOT EXISTS (SELECT 1 FROM generation_text_refs r WHERE r.text_id = source_text_cache.text_id)
        AND NOT ${listingNeeds('source_text_cache.paper_id', 'source_text_cache.version')}`).bind(text.id),
      db.prepare(`DELETE FROM source_texts WHERE id = ?
        AND NOT EXISTS (SELECT 1 FROM generation_text_refs r WHERE r.text_id = source_texts.id)
        AND NOT EXISTS (SELECT 1 FROM source_text_cache c WHERE c.text_id = source_texts.id)`).bind(text.id),
    ]);
    rowsDeleted += results.reduce((sum, r) => sum + r.meta.changes, 0);
  }
  const blob = await db.prepare(`SELECT b.hash FROM source_blobs b WHERE ${blobUnused('b.hash')} LIMIT 1`).first<{ hash: string }>();
  if (blob) {
    const results = await db.batch([
      db.prepare(`DELETE FROM source_blob_chunks WHERE hash = ? AND ordinal IN
        (SELECT ordinal FROM source_blob_chunks WHERE hash = ? LIMIT 64) AND ${blobUnused('source_blob_chunks.hash')}`).bind(blob.hash, blob.hash),
      db.prepare(`DELETE FROM source_blobs WHERE hash = ? AND ${blobUnused('source_blobs.hash')}
        AND NOT EXISTS (SELECT 1 FROM source_blob_chunks c WHERE c.hash = source_blobs.hash)`).bind(blob.hash),
    ]);
    rowsDeleted += results.reduce((sum, r) => sum + r.meta.changes, 0);
  }
  const metadata = await db.prepare(`DELETE FROM source_papers WHERE (paper_id, version) IN (
    SELECT s.paper_id, s.version FROM source_papers s WHERE NOT ${listingNeeds('s.paper_id', 's.version')}
      AND NOT EXISTS (SELECT 1 FROM user_votes v WHERE v.paper_id = s.paper_id AND v.value != 0 AND v.changed_at >= ?
        AND json_extract(CASE WHEN json_valid(v.paper_json) THEN v.paper_json ELSE '{}' END, '$.version') = s.version)
      AND NOT EXISTS (SELECT 1 FROM source_texts t WHERE t.paper_id = s.paper_id AND t.version = s.version) LIMIT 64)`)
    .bind(cutoff).run();
  rowsDeleted += metadata.meta.changes;
  return { rowsDeleted, pending: !!text || !!blob || metadata.meta.changes > 0 };
}
