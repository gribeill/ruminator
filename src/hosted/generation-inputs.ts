// Copyright 2026 Guilhem Ribeill
// SPDX-License-Identifier: Apache-2.0

import type { D1Database, D1DatabaseSession } from '@cloudflare/workers-types';
import type { Batch, Paper } from '../arxiv.ts';
import { createDigest } from '../digest.ts';
import { parseConfig } from '../config-text.ts';
import { parseProfiles } from '../profile-text.ts';
import type { SavedDocument } from './saved-inputs.ts';

const CHUNK_BYTES = 256 * 1024;
const PAGE_CHUNKS = 8;

export interface FrozenVote {
  paperId: string; value: -1 | 1; paper: Paper; changedAt: string;
}
export interface GenerationInputs {
  id: string;
  userId: string;
  startedAt: string;
  interests: SavedDocument;
  config: SavedDocument;
  /** The adapter's full compatibility fingerprint, not merely a model name. */
  modelIdentity: string;
  batchHash: string;
  /** Announcement date/categories identify repeated batches, independently of metadata edits. */
  batchKey: string;
  /** Completion requirement only, never authorization to make a paid call. */
  summariesRequested: boolean;
  action: 'daily' | 'rebuild' | 'summaries';
  basePublication: string | null;
  /** Summary-only updates keep ranking configuration but freeze new summary settings. */
  summaryConfig?: SavedDocument;
  /** Undefined until all frozen batch bytes are persisted and verified. */
  batches: Batch[] | undefined;
  votes: FrozenVote[];
}
interface InputRow {
  id: string; user_id: string; started_at: string;
  interests: string; interests_revision: number; config: string; config_revision: number;
  model_identity: string; batch_hash: string; batch_bytes: number; batch_chunks: number; batch_complete: number;
  batch_key: string; summaries_requested: number; action: GenerationInputs['action']; base_publication: string | null;
  summary_config: string | null; summary_config_revision: number | null;
}
async function hash(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
}

async function inputRow(session: D1DatabaseSession, userId: string, generationId?: string): Promise<InputRow | null> {
  return session.prepare(`SELECT g.* FROM generation_inputs g
    JOIN users u ON u.id = g.user_id
    LEFT JOIN working_generations w ON w.user_id = g.user_id AND w.generation_id = g.id
    LEFT JOIN current_readings c ON c.user_id = g.user_id AND c.listing_id = g.id
    WHERE u.id = ? AND u.enabled = 1
      AND ((? IS NULL AND w.generation_id IS NOT NULL)
        OR (g.id = ? AND (w.generation_id IS NOT NULL OR c.listing_id IS NOT NULL)))`)
    .bind(userId, generationId ?? null, generationId ?? null).first<InputRow>();
}

/** Chunks are BLOBs so a split inside a multibyte character never corrupts UTF-8.
 * Verify the complete payload before decoding; missing/corrupt data never becomes input.
 */
async function readBatch(session: D1DatabaseSession, row: InputRow): Promise<Batch[]> {
  const bytes = new Uint8Array(row.batch_bytes);
  let offset = 0;
  for (let first = 0; first < row.batch_chunks; first += PAGE_CHUNKS) {
    const chunks = (await session.prepare(`SELECT ordinal, bytes FROM generation_batch_chunks
      WHERE generation_id = ? AND ordinal >= ? AND ordinal < ? ORDER BY ordinal`)
      .bind(row.id, first, Math.min(first + PAGE_CHUNKS, row.batch_chunks))
      .all<{ ordinal: number; bytes: number[] }>()).results;
    if (chunks.length !== Math.min(PAGE_CHUNKS, row.batch_chunks - first)) throw new Error('Incomplete frozen posting batch');
    for (const [index, chunk] of chunks.entries()) {
      const value = new Uint8Array(chunk.bytes);
      const expected = Math.min(CHUNK_BYTES, row.batch_bytes - offset);
      if (chunk.ordinal !== first + index || value.length !== expected) throw new Error('Invalid frozen posting chunk');
      bytes.set(value, offset);
      offset += value.length;
    }
  }
  if (offset !== row.batch_bytes || await hash(bytes) !== row.batch_hash) throw new Error('Frozen posting batch checksum mismatch');
  const batches = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as Batch[];
  createDigest(batches); // Retain shared mixed-date/category merge semantics.
  return batches;
}

/** Read the working snapshot, or pin an explicit current/working generation ID.
 * Superseded IDs are not a history API; cleanup may interrupt a superseded run.
 * Expired private vote provenance is removed without rewriting scientific output.
 */
