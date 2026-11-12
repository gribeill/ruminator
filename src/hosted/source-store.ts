// Copyright 2026 Guilhem Ribeill
// SPDX-License-Identifier: Apache-2.0

import { withinRunWindow } from './run-window.ts';
import type { D1Database, D1DatabaseSession } from '@cloudflare/workers-types';
import type { Paper } from '../arxiv.ts';
import { MAX_HTML_BYTES, type CachedPaperText } from '../fulltext-types.ts';

export type PaperIdentity = Pick<Paper, 'id' | 'version'>;
export interface SharedPaperText extends CachedPaperText { id: string }
export type SharedExtractedText = Pick<SharedPaperText, 'id' | 'result'>;
export interface SharedHtml {
  id: string; html: string; contentHash: string; extractor: string; sourceUrl: string; checkedAt: string;
}
interface BlobData { hash: string; bytes: Uint8Array<ArrayBuffer>; chunks: number }
interface TextRow {
  id: string; paper_id: string; version: number; extractor: string; source_url: string; checked_at: string;
  status: 'available' | 'unavailable'; reason: string | null; html_hash: string | null; text_hash: string | null; complete: number;
}
const CHUNK_BYTES = 256 * 1024;
const PAGE_SIZE = 8;
const encoder = new TextEncoder();
async function hash(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
}
async function blob(text: string): Promise<BlobData> {
  const bytes = encoder.encode(text);
  return { hash: await hash(bytes), bytes, chunks: Math.ceil(bytes.length / CHUNK_BYTES) };
}

// Membership comes from the frozen batch, not a caller-supplied ownership field.
const WORKING_PAPER = `SELECT 1 FROM generation_paper_refs p
  JOIN working_generations w ON w.generation_id = p.generation_id JOIN users u ON u.id = w.user_id
  JOIN generation_inputs g ON g.id = p.generation_id
  WHERE u.id = ? AND u.enabled = 1 AND p.generation_id = ? AND p.paper_id = ? AND p.version = ? AND g.batch_complete = 1
    AND ${withinRunWindow('g.id')}`;
const RETAINED_PAPER = `SELECT 1 FROM generation_paper_refs p JOIN generation_inputs g ON g.id = p.generation_id
  JOIN users u ON u.id = g.user_id WHERE u.id = ? AND u.enabled = 1
  AND p.generation_id = ? AND p.paper_id = ? AND p.version = ? AND g.batch_complete = 1
  AND (EXISTS (SELECT 1 FROM working_generations w WHERE w.generation_id = g.id)
    OR EXISTS (SELECT 1 FROM current_readings c WHERE c.listing_id = g.id))`;
const ACTIVE_WRITE = `SELECT 1 FROM generation_text_refs r JOIN working_generations w ON w.generation_id = r.generation_id
  JOIN users u ON u.id = w.user_id WHERE r.generation_id = ? AND r.text_id = ? AND u.id = ? AND u.enabled = 1
    AND ${withinRunWindow('r.generation_id')}`;

/** Latest shared scientific metadata; frozen batches and votes retain their own
 * exact inputs. A refresh here never rewrites another user's scientific output.
 */
export async function saveSourcePaper(db: D1Database, userId: string, generationId: string, paper: Paper): Promise<boolean> {
  if (!paper.id || encoder.encode(paper.id).length > 128 || !Number.isSafeInteger(paper.version) || paper.version < 1 ||
      typeof paper.title !== 'string' || typeof paper.abstract !== 'string') throw new Error('Invalid paper metadata');
  const json = JSON.stringify({ id: paper.id, version: paper.version, title: paper.title, abstract: paper.abstract,
    categories: [...paper.categories].sort(), ...(paper.authors ? { authors: paper.authors } : {}) });
  const bytes = encoder.encode(json);
  if (bytes.length > 1024 * 1024) throw new Error('Paper metadata exceeds 1 MiB; refusing to truncate');
  const result = await db.prepare(`INSERT INTO source_papers (paper_id, version, metadata_json, metadata_hash)
    SELECT ?, ?, ?, ? WHERE EXISTS (${WORKING_PAPER})
    ON CONFLICT (paper_id, version) DO UPDATE SET metadata_json = excluded.metadata_json, metadata_hash = excluded.metadata_hash`)
    .bind(paper.id, paper.version, json, await hash(bytes), userId, generationId, paper.id, paper.version).run();
  return result.meta.changes === 1;
}

