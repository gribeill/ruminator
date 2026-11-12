// Copyright 2026 Guilhem Ribeill
// SPDX-License-Identifier: Apache-2.0

import type { D1Database } from '@cloudflare/workers-types';
import { escapeHtml } from '../math.ts';
import { adminRunStatus } from './run-status.ts';
import { readResponseText } from '../http-body.ts';
import { formToken, verifyFormToken } from './auth.ts';
import type { User } from './reading-store.ts';
import { readSavedConfig, readSavedInterests, saveConfig, saveInterests, type SavedDocument } from './saved-inputs.ts';

type Kind = 'interests' | 'config';
interface EditorReply { status: number; body: string; location?: string }
const pathFor = (kind: Kind) => kind === 'interests' ? '/interests' : '/admin';
const scope = (kind: Kind, revision: number) => `editor:${kind}:${revision}`;

/** Only scalar revision metadata is needed here, not full frozen batches/votes.
 * Configuration status refers to the admin's listing; other users apply the
 * global settings independently on their next new generation.
 */
async function appliedStatus(db: D1Database, userId: string, kind: Kind, saved: number): Promise<string> {
  const column = kind === 'interests' ? 'interests_revision' : 'config_revision';
  const row = await db.prepare(`SELECT p.${column} AS published, w.${column} AS working,
      c.listing_id AS listing, coalesce(p.summary_config_revision, p.config_revision) AS summary_revision,
      coalesce(w.summary_config_revision, w.config_revision) AS working_summary_revision FROM users u
    LEFT JOIN current_readings c ON c.user_id = u.id
    LEFT JOIN generation_inputs p ON p.id = c.listing_id AND p.user_id = u.id
    LEFT JOIN working_generations slot ON slot.user_id = u.id
    LEFT JOIN generation_inputs w ON w.id = slot.generation_id AND w.user_id = u.id
    WHERE u.id = ? AND u.enabled = 1 ${kind === 'config' ? "AND u.role = 'admin'" : ''}`)
    .bind(userId).first<{ published: number | null; working: number | null; listing: string | null; summary_revision: number | null; working_summary_revision: number | null }>();
  if (!row) return '';
  const published = row.published === null
    ? row.listing ? 'The current listing has no recorded applied revision.' : 'No listing has been published yet.'
    : kind === 'config' ? `Your current ranking uses revision ${row.published}; summaries use revision ${row.summary_revision}.`
      : `Your current listing uses revision ${row.published}.`;
  const working = row.working === null ? 'No generation is currently working.' : `The working generation is frozen at revision ${row.working}.`
    + (kind === 'config' ? ` Summary settings use revision ${row.working_summary_revision}.` : '');
  const pending = row.published === saved ? 'The saved revision is applied to your current listing.'
    : 'The saved revision is pending for a future publication.';
  return `<section aria-label="Saved and applied revisions"><p>Saved revision ${saved}. ${published}</p><p>${working} ${pending}</p></section>`;
}

async function form(db: D1Database, user: User, session: string, kind: Kind, document: SavedDocument,
  saved: SavedDocument | undefined, error?: string, forbidden = false): Promise<string> {
  const label = kind === 'interests' ? 'Interests (Markdown)' : 'Hosted configuration (TOML)';
  const token = await formToken(user.csrf_secret, user.id, session, scope(kind, document.revision));
  return `<p>Save changes for the next new generation. Saving does not start generation or change an existing listing or frozen working generation. An unchanged posting batch is not automatically rebuilt.</p>
${kind === 'config' ? '<p>These settings apply globally, on each user’s next new generation. Status below describes your own listing. Credentials are not editable here.</p>' : '<p>Keep the Markdown profile headings and stable IDs. Edit subjects and keywords directly.</p>'}
${saved ? await appliedStatus(db, user.id, kind, saved.revision) : ''}
${kind === 'config' ? await adminRunStatus(db, user.id) : ''}
${error ? `<p role="alert">${escapeHtml(error)}</p>` : ''}
<form method="post" action="${pathFor(kind)}">
<input type="hidden" name="revision" value="${document.revision}">
<input type="hidden" name="token" value="${token}">
<p>Editor base revision ${document.revision}.</p>
<label for="document">${label}</label>
<textarea id="document" name="text" rows="28" spellcheck="false">\n${escapeHtml(document.text)}</textarea>
<p>Maximum document size: 64 KiB UTF-8.</p>
${forbidden ? '' : '<button type="submit">Save</button>'}
</form><p><a href="${pathFor(kind)}" target="_blank" rel="noopener">Open latest saved version in a new tab</a> (does not replace the text above).</p>`;
}

/** Called only after Access authentication, route authorization and POST Origin
 * checks. Ownership is always the authenticated user; mutation predicates recheck
 * enabled/admin state. Failed saves retain the original revision, not permission
 * to silently overwrite a newer document on the next submission.
 */
export async function documentEditor(request: Request, db: D1Database, user: User, session: string, kind: Kind): Promise<EditorReply> {
  const read = () => kind === 'interests' ? readSavedInterests(db, user.id) : readSavedConfig(db, user.id);
  if (request.method !== 'POST') {
    const saved = await read();
    if (!saved) return { status: 200, body: '<p>The saved document is unavailable. An operator must initialize configuration or review account permissions.</p>' };
    return { status: 200, body: request.method === 'HEAD' ? '' : await form(db, user, session, kind, saved, saved) };
  }
  if (!/^application\/x-www-form-urlencoded(?:;|$)/i.test(request.headers.get('content-type') ?? '')) {
    return { status: 415, body: '<p>Expected an editor form.</p>' };
  }
  let fields: URLSearchParams;
  try { fields = new URLSearchParams(await readResponseText(request, 3 * 65536 + 2048)); }
  catch { return { status: 413, body: '<p>The form could not be read or exceeds the transport limit. Your browser may retain it when you go back.</p>' }; }
  if ([...fields.keys()].length !== 3 || ['revision', 'token', 'text'].some(k => fields.getAll(k).length !== 1) ||
      !/^[1-9]\d*$/.test(fields.get('revision') ?? '')) return { status: 400, body: '<p>Invalid editor form.</p>' };
  const revision = Number(fields.get('revision'));
  if (!Number.isSafeInteger(revision) || !await verifyFormToken(fields.get('token')!, user.csrf_secret, user.id, session, scope(kind, revision))) {
    return { status: 403, body: '<p>Invalid or outdated session/form. Open the editor again after logging in.</p>' };
  }
  const text = fields.get('text')!;
  const result = kind === 'interests' ? await saveInterests(db, user.id, revision, text) : await saveConfig(db, user.id, revision, text);
  if (result.status === 'saved') return { status: 303, body: '', location: pathFor(kind) };
  const error = result.status === 'invalid' ? result.error : result.status === 'conflict'
    ? 'A newer revision was saved. Your submission is preserved below. Open the latest saved version in a new tab and reconcile your edits there; this form still targets its original revision.'
    : 'Saving is no longer permitted. Your submission is preserved below; no changes were saved.';
  return { status: result.status === 'invalid' ? 422 : result.status === 'conflict' ? 409 : 403,
    body: await form(db, user, session, kind, { text: result.text, revision }, await read(), error, result.status === 'forbidden') };
}