export async function readGenerationInputs(db: D1Database, userId: string, generationId?: string): Promise<GenerationInputs | undefined> {
  const session = db.withSession('first-primary');
  const row = await inputRow(session, userId, generationId);
  if (!row) return undefined;
  parseProfiles(row.interests);
  parseConfig(row.config);
  if (row.summary_config !== null) parseConfig(row.summary_config);
  const votes: FrozenVote[] = [];
  let last: { changed_at: string; paper_id: string } | undefined;
  // Vote metadata is bounded per row; page reads to stay below D1's result limit.
  for (;;) {
    const page = (await session.prepare(`SELECT paper_id, value, paper_json, changed_at FROM generation_input_votes
      WHERE generation_id = ? AND (? IS NULL OR changed_at < ? OR (changed_at = ? AND paper_id > ?))
      ORDER BY changed_at DESC, paper_id LIMIT 8`)
      .bind(row.id, last?.changed_at ?? null, last?.changed_at ?? null, last?.changed_at ?? null, last?.paper_id ?? null)
      .all<{ paper_id: string; value: -1 | 1; paper_json: string; changed_at: string }>()).results;
    votes.push(...page.map(v => ({ paperId: v.paper_id, value: v.value, paper: JSON.parse(v.paper_json), changedAt: v.changed_at })));
    if (page.length < 8) break;
    last = page[page.length - 1];
  }
  return {
    id: row.id, userId: row.user_id, startedAt: row.started_at,
    interests: { text: row.interests, revision: row.interests_revision },
    config: { text: row.config, revision: row.config_revision },
    modelIdentity: row.model_identity, batchHash: row.batch_hash,
    batchKey: row.batch_key, summariesRequested: row.summaries_requested === 1,
    action: row.action, basePublication: row.base_publication,
    ...(row.summary_config === null ? {} : { summaryConfig: { text: row.summary_config, revision: row.summary_config_revision! } }),
    batches: row.batch_complete ? await readBatch(session, row) : undefined,
    votes,
  };
}

/** Internal generation admission, not a browser action. userId is the trusted
 * target chosen by the future scheduler/admin authorization boundary.
 *
 * Interests/config/votes are frozen in one D1 transaction. At most one snapshot
 * can be working per user. Resumption always returns its original inputs, even
 * if the caller now supplies a different batch or model. A partial batch can
 * only be completed from bytes matching the original hash; inference must wait
 * for `batches` to be present. A currently published announcement date/category
 * combination returns unchanged when no work exists, even after edits or a
 * changed model. No provider calls, publication, or reset here.
 */
export type GenerationAdmission =
  | { status: 'captured'; inputs: GenerationInputs }
  | { status: 'unchanged' | 'blocked' };