/** Shared metadata contains no interests/votes. A missing cache entry is ordinary. */
export async function readSourcePaper(db: D1Database, paper: PaperIdentity): Promise<Paper | undefined> {
  const row = await db.prepare('SELECT metadata_json, metadata_hash FROM source_papers WHERE paper_id = ? AND version = ?')
    .bind(paper.id, paper.version).first<{ metadata_json: string; metadata_hash: string }>();
  if (!row) return undefined;
  if (await hash(encoder.encode(row.metadata_json)) !== row.metadata_hash) throw new Error('Paper metadata checksum mismatch');
  return JSON.parse(row.metadata_json) as Paper;
}

async function reference(session: D1DatabaseSession, userId: string, generationId: string, paper: PaperIdentity, extractor: string): Promise<TextRow | null> {
  return session.prepare(`SELECT t.* FROM generation_text_refs r JOIN source_texts t ON t.id = r.text_id
    WHERE r.generation_id = ? AND r.paper_id = ? AND r.version = ? AND r.extractor = ? AND EXISTS (${RETAINED_PAPER})`)
    .bind(generationId, paper.id, paper.version, extractor, userId, generationId, paper.id, paper.version).first<TextRow>();
}

async function readBlob(session: D1DatabaseSession, id: string, requireComplete = true): Promise<string> {
  const info = await session.prepare('SELECT byte_length, chunk_count, complete FROM source_blobs WHERE hash = ?')
    .bind(id).first<{ byte_length: number; chunk_count: number; complete: number }>();
  if (!info || (requireComplete && !info.complete)) throw new Error('Incomplete source content');
  if (info.chunk_count !== Math.ceil(info.byte_length / CHUNK_BYTES)) throw new Error('Invalid source chunk count');
  const bytes = new Uint8Array(info.byte_length);
  let offset = 0;
  for (let first = 0; first < info.chunk_count; first += PAGE_SIZE) {
    const rows = (await session.prepare(`SELECT ordinal, bytes FROM source_blob_chunks
      WHERE hash = ? AND ordinal >= ? AND ordinal < ? ORDER BY ordinal`)
      .bind(id, first, Math.min(first + PAGE_SIZE, info.chunk_count)).all<{ ordinal: number; bytes: number[] }>()).results;
    if (rows.length !== Math.min(PAGE_SIZE, info.chunk_count - first)) throw new Error('Incomplete source chunks');
    for (const [index, row] of rows.entries()) {
      const chunk = new Uint8Array(row.bytes);
      if (row.ordinal !== first + index || chunk.length !== Math.min(CHUNK_BYTES, info.byte_length - offset)) throw new Error('Invalid source chunk');
      bytes.set(chunk, offset); offset += chunk.length;
    }
  }
  if (offset !== info.byte_length || await hash(bytes) !== id) throw new Error('Source content checksum mismatch');
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}
async function extracted(session: D1DatabaseSession, row: TextRow): Promise<SharedExtractedText | undefined> {
  if (!row.complete) return undefined;
  return { id: row.id, result: {
    paperId: row.paper_id, version: row.version, extractor: row.extractor, sourceUrl: row.source_url,
    checkedAt: row.checked_at, status: row.status,
    ...(row.text_hash === null ? { reason: row.reason! } : { text: await readBlob(session, row.text_hash), contentHash: row.text_hash }),
  } };
}

async function materialize(session: D1DatabaseSession, row: TextRow): Promise<SharedPaperText | undefined> {
  const text = await extracted(session, row);
  return text ? { ...text, html: row.html_hash === null ? null : await readBlob(session, row.html_hash) } : undefined;
}

async function pinCachedText(session: D1DatabaseSession, userId: string, generationId: string, paper: PaperIdentity, extractor: string): Promise<void> {
  await session.prepare(`INSERT INTO generation_text_refs (generation_id, paper_id, version, extractor, text_id)
    SELECT ?, c.paper_id, c.version, c.extractor, c.text_id FROM source_text_cache c JOIN source_texts t ON t.id = c.text_id
    WHERE c.paper_id = ? AND c.version = ? AND c.extractor = ? AND t.complete = 1 AND EXISTS (${WORKING_PAPER})
    ON CONFLICT DO NOTHING`).bind(generationId, paper.id, paper.version, extractor, userId, generationId, paper.id, paper.version).run();
}

/** Pin a compatible shared outcome for this working generation. Current readers
 * may inspect an existing pin but cannot attach new scientific inputs. Both
 * failures and successes are cache hits; undefined includes incomplete staging.
 */
export async function readSourceText(db: D1Database, userId: string, generationId: string, paper: PaperIdentity, extractor: string): Promise<SharedPaperText | undefined> {
  const session = db.withSession('first-primary');
  await pinCachedText(session, userId, generationId, paper, extractor);
  const row = await reference(session, userId, generationId, paper, extractor);
  return row ? materialize(session, row) : undefined;
}

/** Same membership/pin checks and text hash verification as readSourceText,
 * without reading raw HTML. Summary execution/cache lookup need only this data.
 */
