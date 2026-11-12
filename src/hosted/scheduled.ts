// Copyright 2026 Guilhem Ribeill
// SPDX-License-Identifier: Apache-2.0

import type { D1Database, Workflow } from '@cloudflare/workers-types';
import { fetchBatch, type Batch } from '../arxiv.ts';
import { parseConfig } from '../config-text.ts';
import { createDigest } from '../digest.ts';
import { HOSTED_BGE_FINGERPRINT } from './bge.ts';
import { readGenerationInputs } from './generation-inputs.ts';
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
 * Production activation is gated by scheduledExecution. An explicit feed transport and
 * generation binding are required; tests supply recorded feeds and fixture AI.
 * One small invited cohort, one pass, no recovery service or replacement jobs.
 */
export async function runScheduledPass(db: D1Database, workflow: Pick<Workflow<GenerationReference>, 'create'>,
  scheduledTime: number, fetcher: typeof fetch, clock: () => Date = () => new Date()) {
  const runDate = scheduledRunDate(scheduledTime), now = clock();
  if (!runDate || scheduledTime > now.getTime() || nextWeekdayBoundary(runDate) <= now.toISOString()) {
    return { status: 'ignored' as const };
  }
  const attemptId = crypto.randomUUID();
  const claimed = await db.prepare(`INSERT INTO scheduled_pass (singleton, run_date, status, attempt_id) VALUES (1, ?, 'running', ?)
    ON CONFLICT (singleton) DO UPDATE SET run_date = excluded.run_date, status = 'running', attempt_id = excluded.attempt_id
    WHERE scheduled_pass.run_date < excluded.run_date`).bind(runDate, attemptId).run();
  if (!claimed.meta.changes) return { status: 'duplicate' as const };
  return runCohortPass(db, workflow, runDate, attemptId, fetcher, clock);
}

/** Reuse only complete, retained scientific batches, never another user's private inputs. */
async function lastNonemptyBatch(db: D1Database, categories: string[]): Promise<Batch[] | undefined> {
  const row = await db.prepare(`SELECT g.id, g.user_id FROM generation_inputs g JOIN users u ON u.id = g.user_id
    WHERE u.enabled = 1 AND g.batch_complete = 1 AND json_extract(g.batch_key, '$[1]') = ?
      AND EXISTS (SELECT 1 FROM generation_paper_refs p WHERE p.generation_id = g.id)
      AND (EXISTS (SELECT 1 FROM current_readings c WHERE c.listing_id = g.id)
        OR EXISTS (SELECT 1 FROM working_generations w WHERE w.generation_id = g.id))
    ORDER BY json_extract(g.batch_key, '$[0]') DESC, g.id LIMIT 1`).bind(JSON.stringify(categories)).first<{ id: string; user_id: string }>();
  return row ? (await readGenerationInputs(db, row.user_id, row.id))?.batches : undefined;
}

/** Shared ingestion/admission only; paid effects remain inside per-user Workflows.
 * An attempt ID fences duplicate forms and stale fetch continuations. */
export async function runCohortPass(db: D1Database, workflow: Pick<Workflow<GenerationReference>, 'create'>,
  runDate: string, attemptId: string, fetcher: typeof fetch, clock: () => Date = () => new Date(), adminId?: string) {
  const now = clock(), deadline = nextWeekdayBoundary(runDate);
  const active = async () => clock().toISOString() < deadline && !!await db.prepare(
    `SELECT 1 FROM scheduled_pass WHERE singleton = 1 AND attempt_id = ? AND status = 'running'
      AND (? IS NULL OR EXISTS (SELECT 1 FROM users WHERE id = ? AND enabled = 1 AND role = 'admin'))`)
    .bind(attemptId, adminId ?? null, adminId ?? null).first();
  const finish = async (status: 'complete' | 'feed-failed' | 'failed') => {
    const result = await db.prepare("UPDATE scheduled_pass SET status = ? WHERE singleton = 1 AND attempt_id = ? AND status = 'running'")
      .bind(status, attemptId).run();
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
    let stage = 'configuration';
    let category: string | undefined;
    let httpStatus: number | undefined;
    try {
      const saved = await db.prepare('SELECT text FROM saved_config WHERE singleton = 1').first<{ text: string }>();
      if (!saved) throw new Error('Missing saved configuration');
      const categories = parseConfig(saved.text).ingestion.categories;
      batches = [];
      for (const name of categories) {
        category = name;
        httpStatus = undefined;
        stage = 'feed-fetch';
        if (!await active()) return { status: 'stale' as const };
        batches.push(await fetchBatch(name, async (input, init) => {
          // Workers rejects redirect:'error'; manual returns 3xx for fetchBatch to reject.
          const response = await fetcher(input, { ...init, redirect: 'manual' });
          httpStatus = response.status;
          if (response.ok) stage = 'feed-read-parse';
          return response;
        }));
      }
      category = undefined;
      httpStatus = undefined;
      stage = 'batch-validation';
      let digest = createDigest(batches); // Mixed dates still fail; age alone is not a failure.
      if (digest.date > runDate) throw new Error('Future announcement date');
      if (!digest.papers.length) {
        batches = await lastNonemptyBatch(db, digest.categories) ?? [];
        if (!batches.length) return { ...await finish('complete'), noBatch: true }; // Preserve publications; admit nobody.
        digest = createDigest(batches);
      }
      const latest = await db.prepare(`SELECT max(date) AS date FROM (
        SELECT batch_date AS date FROM scheduled_pass WHERE singleton = 1
        UNION ALL SELECT json_extract(p.metadata_json, '$.date') FROM current_readings c
          JOIN reading_listings p ON p.id = c.listing_id)`).first<{ date: string | null }>();
      if (digest.date > runDate || (latest?.date && digest.date < latest.date)) throw new Error('Regressed or future announcement date');
      if (!await active()) return { status: 'stale' as const };
      stage = 'batch-persistence';
      await db.prepare("UPDATE scheduled_pass SET batch_date = ? WHERE singleton = 1 AND attempt_id = ? AND status = 'running'")
        .bind(digest.date, attemptId).run();
    } catch {
      // Never log exception messages or response bodies: they can contain secrets
      // or submitted documents. Fixed stages and HTTP status suffice for triage.
      console.error(JSON.stringify({ event: 'hosted-ingestion-failed', runDate, stage, category, httpStatus }));
      return finish('feed-failed');
    }

    const counts = { launched: 0, unchanged: 0, skipped: 0, failed: 0 };
    for (const user of users.results) {
      if (!await active()) return { status: 'stale' as const, ...counts };
      try {
        // Admission independently rechecks enabled state, work slot, daily date
        // and deadline. Settings/votes are frozen per user at admission time.
        const result = await launchDailyGeneration(db, workflow, user.id, batches, HOSTED_BGE_FINGERPRINT,
          { summariesRequested: true, now: clock(), runDate, adminId });
        if (result.status === 'launched') counts.launched++;
        else if (result.status === 'unchanged') counts.unchanged++;
        else if (result.status === 'not-admitted' || result.status === 'stale') counts.skipped++;
        else counts.failed++;
      } catch { counts.failed++; } // One user's admission failure does not stop the cohort.
    }
    return { ...await finish('complete'), ...counts };
  } catch { return finish('failed'); }
}
