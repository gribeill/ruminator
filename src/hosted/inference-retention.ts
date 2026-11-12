// Copyright 2026 Guilhem Ribeill
// SPDX-License-Identifier: Apache-2.0

import type { D1Database } from '@cloudflare/workers-types';
import { listingNeeds } from './source-retention.ts';

/** Conservative paper/version retention avoids a second artifact-reference
 * graph: retain compatible-key variants while that scientific paper is needed.
 * Private profile rows are cleaned with their owning generation instead.
 */
export async function cleanupInferencePage(db: D1Database, cutoff: string): Promise<number> {
  const results = await db.batch([
    db.prepare(`DELETE FROM summary_cache WHERE cache_key IN (SELECT s.cache_key FROM summary_cache s
      WHERE NOT ${listingNeeds('s.paper_id', 's.version')} LIMIT 64)`),
    db.prepare(`DELETE FROM paper_vectors WHERE rowid IN (SELECT s.rowid FROM paper_vectors s
      WHERE NOT ${listingNeeds('s.paper_id', 's.version')}
        AND NOT EXISTS (SELECT 1 FROM user_votes v WHERE v.paper_id = s.paper_id AND v.value != 0 AND v.changed_at >= ?
          AND json_extract(CASE WHEN json_valid(v.paper_json) THEN v.paper_json ELSE '{}' END, '$.version') = s.version)
        AND NOT EXISTS (SELECT 1 FROM generation_input_votes v WHERE v.paper_id = s.paper_id AND v.changed_at >= ?
          AND json_extract(v.paper_json, '$.version') = s.version
          AND (EXISTS (SELECT 1 FROM working_generations w WHERE w.generation_id = v.generation_id)
            OR EXISTS (SELECT 1 FROM current_readings c WHERE c.listing_id = v.generation_id))) LIMIT 64)`)
      .bind(cutoff, cutoff),
  ]);
  return results.reduce((sum, r) => sum + r.meta.changes, 0);
}
