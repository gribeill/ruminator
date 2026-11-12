// Copyright 2026 Guilhem Ribeill
// SPDX-License-Identifier: Apache-2.0

import type { D1Database } from '@cloudflare/workers-types';
import { parseConfig } from '../config-text.ts';
import { parseProfiles } from '../profile-text.ts';
import { DocumentError } from '../document-error.ts';
import { uiText } from '../ui-text.ts';

export interface SavedDocument { text: string; revision: number }
export type SaveResult =
  | { status: 'saved'; document: SavedDocument }
  | { status: 'invalid'; text: string; error: string }
  | { status: 'conflict' | 'forbidden'; text: string };

/** Bound editable documents well below D1's value and request limits. */
function validate(text: string, kind: 'interests' | 'config'): void {
  if (new TextEncoder().encode(text).length > 65536) throw new DocumentError('document_large', 'Document exceeds 64 KiB');
  if (kind === 'interests') parseProfiles(text);
  else parseConfig(text);
}

/** Operator-only bootstrap, never called by requests. Existing saved edits win. */
export async function initializeSavedConfig(db: D1Database, text: string): Promise<void> {
  validate(text, 'config');
  await db.prepare('INSERT INTO saved_config (singleton, text, revision) VALUES (1, ?, 1) ON CONFLICT DO NOTHING').bind(text).run();
}

/** userId must come from verified identity, never a submitted ownership field. */
export async function readSavedInterests(db: D1Database, userId: string): Promise<SavedDocument | undefined> {
  return await db.prepare('SELECT interests AS text, interests_revision AS revision FROM users WHERE id = ? AND enabled = 1')
    .bind(userId).first<SavedDocument>() ?? undefined;
}

/** Global configuration is private to the enabled admin, not all invited users. */
export async function readSavedConfig(db: D1Database, userId: string): Promise<SavedDocument | undefined> {
  return await db.prepare(`SELECT text, revision FROM saved_config
    WHERE singleton = 1 AND EXISTS (SELECT 1 FROM users WHERE id = ? AND enabled = 1 AND role = 'admin')`)
    .bind(userId).first<SavedDocument>() ?? undefined;
}

/** Compare-and-save is atomic; edits never touch frozen generation or reading data.
 * Rejected saves carry the submitted text so future editors can preserve it.
 */
export async function saveInterests(db: D1Database, userId: string, expectedRevision: number, text: string): Promise<SaveResult> {
  return save(db, userId, expectedRevision, text, 'interests');
}

/** Only an enabled admin may save; configuration is not summary authorization. */
export async function saveConfig(db: D1Database, userId: string, expectedRevision: number, text: string): Promise<SaveResult> {
  return save(db, userId, expectedRevision, text, 'config');
}

async function save(db: D1Database, userId: string, expectedRevision: number, text: string, kind: 'interests' | 'config'): Promise<SaveResult> {
  try {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new DocumentError('document_revision', 'Invalid document revision');
    validate(text, kind);
  } catch (error) {
    const message = error instanceof DocumentError ? uiText(`validation.${error.code}`, error.values)
      : error instanceof Error ? uiText('validation.syntax', { detail: error.message }) : uiText('validation.invalid');
    return { status: 'invalid', text, error: message };
  }
  const admin = kind === 'config';
  const permission = `SELECT 1 FROM users WHERE id = ? AND enabled = 1${admin ? " AND role = 'admin'" : ''}`;
  const update = admin
    ? db.prepare(`UPDATE saved_config SET text = ?, revision = revision + 1
        WHERE singleton = 1 AND revision = ? AND EXISTS (${permission}) RETURNING revision`).bind(text, expectedRevision, userId)
    : db.prepare(`UPDATE users SET interests = ?, interests_revision = interests_revision + 1
        WHERE interests_revision = ? AND id = ? AND enabled = 1 RETURNING interests_revision AS revision`).bind(text, expectedRevision, userId);
  // D1 batch gives a transaction: permission diagnosis cannot race the write.
  const results = await db.batch<{ revision: number }>([update, db.prepare(permission).bind(userId)]);
  const updated = results[0].results[0];
  if (updated) return { status: 'saved', document: { text, revision: updated.revision } };
  return { status: results[1].results.length ? 'conflict' : 'forbidden', text };
}
