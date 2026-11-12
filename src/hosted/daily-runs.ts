// Copyright 2026 Guilhem Ribeill
// SPDX-License-Identifier: Apache-2.0

import type { D1Database, Workflow } from '@cloudflare/workers-types';
import type { Batch } from '../arxiv.ts';
import { failGeneration, type RunFailure } from './generation-lifecycle.ts';
import { cleanupHostedState } from './retention.ts';
export type { RunFailure } from './generation-lifecycle.ts';
import { freezeGenerationInputs } from './generation-inputs.ts';

export interface GenerationReference { userId: string; generationId: string }
const eastern = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
export function easternRunDate(now: Date): string {
  const parts = eastern.formatToParts(now);
  return ['year', 'month', 'day'].map(type => parts.find(p => p.type === type)!.value).join('-');
}
export function nextWeekdayBoundary(runDate: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(runDate)) throw new Error('Expected an ISO run date');
  const day = new Date(`${runDate}T12:00:00Z`);
  if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== runDate) throw new Error('Invalid run date');
  do { day.setUTCDate(day.getUTCDate() + 1); } while ([0, 6].includes(day.getUTCDay()));
  // Noon UTC and 06:00 Eastern are on the same weekday and DST side.
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', hourCycle: 'h23' }).format(day));
  day.setUTCHours(12 + 6 - hour);
  return day.toISOString();
}

/** Trusted lifecycle operation, not a user mutation endpoint. Disabled owners
 * must also be fenceable. Claims/reservations remain untouched; no takeover.
 * expectedDeadline limits the boundary operation against a stale caller.
 */
export async function failDailyRun(db: D1Database, ref: GenerationReference, reason: RunFailure,
  expectedDeadline?: string): Promise<void> {
  await failGeneration(db, ref.userId, ref.generationId, { reason, daily: { cutoff: expectedDeadline } });
}

/** Invoked at a boundary by the weekday pass, including for disabled users,
 * and before this user's next admission/step. No watchdog or polling service.
 */
export async function expireDailyRun(db: D1Database, userId: string, now = new Date()): Promise<void> {
  const row = await db.prepare(`SELECT generation_id FROM generation_runs
    WHERE user_id = ? AND finished_at IS NULL AND deadline <= ?`).bind(userId, now.toISOString())
    .first<{ generation_id: string }>();
  if (row) await failDailyRun(db, { userId, generationId: row.generation_id }, 'deadline', now.toISOString());
}

/** Admission precedes launch. Only the winner calls create, using the immutable
 * generation ID as Workflow ID. A crash/ambiguous launch leaves pending work;
 * duplicate deliveries never relaunch it or create a replacement generation.
 * Date/weekday triggering itself is deliberately not enabled here.
 */
export async function launchDailyGeneration(db: D1Database, workflow: Pick<Workflow<GenerationReference>, 'create'>,
  userId: string, batches: Batch[], modelIdentity: string,
  { summariesRequested = false, now = new Date(), runDate = easternRunDate(now) }: {
    summariesRequested?: boolean; now?: Date; runDate?: string;
  } = {}) {
  batches = structuredClone(batches);
  const deadline = nextWeekdayBoundary(runDate);
  await expireDailyRun(db, userId, now);
  // A delayed trigger keeps its intended Eastern date, not its delivery date.
  if (runDate > easternRunDate(now) || deadline <= now.toISOString()) return { status: 'not-admitted' as const };
  const generationId = crypto.randomUUID();
  const reserved = await db.prepare(`INSERT INTO generation_runs (user_id, run_date, generation_id, deadline)
    SELECT u.id, ?, ?, ? FROM users u WHERE u.id = ? AND u.enabled = 1
      AND ? > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      AND EXISTS (SELECT 1 FROM saved_config WHERE singleton = 1)
      AND NOT EXISTS (SELECT 1 FROM working_generations w WHERE w.user_id = u.id)
    ON CONFLICT (user_id) DO UPDATE SET run_date = excluded.run_date, generation_id = excluded.generation_id,
      deadline = excluded.deadline, finished_at = NULL, failure_reason = NULL
    WHERE generation_runs.run_date < excluded.run_date AND generation_runs.finished_at IS NOT NULL`)
    .bind(runDate, generationId, deadline, userId, deadline).run();
  if (!reserved.meta.changes) return { status: 'not-admitted' as const };
  const ref = { userId, generationId };
  const launchFailure = async (reason: 'preparation' | 'launch') => {
    await db.prepare(`UPDATE generation_runs SET failure_reason = ? WHERE user_id = ? AND generation_id = ? AND finished_at IS NULL`)
      .bind(reason, userId, generationId).run();
  };
  try {
    const admission = await freezeGenerationInputs(db, userId, batches, modelIdentity, summariesRequested, generationId);
    // Pin the new batch before pruning, so reusable scientific work survives.
    // Once per daily attempt, never on each model continuation.
    await cleanupHostedState(db, new Date(), 2);
    if (admission.status === 'unchanged') {
      await db.prepare(`UPDATE generation_runs SET generation_id = NULL, finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE user_id = ? AND generation_id = ? AND finished_at IS NULL AND failure_reason IS NULL`)
        .bind(userId, generationId).run();
      return { status: 'unchanged' as const };
    }
    if (admission.status !== 'captured' || admission.inputs.id !== generationId || !admission.inputs.batches) {
      throw new Error('Incomplete generation input capture');
    }
  } catch {
    await launchFailure('preparation');
    return { status: 'preparation-failed' as const, ...ref };
  }
  if (!await prepareDailyRunStep(db, ref)) return { status: 'stale' as const, ...ref };
  try {
    await workflow.create({ id: generationId, params: ref });
    return { status: 'launched' as const, ...ref };
  } catch {
    await launchFailure('launch');
    return { status: 'launch-failed' as const, ...ref };
  }
}

/** Expire/close ineligible work, then check eligibility INSIDE the retried
 * callback. This is a lifecycle operation, not a read-only predicate.
 */
export async function prepareDailyRunStep(db: D1Database, ref: GenerationReference): Promise<boolean> {
  await expireDailyRun(db, ref.userId);
  const row = await db.prepare(`SELECT g.state, u.enabled, r.failure_reason, r.finished_at FROM generation_runs r
    JOIN generation_inputs g ON g.id = r.generation_id AND g.user_id = r.user_id JOIN users u ON u.id = r.user_id
    WHERE r.user_id = ? AND r.generation_id = ?`).bind(ref.userId, ref.generationId)
    .first<{ state: string; enabled: number; failure_reason: string | null; finished_at: string | null }>();
  if (!row || row.finished_at || row.failure_reason) return false;
  if (!row.enabled) { await failDailyRun(db, ref, 'disabled'); return false; }
  return ['working', 'staging', 'ready'].includes(row.state);
}