export async function readExtractedText(db: D1Database, userId: string, generationId: string, paper: PaperIdentity,
  extractor: string): Promise<SharedExtractedText | undefined> {
  const session = db.withSession('first-primary');
  await pinCachedText(session, userId, generationId, paper, extractor);
  const row = await reference(session, userId, generationId, paper, extractor);
  return row ? extracted(session, row) : undefined;
}

/** Recover raw HTML from a cached extractor revision for offline re-extraction.
 * A verified raw blob is usable even if persisting its extracted text was
 * interrupted. This never downloads a paper or invents a completed text outcome.
 */
export async function readSourceHtml(db: D1Database, userId: string, generationId: string, paper: PaperIdentity): Promise<SharedHtml | undefined> {
  const session = db.withSession('first-primary');
  const candidate = await session.prepare(`SELECT t.extractor FROM source_texts t JOIN source_blobs b ON b.hash = t.html_hash
    WHERE t.paper_id = ? AND t.version = ? AND b.complete = 1
      AND (EXISTS (SELECT 1 FROM generation_text_refs r WHERE r.generation_id = ? AND r.text_id = t.id)
        OR (t.complete = 1 AND EXISTS (SELECT 1 FROM source_text_cache c WHERE c.text_id = t.id)))
      AND EXISTS (${RETAINED_PAPER})
    ORDER BY CASE WHEN EXISTS (SELECT 1 FROM generation_text_refs r WHERE r.generation_id = ? AND r.text_id = t.id) THEN 0 ELSE 1 END,
      t.checked_at DESC, t.id LIMIT 1`)
    .bind(paper.id, paper.version, generationId, userId, generationId, paper.id, paper.version, generationId).first<{ extractor: string }>();
  if (!candidate) return undefined;
  await pinCachedText(session, userId, generationId, paper, candidate.extractor);
  const row = await reference(session, userId, generationId, paper, candidate.extractor);
  if (!row?.html_hash) return undefined;
  return { id: row.id, html: await readBlob(session, row.html_hash), contentHash: row.html_hash,
    extractor: row.extractor, sourceUrl: row.source_url, checkedAt: row.checked_at };
}

/** Persist already downloaded/extracted scientific data, with no network or
 * provider calls. Explicit failure retries may replace only this working pin;
 * successful outcomes and other users' associations stay immutable. A failed
 * retry retains prior raw HTML for later re-extraction.
 */
