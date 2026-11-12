// Copyright 2026 Guilhem Ribeill
// SPDX-License-Identifier: Apache-2.0

import type { D1Database } from '@cloudflare/workers-types';
import { HOSTED_BGE_FINGERPRINT, validateEmbeddingBatch, embeddingResponse, type EmbeddingTransport } from './bge.ts';
import { validateHostedVector } from './inference-cache.ts';

export class EmbeddingPause extends Error {
  readonly reason: 'paused' | 'waiting';
  constructor(reason: 'paused' | 'waiting') { super(reason); this.reason = reason; }
}
import { withinRunWindow } from './run-window.ts';

export const activeEmbeddingWork = `SELECT 1 FROM working_generations w
  JOIN generation_inputs g ON g.id = w.generation_id JOIN users u ON u.id = w.user_id
  WHERE g.id = ? AND u.id = ? AND u.enabled = 1 AND g.state = 'working'
    AND g.batch_complete = 1 AND g.model_identity = ? AND ${withinRunWindow('g.id')}`;
export async function embeddingHash(value: unknown): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)))), b => b.toString(16).padStart(2, '0')).join('');
}
interface RequestRow { state: 'claimed' | 'complete'; vectors_json: string | null }
function completed(row: RequestRow, count: number): number[][] {
  const vectors = JSON.parse(row.vectors_json!);
  if (!Array.isArray(vectors) || vectors.length !== count) throw new Error('Invalid persisted embedding result');
  return vectors.map(validateHostedVector);
}

/** Called inside the effect, never from a cached Workflow admission result.
 * D1 serializes the conditional insert across generations. Complete scientific
 * requests can be reused; profiles include the owning user in the key. Another
 * user's active claim causes a bounded return to the caller, not polling/reclaim.
 */
export async function embeddingRequest(db: D1Database, userId: string, generationId: string,
  texts: string[], privateInput: boolean, transport: EmbeddingTransport, budget: { remaining: number }): Promise<number[][]> {
  texts = [...texts]; Object.freeze(texts);
  validateEmbeddingBatch(texts);
  if (!await db.prepare(activeEmbeddingWork).bind(generationId, userId, HOSTED_BGE_FINGERPRINT).first()) throw new Error('Embedding generation is no longer active');
  const key = await embeddingHash([HOSTED_BGE_FINGERPRINT, privateInput ? ['profile', userId] : ['paper'], texts]);
  const own = await db.prepare('SELECT state, vectors_json FROM embedding_requests WHERE generation_id = ? AND request_key = ?')
    .bind(generationId, key).first<RequestRow>();
  if (own?.state === 'claimed') throw new Error('Unresolved embedding attempt; generation must fail without retry');
  if (own) return completed(own, texts.length);
  const shared = await db.prepare("SELECT state, vectors_json FROM embedding_requests WHERE request_key = ? AND state = 'complete' LIMIT 1")
    .bind(key).first<RequestRow>();
  if (shared) return completed(shared, texts.length);
  if (budget.remaining <= 0) throw new EmbeddingPause('paused');
  const admitted = await db.prepare(`INSERT INTO embedding_requests (generation_id, request_key, state)
    SELECT ?, ?, 'claimed' WHERE EXISTS (${activeEmbeddingWork})
      AND NOT EXISTS (SELECT 1 FROM embedding_requests r
        JOIN working_generations w ON w.generation_id = r.generation_id WHERE r.request_key = ?)
      AND NOT EXISTS (SELECT 1 FROM embedding_requests r WHERE r.request_key = ? AND r.state = 'complete')
    ON CONFLICT DO NOTHING`)
    .bind(generationId, key, generationId, userId, HOSTED_BGE_FINGERPRINT, key, key).run();
  if (!admitted.meta.changes) {
    // No admission => no effect. A concurrent caller may have finished or still
    // be running. The next invocation will re-read the cache/claim from D1.
    throw new EmbeddingPause('waiting');
  }
  budget.remaining--;
  if (!await db.prepare(activeEmbeddingWork).bind(generationId, userId, HOSTED_BGE_FINGERPRINT).first()) throw new Error('Embedding generation is no longer active');
  const vectors = embeddingResponse(await transport(texts), texts.length);
  const json = JSON.stringify(vectors);
  // Retry only persistence while this response remains in memory, never transport.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const result = await db.prepare(`UPDATE embedding_requests SET state = 'complete', vectors_json = ?
        WHERE generation_id = ? AND request_key = ? AND state = 'claimed' AND EXISTS (${activeEmbeddingWork})`)
        .bind(json, generationId, key, generationId, userId, HOSTED_BGE_FINGERPRINT).run();
      if (result.meta.changes) return vectors;
      const stored = await db.prepare('SELECT state, vectors_json FROM embedding_requests WHERE generation_id = ? AND request_key = ?')
        .bind(generationId, key).first<RequestRow>();
      if (stored?.state === 'complete' && stored.vectors_json === json) return vectors;
      throw new Error('Embedding generation is no longer active');
    } catch (error) {
      if (attempt === 2) throw error;
    }
  }
  throw new Error('Embedding result was not persisted');
}
