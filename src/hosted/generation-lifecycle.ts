// Copyright 2026 Guilhem Ribeill
// SPDX-License-Identifier: Apache-2.0

import type { D1Database } from '@cloudflare/workers-types';

export type RunFailure = 'preparation' | 'launch' | 'run' | 'deadline' | 'waiting' | 'disabled';

/** One failure transaction for execution and trusted daily lifecycle work.
 * Ordinary callers require an enabled owner and working slot. The daily path
 * instead requires the exact unfinished reservation, including disabled owners
 * or a process lost before snapshot creation. Neither path refunds claims.
 */
export async function failGeneration(db: D1Database, userId: string, generationId: string,
  options: { reason?: RunFailure; daily?: { cutoff?: string } } = {}): Promise<boolean> {
  const reason = options.reason ?? 'run';
  const eligible = options.daily
    ? `SELECT 1 FROM generation_runs r WHERE r.user_id = ? AND r.generation_id = ?
        AND r.finished_at IS NULL AND (? IS NULL OR r.deadline <= ?)`
    : `SELECT 1 FROM working_generations w JOIN users u ON u.id = w.user_id
        WHERE w.user_id = ? AND w.generation_id = ? AND u.enabled = 1`;
  const args = options.daily
    ? [userId, generationId, options.daily.cutoff ?? null, options.daily.cutoff ?? null]
    : [userId, generationId];
  const results = await db.batch([
    db.prepare(`UPDATE generation_inputs SET state = 'failed' WHERE id = ? AND user_id = ?
      AND state IN ('working', 'staging', 'ready') AND EXISTS (${eligible})`)
      .bind(generationId, userId, ...args),
    db.prepare(`UPDATE generation_runs SET finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      failure_reason = CASE WHEN ? = 'deadline' OR deadline <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        THEN 'deadline' ELSE coalesce(failure_reason, ?) END
      WHERE user_id = ? AND generation_id = ? AND finished_at IS NULL
        AND EXISTS (${eligible})
        AND NOT EXISTS (SELECT 1 FROM generation_inputs g WHERE g.id = generation_runs.generation_id AND g.state = 'published')`)
      .bind(reason, reason, userId, generationId, ...args),
    db.prepare(`DELETE FROM working_generations WHERE user_id = ? AND generation_id = ?
      AND EXISTS (SELECT 1 FROM generation_inputs g WHERE g.id = working_generations.generation_id AND g.state = 'failed')`)
      .bind(userId, generationId),
  ]);
  return results[0].meta.changes === 1;
}