export async function saveSourceText(db: D1Database, userId: string, generationId: string, paper: Paper, input: CachedPaperText,
  { retryUnavailable = false }: { retryUnavailable?: boolean } = {}): Promise<SharedPaperText | undefined> {
  paper = structuredClone(paper); input = structuredClone(input);
  const result = input.result;
  if (input.html !== null && typeof input.html !== 'string') throw new Error('HTML must be text or null');
  if (result.paperId !== paper.id || result.version !== paper.version || !result.extractor.trim() || result.extractor.length > 256 ||
      !result.sourceUrl || result.sourceUrl.length > 4096 || !Number.isFinite(Date.parse(result.checkedAt)) ||
      !['available', 'unavailable'].includes(result.status)) throw new Error('Invalid source outcome identity');
  result.checkedAt = new Date(result.checkedAt).toISOString();
  const cached = await readSourceText(db, userId, generationId, paper, result.extractor);
  if (cached && (cached.result.status === 'available' || !retryUnavailable)) return cached;
  if (result.status === 'unavailable') {
    if (!result.reason?.trim() || encoder.encode(result.reason).length > 65536 || result.text !== undefined) throw new Error('Invalid unavailable source outcome');
    if (input.html === null && cached?.html !== null && cached?.html !== undefined) input.html = cached.html;
  } else if (input.html === null || !result.text?.trim()) throw new Error('Available source requires full HTML and extracted text');
  if (input.html !== null && encoder.encode(input.html).length > MAX_HTML_BYTES) throw new Error('HTML exceeds 16 MiB; refusing to truncate');
  const html = input.html === null ? null : await blob(input.html);
  const text = result.status === 'available' ? await blob(result.text!) : null;
  if (result.contentHash !== undefined && result.contentHash !== text?.hash) throw new Error('Extracted text hash mismatch');
  if (!await saveSourcePaper(db, userId, generationId, paper)) return undefined;
  const session = db.withSession('first-primary');
  let existing = await reference(session, userId, generationId, paper, result.extractor);
  if (existing?.complete && (!cached || existing.id !== cached.id || existing.status === 'available' || !retryUnavailable)) {
    return materialize(session, existing); // Another writer won; do not overwrite its newer retry.
  }
  const descriptor = { paper_id: paper.id, version: paper.version, extractor: result.extractor, source_url: result.sourceUrl,
    checked_at: result.checkedAt, status: result.status, reason: result.status === 'unavailable' ? result.reason! : null,
    html_hash: html?.hash ?? null, text_hash: text?.hash ?? null };
  let id = await hash(encoder.encode(JSON.stringify(descriptor)));
  if (existing && !existing.complete) {
    // On replay the caller's clock may differ, but payload/identity must not.
    const { checked_at: _time, ...content } = descriptor;
    if (Object.entries(content).some(([key, value]) => existing![key as keyof TextRow] !== value)) throw new Error('Resume source staging with the original content');
    id = existing.id;
  }
  const blobs = [...new Map([html, text].filter((b): b is BlobData => b !== null).map(b => [b.hash, b])).values()];
  await session.batch([
    ...blobs.map(b => session.prepare(`INSERT INTO source_blobs (hash, byte_length, chunk_count)
      SELECT ?, ?, ? WHERE EXISTS (${WORKING_PAPER}) ON CONFLICT DO NOTHING`)
      .bind(b.hash, b.bytes.length, b.chunks, userId, generationId, paper.id, paper.version)),
    session.prepare(`INSERT INTO source_texts
      (id, paper_id, version, extractor, source_url, checked_at, status, reason, html_hash, text_hash)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (${WORKING_PAPER}) ON CONFLICT DO NOTHING`)
      .bind(id, paper.id, paper.version, result.extractor, result.sourceUrl, result.checkedAt, descriptor.status, descriptor.reason,
        descriptor.html_hash, descriptor.text_hash, userId, generationId, paper.id, paper.version),
    session.prepare(`INSERT INTO generation_text_refs (generation_id, paper_id, version, extractor, text_id)
      SELECT ?, ?, ?, ?, ? WHERE EXISTS (${WORKING_PAPER})
      ON CONFLICT (generation_id, paper_id, version, extractor) DO UPDATE SET text_id = excluded.text_id
      WHERE generation_text_refs.text_id = ?`)
      .bind(generationId, paper.id, paper.version, result.extractor, id, userId, generationId, paper.id, paper.version, existing?.id ?? null),
  ]);
  existing = await reference(session, userId, generationId, paper, result.extractor);
  if (!existing || existing.id !== id) return existing ? materialize(session, existing) : undefined;
  for (const b of blobs) {
    for (let first = 0; first < b.chunks; first += PAGE_SIZE) {
      await session.batch(Array.from({ length: Math.min(PAGE_SIZE, b.chunks - first) }, (_, index) => {
        const ordinal = first + index;
        return session.prepare(`INSERT INTO source_blob_chunks (hash, ordinal, bytes)
          SELECT hash, ?, ? FROM source_blobs WHERE hash = ? AND complete = 0 AND EXISTS (${ACTIVE_WRITE}) ON CONFLICT DO NOTHING`)
          .bind(ordinal, b.bytes.slice(ordinal * CHUNK_BYTES, (ordinal + 1) * CHUNK_BYTES).buffer, b.hash, generationId, id, userId);
      }));
    }
    if (!await session.prepare(ACTIVE_WRITE).bind(generationId, id, userId).first()) return undefined;
    await readBlob(session, b.hash, false);
    await session.prepare(`UPDATE source_blobs SET complete = 1 WHERE hash = ? AND EXISTS (${ACTIVE_WRITE})`)
      .bind(b.hash, generationId, id, userId).run();
  }
  await session.batch([
    session.prepare(`UPDATE source_texts SET complete = 1 WHERE id = ? AND EXISTS (${ACTIVE_WRITE})
      AND (html_hash IS NULL OR EXISTS (SELECT 1 FROM source_blobs b WHERE b.hash = html_hash AND b.complete = 1))
      AND (text_hash IS NULL OR EXISTS (SELECT 1 FROM source_blobs b WHERE b.hash = text_hash AND b.complete = 1))`)
      .bind(id, generationId, id, userId),
    session.prepare(`INSERT INTO source_text_cache (paper_id, version, extractor, text_id)
      SELECT paper_id, version, extractor, id FROM source_texts WHERE id = ? AND complete = 1 AND EXISTS (${ACTIVE_WRITE})
      ON CONFLICT (paper_id, version, extractor) DO UPDATE SET text_id = excluded.text_id
      WHERE (SELECT status FROM source_texts WHERE id = source_text_cache.text_id) != 'available'
        OR (SELECT status FROM source_texts WHERE id = excluded.text_id) = 'available'`)
      .bind(id, generationId, id, userId),
  ]);
  const completed = await reference(session, userId, generationId, paper, result.extractor);
  return completed ? materialize(session, completed) : undefined;
}