export async function freezeGenerationInputs(
  db: D1Database, userId: string, batches: Batch[], modelIdentity: string, summariesRequested = false, dailyGenerationId?: string,
): Promise<GenerationAdmission> {
  if (!modelIdentity.trim() || new TextEncoder().encode(modelIdentity).length > 4096) throw new Error('Expected a bounded model compatibility fingerprint');
  if (new Set(batches.map(b => b.category)).size !== batches.length) throw new Error('Duplicate source category');
  const digest = createDigest(batches);
  const batchKey = JSON.stringify([digest.date, digest.categories]);
  // Serialize synchronously before the first await, isolating caller mutation.
  const bytes = new TextEncoder().encode(JSON.stringify([...batches].sort((a, b) => a.category.localeCompare(b.category))));
  const batchHash = await hash(bytes);
  const chunks = Math.ceil(bytes.length / CHUNK_BYTES);
  const id = dailyGenerationId ?? crypto.randomUUID();
  const session = db.withSession('first-primary');
  await session.batch([
    session.prepare(`INSERT INTO generation_inputs
      (id, user_id, started_at, interests, interests_revision, config, config_revision,
       model_identity, batch_hash, batch_bytes, batch_chunks, batch_key, summaries_requested)
      SELECT ?, u.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), u.interests, u.interests_revision, c.text, c.revision, ?, ?, ?, ?, ?, ?
      FROM users u CROSS JOIN saved_config c WHERE u.id = ? AND u.enabled = 1 AND c.singleton = 1
      AND NOT EXISTS (SELECT 1 FROM working_generations WHERE user_id = u.id)
      AND NOT EXISTS (SELECT 1 FROM generation_runs r WHERE r.user_id = u.id AND r.finished_at IS NULL AND r.generation_id != ?)
      AND (? IS NULL OR EXISTS (SELECT 1 FROM generation_runs r WHERE r.user_id = u.id AND r.generation_id = ?
        AND r.finished_at IS NULL AND r.failure_reason IS NULL AND r.deadline > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')))
      AND NOT EXISTS (SELECT 1 FROM current_readings r JOIN generation_inputs g ON g.id = r.listing_id
        WHERE r.user_id = u.id AND g.batch_key = ?)`)
      .bind(id, modelIdentity, batchHash, bytes.length, chunks, batchKey, summariesRequested ? 1 : 0, userId, id, dailyGenerationId ?? null, id, batchKey),
    session.prepare(`INSERT INTO working_generations (user_id, generation_id)
      SELECT user_id, id FROM generation_inputs WHERE id = ?`).bind(id),
    session.prepare(`INSERT INTO generation_input_votes (generation_id, paper_id, value, paper_json, changed_at)
      SELECT g.id, v.paper_id, v.value, v.paper_json, v.changed_at FROM generation_inputs g
      JOIN user_votes v ON v.user_id = g.user_id
      WHERE g.id = ? AND v.value != 0
        AND v.changed_at >= strftime('%Y-%m-%dT%H:%M:%fZ', g.started_at, '-365 days')`)
      .bind(id),
  ]);
  const row = await inputRow(session, userId);
  if (row && dailyGenerationId && row.id !== dailyGenerationId) return { status: 'blocked' };
  if (!row) {
    const unchanged = await session.prepare(`SELECT 1 FROM current_readings c
      JOIN generation_inputs g ON g.id = c.listing_id JOIN users u ON u.id = c.user_id
      WHERE c.user_id = ? AND u.enabled = 1 AND g.batch_key = ?`)
      .bind(userId, batchKey).first();
    return { status: unchanged ? 'unchanged' : 'blocked' };
  }
  if (!row.batch_complete && row.batch_hash === batchHash) {
    // An index of frozen membership lets source cleanup avoid decoding whole batches.
    // 32 identities use 66 bound parameters, below D1's 100-parameter limit.
    for (let first = 0; first < digest.papers.length; first += 32) {
      const papers = digest.papers.slice(first, first + 32);
      await session.prepare(`WITH membership(paper_id, version) AS (VALUES ${papers.map(() => '(?, ?)').join(', ')})
        INSERT INTO generation_paper_refs (generation_id, paper_id, version)
        SELECT g.id, p.paper_id, p.version FROM membership p CROSS JOIN working_generations w
        JOIN generation_inputs g ON g.id = w.generation_id JOIN users u ON u.id = w.user_id
        WHERE g.id = ? AND u.id = ? AND u.enabled = 1 AND g.batch_complete = 0 ON CONFLICT DO NOTHING`)
        .bind(...papers.flatMap(p => [p.id, p.version]), row.id, userId).run();
    }
    // Pages can be safely replayed after interruption; immutable chunks are never replaced.
    for (let first = 0; first < chunks; first += PAGE_CHUNKS) {
      await session.batch(Array.from({ length: Math.min(PAGE_CHUNKS, chunks - first) }, (_, index) => {
        const ordinal = first + index;
        return session.prepare(`INSERT INTO generation_batch_chunks (generation_id, ordinal, bytes)
          SELECT g.id, ?, ? FROM working_generations w JOIN generation_inputs g ON g.id = w.generation_id
          JOIN users u ON u.id = w.user_id
          WHERE g.id = ? AND u.id = ? AND u.enabled = 1 AND g.batch_complete = 0
          ON CONFLICT DO NOTHING`)
          .bind(ordinal, bytes.slice(ordinal * CHUNK_BYTES, (ordinal + 1) * CHUNK_BYTES).buffer, row.id, userId);
      }));
    }
    await readBatch(session, row);
    await session.prepare(`UPDATE generation_inputs SET batch_complete = 1 WHERE id = ?
      AND (SELECT count(*) FROM generation_paper_refs WHERE generation_id = generation_inputs.id) = ?
      AND EXISTS (SELECT 1 FROM working_generations w JOIN users u ON u.id = w.user_id
        WHERE w.generation_id = generation_inputs.id AND u.id = ? AND u.enabled = 1)`)
      .bind(row.id, digest.papers.length, userId).run();
  }
  const inputs = await readGenerationInputs(db, userId, row.id);
  return inputs ? { status: 'captured', inputs } : { status: 'blocked' };
}
