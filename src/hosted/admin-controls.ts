// Copyright 2026 Guilhem Ribeill
// SPDX-License-Identifier: Apache-2.0

import type { D1Database, Workflow } from '@cloudflare/workers-types';
import { formToken, verifyFormToken } from './auth.ts';
import { readResponseText } from '../http-body.ts';
import { escapeHtml } from '../math.ts';
import { parseConfig } from '../config-text.ts';
import { HOSTED_BGE_FINGERPRINT } from './bge.ts';
import { easternRunDate, nextWeekdayBoundary, type GenerationReference } from './daily-runs.ts';
import { cleanupHostedState } from './retention.ts';
import type { User } from './reading-store.ts';
import { uiHtml } from '../ui-text.ts';

type Action = 'rebuild' | 'summaries';
type Launcher = Pick<Workflow<GenerationReference>, 'create'>;
interface ControlState { publication: string; previous: string | null; day: string | null; interests: number; config: number; busy: number; saved_config: string }
const scope = (action: Action, version: string) => `admin-execute:${action}:${version}`;
const versionOf = (s: ControlState) => JSON.stringify([s.publication, s.previous, s.day, s.interests, s.config]);
async function state(db: D1Database, userId: string): Promise<ControlState | null> {
  return db.prepare(`SELECT c.listing_id AS publication, r.generation_id AS previous, r.run_date AS day,
    u.interests_revision AS interests, cfg.revision AS config, cfg.text AS saved_config,
    (EXISTS (SELECT 1 FROM working_generations w WHERE w.user_id = u.id)
      OR (r.user_id IS NOT NULL AND r.finished_at IS NULL)) AS busy
    FROM users u JOIN current_readings c ON c.user_id = u.id
    JOIN generation_inputs g ON g.id = c.listing_id AND g.user_id = u.id AND g.state = 'published'
    CROSS JOIN saved_config cfg LEFT JOIN generation_runs r ON r.user_id = u.id
    WHERE u.id = ? AND u.enabled = 1 AND u.role = 'admin' AND cfg.singleton = 1`)
    .bind(userId).first<ControlState>();
}

export async function adminControls(db: D1Database, user: User, session: string, enabled: boolean): Promise<string> {
  if (!enabled) return `<section><h3>${uiHtml('controls.title')}</h3><p>${uiHtml('controls.disabled')}</p></section>`;
  const s = await state(db, user.id);
  if (!s) return `<p>${uiHtml('controls.publication_required')}</p>`;
  if (s.busy) return `<p>${uiHtml('controls.busy')}</p>`;
  const version = versionOf(s), config = parseConfig(s.saved_config), limits = config.summaries;
  const forms = await Promise.all((['rebuild', 'summaries'] as const).map(async action => {
    const label = uiHtml(action === 'rebuild' ? 'controls.rebuild' : 'controls.summaries');
    const description = action === 'rebuild'
      ? uiHtml('controls.rebuild_description')
      : uiHtml('controls.summary_description', { input_limit: limits.run_input_tokens });
    return `<form method="post" action="/admin/${action}"><h4>${label}</h4><p>${description}</p>
<input type="hidden" name="version" value="${escapeHtml(version)}">
<input type="hidden" name="token" value="${await formToken(user.csrf_secret, user.id, session, scope(action, version))}">
<label><input type="checkbox" name="confirm" value="paid" required> ${uiHtml('controls.consent')}</label>
<button type="submit">${label}</button></form>`;
  }));
  return `<section aria-label="${uiHtml('controls.title')}"><h3>${uiHtml('controls.title')}</h3><p>${uiHtml('controls.guidance')}</p><p>${uiHtml('controls.limits', { model: config.llm.model, input_limit: limits.run_input_tokens, completion_limit: limits.max_completion_tokens })}</p>${forms.join('')}</section>`;
}

