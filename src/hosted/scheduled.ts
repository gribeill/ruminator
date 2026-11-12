// Copyright 2026 Guilhem Ribeill
// SPDX-License-Identifier: Apache-2.0

import type { D1Database, Workflow } from '@cloudflare/workers-types';
import { fetchBatch, type Batch } from '../arxiv.ts';
import { parseConfig } from '../config-text.ts';
import { createDigest } from '../digest.ts';
import { HOSTED_BGE_FINGERPRINT } from './bge.ts';
import { easternRunDate, expireDailyRun, launchDailyGeneration, nextWeekdayBoundary, type GenerationReference } from './daily-runs.ts';

const easternTime = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York',
  weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/** Use the event's intended timestamp, never its delivery time. A future cron
 * can wake at 10:00 and 11:00 UTC weekdays; only one is 06:00 Eastern. */
export function scheduledRunDate(scheduledTime: number): string | undefined {
  if (!Number.isFinite(scheduledTime)) return undefined;
  const date = new Date(scheduledTime);
  if (!Number.isFinite(date.getTime())) return undefined;
  const parts = easternTime.formatToParts(date);
  const part = (type: string) => parts.find(p => p.type === type)?.value;
  if (['Sat', 'Sun'].includes(part('weekday')!) || part('hour') !== '06' || part('minute') !== '00') return undefined;
  return easternRunDate(date);
}

/** Internal authorized scheduler entry, NOT an HTTP endpoint or activation flag.
 * Production/preview do not wire this handler. An explicit feed transport and
 * generation binding are required; tests supply recorded feeds and fixture AI.
 * One small invited cohort, one pass, no recovery service or replacement jobs.
 */
export async function runScheduledPass(db: D1Database, workflow: Pick<Workflow<GenerationReference>, 'create'>,
  scheduledTime: number, fetcher: typeof fetch, clock: () => Date = () => new Date()) {
  const runDate = scheduledRunDate(scheduledTime), now = clock();
  if (!runDate || scheduledTime > now.getTime() || nextWeekdayBoundary(runDate) <= now.toISOString()) {
    return { status: 'ignored' as const };
  }
  const deadline = nextWeekdayBoundary(runDate);
  const claimed = await db.prepare(`INSERT INTO scheduled_pass (singleton, run_date, status) VALUES (1, ?, 'running')
    ON CONFLICT (singleton) DO UPDATE SET run_date = excluded.run_date, status = 'running'
    WHERE scheduled_pass.run_date < excluded.run_date`).bind(runDate).run();
  if (!claimed.meta.changes) return { status: 'duplicate' as const };
  const active = async () => clock().toISOString() < deadline && !!await db.prepare(
    "SELECT 1 FROM scheduled_pass WHERE singleton = 1 AND run_date = ? AND status = 'running'").bind(runDate).first();
  const finish = async (status: 'complete' | 'feed-failed' | 'failed') => {
    const result = await db.prepare("UPDATE scheduled_pass SET status = ? WHERE singleton = 1 AND run_date = ? AND status = 'running'")
      .bind(status, runDate).run();
    return { status: result.meta.changes ? status : 'stale' as const };
  };
  try {
    // Sweep BEFORE ingestion: a bad feed must not leave disabled owners' old
    // reservations working indefinitely. Each close rechecks its exact deadline.
    const expired = await db.prepare('SELECT user_id FROM generation_runs WHERE finished_at IS NULL AND deadline <= ?')
      .bind(now.toISOString()).all<{ user_id: string }>();
    for (const row of expired.results) await expireDailyRun(db, row.user_id, now);
    const users = await db.prepare('SELECT id FROM users WHERE enabled = 1 ORDER BY id').all<{ id: string }>();
    if (!users.results.length) return finish('complete');
    let batches: Batch[];
    try {
      const saved = await db.prepare('SELECT text FROM saved_config WHERE singleton = 1').first<{ text: string }>();
      if (!saved) throw new Error('Missing saved configuration');
      const categories = parseConfig(saved.text).ingestion.categories;
      batches = [];
      for (const category of categories) {
        if (!await active()) return { status: 'stale' as const };
        batches.push(await fetchBatch(category, (input, init) => fetcher(input, { ...init, redirect: 'error' })));
      }
      const digest = createDigest(batches); // Reject mixed dates; legitimate empty feeds are valid.
      const latest = await db.prepare(`SELECT max(date) AS date FROM (
        SELECT batch_date AS date FROM scheduled_pass WHERE singleton = 1
        UNION ALL SELECT json_extract(p.metadata_json, '$.date') FROM current_readings c
          JOIN reading_listings p ON p.id = c.listing_id)`).first<{ date: string | null }>();
      if (digest.date > runDate || (latest?.date && digest.date < latest.date)) throw new Error('Regressed or future announcement date');
      if (!await active()) return { status: 'stale' as const };
      await db.prepare("UPDATE scheduled_pass SET batch_date = ? WHERE singleton = 1 AND run_date = ? AND status = 'running'")
        .bind(digest.date, runDate).run();
    } catch { return finish('feed-failed'); }

    const counts = { launched: 0, unchanged: 0, skipped: 0, failed: 0 };
    for (const user of users.results) {
      if (!await active()) return { status: 'stale' as const, ...counts };
      try {
        // Admission independently rechecks enabled state, work slot, daily date
        // and deadline. Settings/votes are frozen per user at admission time.
        const result = await launchDailyGeneration(db, workflow, user.id, batches, HOSTED_BGE_FINGERPRINT,
          { summariesRequested: true, now: clock(), runDate });
        if (result.status === 'launched') counts.launched++;
        else if (result.status === 'unchanged') counts.unchanged++;
        else if (result.status === 'not-admitted' || result.status === 'stale') counts.skipped++;
        else counts.failed++;
      } catch { counts.failed++; } // One user's admission failure does not stop the cohort.
    }
    return { ...await finish('complete'), ...counts };
  } catch { return finish('failed'); }
}
