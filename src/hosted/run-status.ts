// Copyright 2026 Guilhem Ribeill
// SPDX-License-Identifier: Apache-2.0

import type { D1Database } from '@cloudflare/workers-types';
import { escapeHtml } from '../math.ts';
import { uiText, uiHtml } from '../ui-text.ts';

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
    ? `${uiHtml('status.last_success')} <time datetime="${escapeHtml(row.last_success_at)}">${uiHtml('status.utc_time', { time: row.last_success_at })}</time>.`
    : uiHtml('status.no_success');
  let latest = uiText('status.no_run');
  if (row.run_date) {
    if (row.failure_reason) {
      const reasons: Record<string, string> = { preparation: 'status.preparation', launch: 'status.launch',
        run: 'status.run', deadline: 'status.deadline', waiting: 'status.waiting', disabled: 'status.disabled' };
      latest = uiText('status.failure', { date: row.run_date, reason: uiText(reasons[row.failure_reason] ?? 'status.run') }) + ' '
        + uiText(row.finished_at ? 'status.preserved' : 'status.intervention');
    } else if (!row.finished_at) latest = uiText('status.pending', { date: row.run_date });
    else if (!row.generation_id) latest = uiText('status.unchanged', { date: row.run_date });
    else latest = uiText('status.completed', { date: row.run_date });
  }
  const pass = await db.prepare('SELECT run_date, status FROM scheduled_pass WHERE singleton = 1')
    .first<{ run_date: string; status: string }>();
  const messages: Record<string, string> = { running: 'status.shared_running', complete: 'status.shared_complete',
    'feed-failed': 'status.shared_feed_failed', failed: 'status.shared_failed' };
  const shared = pass ? `<p>${uiHtml('status.shared', { date: pass.run_date, message: uiText(messages[pass.status] ?? 'status.unavailable') })}</p>` : '';
  return `<section aria-label="${uiHtml('status.label')}"><p>${success}</p><p>${escapeHtml(latest)}</p>${shared}</section>`;
}