/** Authenticated admin + Origin checks are supplied by the app. The reservation
 * rechecks role, publication, revisions, idle state and the last run ID atomically.
 * The last ID/date consume this form even if capture/launch later fails or a later daily check is a no-op.
 */
export async function adminAction(request: Request, db: D1Database, user: User, session: string,
  action: Action, launcher?: Launcher): Promise<{ status: number; body: string; location?: string }> {
  if (!launcher) return { status: 503, body: `<p>${uiHtml('controls.execution_disabled')}</p>` };
  if (!/^application\/x-www-form-urlencoded(?:;|$)/i.test(request.headers.get('content-type') ?? '')) return { status: 415, body: `<p>${uiHtml('controls.form_expected')}</p>` };
  let form: URLSearchParams;
  try { form = new URLSearchParams(await readResponseText(request, 8192)); }
  catch { return { status: 413, body: `<p>${uiHtml('controls.form_large')}</p>` }; }
  if ([...form.keys()].length !== 3 || ['version', 'token', 'confirm'].some(k => form.getAll(k).length !== 1) || form.get('confirm') !== 'paid') {
    return { status: 400, body: `<p>${uiHtml('controls.consent_required')}</p>` };
  }
  const version = form.get('version')!;
  if (!await verifyFormToken(form.get('token')!, user.csrf_secret, user.id, session, scope(action, version))) return { status: 403, body: `<p>${uiHtml('controls.form_invalid')}</p>` };
  const s = await state(db, user.id);
  const conflict = { status: 409, body: `<p>${uiHtml('controls.conflict')}</p>` };
  if (!s || s.busy || version !== versionOf(s)) return conflict;
  const id = crypto.randomUUID(), date = easternRunDate(new Date());
  const reserved = await db.prepare(`INSERT INTO generation_runs (user_id, run_date, generation_id, deadline)
    SELECT u.id, ?, ?, ? FROM users u JOIN current_readings c ON c.user_id = u.id CROSS JOIN saved_config cfg
    WHERE u.id = ? AND u.role = 'admin' AND u.enabled = 1 AND c.listing_id = ?
      AND u.interests_revision = ? AND cfg.revision = ? AND cfg.singleton = 1
      AND NOT EXISTS (SELECT 1 FROM working_generations w WHERE w.user_id = u.id)
      AND NOT EXISTS (SELECT 1 FROM generation_runs r WHERE r.user_id = u.id AND (r.finished_at IS NULL OR r.generation_id IS NOT ? OR r.run_date IS NOT ?))
    ON CONFLICT(user_id) DO UPDATE SET run_date = max(generation_runs.run_date, excluded.run_date),
      generation_id = excluded.generation_id, deadline = excluded.deadline, finished_at = NULL, failure_reason = NULL
    WHERE generation_runs.finished_at IS NOT NULL AND generation_runs.generation_id IS ? AND generation_runs.run_date IS ?`)
    .bind(date, id, nextWeekdayBoundary(date), user.id, s.publication, s.interests, s.config, s.previous, s.day, s.previous, s.day).run();
  if (!reserved.meta.changes) return conflict;
  const failed = async (reason: 'preparation' | 'launch') => {
    await db.prepare('UPDATE generation_runs SET failure_reason = ? WHERE user_id = ? AND generation_id = ? AND finished_at IS NULL')
      .bind(reason, user.id, id).run();
    return { status: 503, body: `<p>${uiHtml('controls.launch_failed')}</p>` };
  };
  try {
    // Copy the already published batch in D1. Rebuild freezes latest documents
    // and votes; summary-only retains exactly the ranking's original snapshot.
    await db.batch([
      db.prepare(`INSERT INTO generation_inputs
        (id,user_id,started_at,interests,interests_revision,config,config_revision,model_identity,
         batch_hash,batch_bytes,batch_chunks,batch_complete,batch_key,summaries_requested,action,base_publication,summary_config,summary_config_revision)
        SELECT ?, u.id, CASE WHEN ? = 'summaries' THEN g.started_at ELSE strftime('%Y-%m-%dT%H:%M:%fZ','now') END,
          CASE WHEN ? = 'summaries' THEN g.interests ELSE u.interests END,
          CASE WHEN ? = 'summaries' THEN g.interests_revision ELSE u.interests_revision END,
          CASE WHEN ? = 'summaries' THEN g.config ELSE cfg.text END,
          CASE WHEN ? = 'summaries' THEN g.config_revision ELSE cfg.revision END,
          CASE WHEN ? = 'summaries' THEN g.model_identity ELSE ? END,
          g.batch_hash,g.batch_bytes,g.batch_chunks,1,g.batch_key,1,?,g.id,
          CASE WHEN ? = 'summaries' THEN cfg.text ELSE NULL END,
          CASE WHEN ? = 'summaries' THEN cfg.revision ELSE NULL END
        FROM users u JOIN current_readings c ON c.user_id = u.id JOIN generation_inputs g ON g.id = c.listing_id
          CROSS JOIN saved_config cfg JOIN generation_runs r ON r.user_id = u.id
        WHERE u.id = ? AND u.enabled = 1 AND u.role = 'admin' AND g.id = ? AND g.user_id = u.id AND g.state = 'published' AND g.batch_complete = 1
          AND u.interests_revision = ? AND cfg.revision = ? AND cfg.singleton = 1
          AND r.generation_id = ? AND r.finished_at IS NULL AND r.failure_reason IS NULL
          AND r.deadline > strftime('%Y-%m-%dT%H:%M:%fZ','now')
          AND NOT EXISTS (SELECT 1 FROM working_generations w WHERE w.user_id = u.id)`)
        .bind(id, action, action, action, action, action, action, HOSTED_BGE_FINGERPRINT, action, action, action, user.id, s.publication, s.interests, s.config, id),
      db.prepare('INSERT INTO working_generations SELECT user_id,id FROM generation_inputs WHERE id = ?').bind(id),
      db.prepare(`INSERT INTO generation_batch_chunks SELECT g.id,b.ordinal,b.bytes FROM generation_inputs g
        JOIN generation_batch_chunks b ON b.generation_id = g.base_publication WHERE g.id = ?`).bind(id),
      db.prepare(`INSERT INTO generation_paper_refs SELECT g.id,p.paper_id,p.version FROM generation_inputs g
        JOIN generation_paper_refs p ON p.generation_id = g.base_publication WHERE g.id = ?`).bind(id),
      db.prepare(`INSERT INTO generation_profile_vectors SELECT g.id,p.profile_id,p.input_hash,p.vector_json
        FROM generation_inputs g JOIN generation_profile_vectors p ON p.generation_id = g.base_publication
        WHERE g.id = ? AND g.action = 'summaries'`).bind(id),
      db.prepare(`INSERT INTO generation_input_votes SELECT g.id,v.paper_id,v.value,v.paper_json,v.changed_at
        FROM generation_inputs g JOIN generation_input_votes v ON v.generation_id = g.base_publication
        WHERE g.id = ? AND g.action = 'summaries'`).bind(id),
      db.prepare(`INSERT INTO generation_input_votes SELECT g.id,v.paper_id,v.value,v.paper_json,v.changed_at
        FROM generation_inputs g JOIN user_votes v ON v.user_id = g.user_id
        WHERE g.id = ? AND g.action = 'rebuild' AND v.value != 0 AND v.changed_at >= strftime('%Y-%m-%dT%H:%M:%fZ',g.started_at,'-365 days')`).bind(id),
    ]);
    if (!await db.prepare('SELECT 1 FROM working_generations WHERE user_id = ? AND generation_id = ?').bind(user.id, id).first()) return failed('preparation');
    await cleanupHostedState(db, new Date(), 2);
  } catch { return failed('preparation'); }
  try { await launcher.create({ id, params: { userId: user.id, generationId: id } }); }
  catch { return failed('launch'); }
  return { status: 303, body: '', location: '/admin' };
}
