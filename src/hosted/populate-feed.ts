// Copyright 2026 Guilhem Ribeill
// SPDX-License-Identifier: Apache-2.0

import type { D1Database, Workflow } from '@cloudflare/workers-types';
import { readResponseText } from '../http-body.ts';
import { parseConfig } from '../config-text.ts';
import { escapeHtml } from '../math.ts';
import { formToken, verifyFormToken } from './auth.ts';
import { easternRunDate, type GenerationReference } from './daily-runs.ts';
import type { User } from './reading-store.ts';
import { runCohortPass } from './scheduled.ts';
import { uiHtml } from '../ui-text.ts';

async function state(db: D1Database, adminId: string) {
  return db.prepare(`SELECT cfg.revision, cfg.text, p.attempt_id, p.run_date, p.status
    FROM saved_config cfg JOIN users u ON u.id = ?
    LEFT JOIN scheduled_pass p ON p.singleton = 1
    WHERE cfg.singleton = 1 AND u.enabled = 1 AND u.role = 'admin'`)
    .bind(adminId).first<{ revision: number; text: string; attempt_id: string | null; run_date: string | null; status: string | null }>();
}
const versionOf = (s: NonNullable<Awaited<ReturnType<typeof state>>>) =>
  JSON.stringify([s.revision, s.attempt_id, s.run_date, s.status, easternRunDate(new Date())]);
const scope = (version: string) => `admin-populate:${version}`;

/** Cohort authorization is separate from the own-listing rebuild controls. */
export async function populateFeedForm(db: D1Database, user: User, session: string): Promise<string> {
  const s = await state(db, user.id);
  if (!s) return '';
  if (s.status === 'running') return `<p>${uiHtml('populate.busy')}</p>`;
  const version = versionOf(s), config = parseConfig(s.text);
  return `<section><h3>${uiHtml('populate.title')}</h3><p>${uiHtml('populate.description', { categories: config.ingestion.categories.join(', ') })}</p>
<p>${uiHtml('populate.limits', { model: config.llm.model, input_limit: config.summaries.run_input_tokens })}</p>
<form method="post" action="/admin/populate"><input type="hidden" name="version" value="${escapeHtml(version)}"><input type="hidden" name="token" value="${await formToken(user.csrf_secret, user.id, session, scope(version))}">
<label><input type="checkbox" name="confirm" value="paid" required> ${uiHtml('populate.consent')}</label><button type="submit">${uiHtml('populate.title')}</button></form></section>`;
}

/** Consume the confirmation atomically before fetching. A fresh confirmation,
 * never a replay or a scheduler retry, can start a new cohort pass. */
export async function populateFeed(request: Request, db: D1Database, user: User, session: string,
  workflow: Pick<Workflow<GenerationReference>, 'create'> | undefined, fetcher: typeof fetch) {
  if (!workflow) return { status: 503, body: `<p>${uiHtml('controls.execution_disabled')}</p>` };
  if (!/^application\/x-www-form-urlencoded(?:;|$)/i.test(request.headers.get('content-type') ?? '')) return { status: 415, body: `<p>${uiHtml('controls.form_expected')}</p>` };
  let form: URLSearchParams;
  try { form = new URLSearchParams(await readResponseText(request, 8192)); }
  catch { return { status: 413, body: `<p>${uiHtml('controls.form_large')}</p>` }; }
  if ([...form.keys()].length !== 3 || ['version', 'token', 'confirm'].some(k => form.getAll(k).length !== 1) || form.get('confirm') !== 'paid') {
    return { status: 400, body: `<p>${uiHtml('populate.consent_required')}</p>` };
  }
  const version = form.get('version')!;
  if (!await verifyFormToken(form.get('token')!, user.csrf_secret, user.id, session, scope(version))) return { status: 403, body: `<p>${uiHtml('controls.form_invalid')}</p>` };
  const s = await state(db, user.id);
  const conflict = { status: 409, body: `<p>${uiHtml('populate.conflict')}</p>` };
  if (!s || s.status === 'running' || version !== versionOf(s)) return conflict;
  const attemptId = crypto.randomUUID(), runDate = easternRunDate(new Date());
  const claim = await db.prepare(`INSERT INTO scheduled_pass (singleton, run_date, status, attempt_id)
    SELECT 1, ?, 'running', ? FROM users u CROSS JOIN saved_config cfg
    WHERE u.id = ? AND u.enabled = 1 AND u.role = 'admin' AND cfg.singleton = 1 AND cfg.revision = ?
      AND NOT EXISTS (SELECT 1 FROM scheduled_pass p WHERE p.singleton = 1
        AND (p.attempt_id IS NOT ? OR p.run_date IS NOT ? OR p.status IS NOT ?))
    ON CONFLICT(singleton) DO UPDATE SET run_date = excluded.run_date, status = 'running', attempt_id = excluded.attempt_id
    WHERE scheduled_pass.status != 'running' AND scheduled_pass.attempt_id IS ?
      AND scheduled_pass.run_date IS ? AND scheduled_pass.status IS ?`)
    .bind(runDate, attemptId, user.id, s.revision, s.attempt_id, s.run_date, s.status, s.attempt_id, s.run_date, s.status).run();
  if (!claim.meta.changes) return conflict;
  const result = await runCohortPass(db, workflow, runDate, attemptId, fetcher, undefined, user.id);
  if (result.status !== 'complete') return { status: 503, body: `<p>${uiHtml('populate.failed')}</p>` };
  if ('noBatch' in result) return { status: 200, body: `<p>${uiHtml('populate.no_batch')}</p><p><a href="/admin">${uiHtml('populate.return_admin')}</a></p>` };
  return { status: 303, body: '', location: '/admin' };
}
