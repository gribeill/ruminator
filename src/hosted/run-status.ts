// Copyright 2026 Guilhem Ribeill
// SPDX-License-Identifier: Apache-2.0

import type { D1Database } from '@cloudflare/workers-types';
import { escapeHtml } from '../math.ts';

/** Only the authenticated admin's own latest run, never another user's status.
 * Reading this message does not expire work or trigger execution.
 */
export async function adminRunStatus(db: D1Database, userId: string): Promise<string> {
  const row = await db.prepare(`SELECT r.run_date, r.generation_id, r.finished_at, r.failure_reason, r.last_success_at
    FROM users u LEFT JOIN generation_runs r ON r.user_id = u.id WHERE u.id = ? AND u.enabled = 1 AND u.role = 'admin'`)
    .bind(userId).first<{ run_date: string | null; generation_id: string | null; finished_at: string | null;
      failure_reason: string | null; last_success_at: string | null }>();
  if (!row) return '';
  const success = row.last_success_at
    ? `Last successful run: <time datetime="${escapeHtml(row.last_success_at)}">${escapeHtml(row.last_success_at)} (UTC)</time>.`
    : 'No successful hosted run has been recorded.';
  let latest = 'No daily run has been admitted yet.';
  if (row.run_date) {
    if (row.failure_reason) {
      const reasons: Record<string, string> = { preparation: 'input preparation failed', launch: 'Workflow launch failed or could not be confirmed',
        run: 'generation failed', deadline: 'the next weekday boundary was reached', waiting: 'shared-work waiting was exhausted', disabled: 'the account was disabled' };
      latest = `Latest run (${escapeHtml(row.run_date)}) encountered a failure: ${reasons[row.failure_reason] ?? 'generation failed'}. `
        + (row.finished_at ? 'The published reading, if any, is unchanged.' : 'It remains pending until intervention or the next weekday boundary.');
    } else if (!row.finished_at) latest = `Latest run (${escapeHtml(row.run_date)}) is pending or in progress; it has not succeeded yet.`;
    else if (!row.generation_id) latest = `Latest daily check (${escapeHtml(row.run_date)}) found no new posting batch.`;
    else latest = `Latest run (${escapeHtml(row.run_date)}) completed successfully.`;
  }
  const pass = await db.prepare('SELECT run_date, status FROM scheduled_pass WHERE singleton = 1')
    .first<{ run_date: string; status: string }>();
  const messages: Record<string, string> = { running: 'admission pass pending or interrupted; no automatic retry',
    complete: 'admission pass complete; individual generations finish independently',
    'feed-failed': 'feed ingestion failed; no users were admitted by this pass', failed: 'scheduled pass failed; no automatic retry' };
  const shared = pass ? `<p>Shared weekday check (${escapeHtml(pass.run_date)}): ${messages[pass.status] ?? 'unavailable'}.</p>` : '';
  return `<section aria-label="Generation status"><p>${success}</p><p>${latest}</p>${shared}</section>`;
}
