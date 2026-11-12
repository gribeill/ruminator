// Copyright 2026 Guilhem Ribeill
// SPDX-License-Identifier: Apache-2.0

import type { D1Database } from '@cloudflare/workers-types';
import type { Paper } from '../arxiv.ts';
import { createDigest } from '../digest.ts';
import { paperEmbeddingInput, profileEmbeddingInput } from '../embeddings.ts';
import { parseProfiles } from '../profile-text.ts';
import { parseConfig } from '../config-text.ts';
import { SUMMARY_PROMPT_VERSION, summaryMessages, validateSummary, SummaryError, type SummaryConfig } from '../summary-content.ts';
import { withinRunWindow } from './run-window.ts';
import { readGenerationInputs } from './generation-inputs.ts';
import { readExtractedText, type SharedExtractedText, type PaperIdentity } from './source-store.ts';

export const HOSTED_VECTOR_DIMENSIONS = 384;
export const MAX_CACHED_SUMMARY_BYTES = 8192;
export { vector as validateHostedVector };
const encoder = new TextEncoder();
const ACTIVE = `SELECT 1 FROM working_generations w JOIN users u ON u.id = w.user_id
  WHERE w.generation_id = ? AND u.id = ? AND u.enabled = 1 AND ${withinRunWindow('w.generation_id')}`;
const RETAINED = `SELECT 1 FROM generation_inputs g JOIN users u ON u.id = g.user_id
  WHERE g.id = ? AND u.id = ? AND u.enabled = 1
    AND (EXISTS (SELECT 1 FROM working_generations w WHERE w.generation_id = g.id)
      OR EXISTS (SELECT 1 FROM current_readings c WHERE c.listing_id = g.id))`;
async function hash(value: unknown): Promise<string> {
  const bytes = encoder.encode(JSON.stringify(value));
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
}
function vector(value: unknown): number[] {
  if (!Array.isArray(value) || value.length !== HOSTED_VECTOR_DIMENSIONS ||
      !Array.from(value).every(v => typeof v === 'number' && Number.isFinite(v)) || Math.abs(Math.hypot(...value) - 1) > 1e-5) {
    throw new Error('Expected a finite normalized 384-dimensional hosted vector');
  }
  return value;
}

/** Choose authoritative scientific input, including older versions in frozen
 * feedback. The full model fingerprint comes from the generation, never a model
 * name supplied at cache lookup. No caller-supplied profile text can enter this cache.
 */
async function paperContext(db: D1Database, userId: string, generationId: string, identity: PaperIdentity, feedback: boolean) {
  const inputs = await readGenerationInputs(db, userId, generationId);
  if (!inputs?.batches) return undefined;
  const papers = feedback ? inputs.votes.map(v => v.paper) : createDigest(inputs.batches).papers;
  const paper = papers.find(p => p.id === identity.id && p.version === identity.version);
  if (!paper) return undefined;
  return { inputs, paper, inputHash: await hash(paperEmbeddingInput(paper)) };
}

/** Read completed scientific vectors only; a miss does not authorize inference. */
export async function readPaperVector(db: D1Database, userId: string, generationId: string, paper: PaperIdentity, feedback = false): Promise<number[] | undefined> {
  const context = await paperContext(db, userId, generationId, paper, feedback);
  if (!context) return undefined;
  const row = await db.prepare(`SELECT vector_json FROM paper_vectors
    WHERE paper_id = ? AND version = ? AND model_identity = ? AND input_hash = ? AND EXISTS (${RETAINED})`)
    .bind(paper.id, paper.version, context.inputs.modelIdentity, context.inputHash, generationId, userId).first<{ vector_json: string }>();
  return row ? vector(JSON.parse(row.vector_json)) : undefined;
}

/** First complete compatible result wins atomically. No pending cache row,
 * request claim, or provider call is created. Saving requires active work.
 */
export async function savePaperVector(db: D1Database, userId: string, generationId: string, paper: PaperIdentity, value: readonly number[], feedback = false): Promise<number[] | undefined> {
  const json = JSON.stringify(vector(value));
  const context = await paperContext(db, userId, generationId, paper, feedback);
  if (!context) return undefined;
  await db.prepare(`INSERT INTO paper_vectors (paper_id, version, model_identity, input_hash, vector_json)
    SELECT ?, ?, ?, ?, ? WHERE EXISTS (${ACTIVE}) ON CONFLICT DO NOTHING`)
    .bind(paper.id, paper.version, context.inputs.modelIdentity, context.inputHash, json, generationId, userId).run();
  return readPaperVector(db, userId, generationId, paper, feedback);
}

async function profileContext(db: D1Database, userId: string, generationId: string, profileId: string) {
  const inputs = await readGenerationInputs(db, userId, generationId);
  if (!inputs?.batches) return undefined;
  const profile = parseProfiles(inputs.interests.text).find(p => p.id === profileId);
  return profile ? { inputs, inputHash: await hash(profileEmbeddingInput(profile)) } : undefined;
}

/** Reuse only this user's compatible current/working profile results. A hit is
 * copied into the working generation atomically so retirement of the previous
 * publication cannot lose resumed progress. Published generations only read.
 */
export async function readProfileVector(db: D1Database, userId: string, generationId: string, profileId: string): Promise<number[] | undefined> {
  const context = await profileContext(db, userId, generationId, profileId);
  if (!context) return undefined;
  await db.prepare(`INSERT INTO generation_profile_vectors (generation_id, profile_id, input_hash, vector_json)
    SELECT ?, ?, p.input_hash, p.vector_json FROM generation_profile_vectors p JOIN generation_inputs g ON g.id = p.generation_id
    WHERE g.user_id = ? AND g.model_identity = ? AND p.input_hash = ? AND EXISTS (${ACTIVE})
      AND (EXISTS (SELECT 1 FROM working_generations w WHERE w.generation_id = g.id)
        OR EXISTS (SELECT 1 FROM current_readings c WHERE c.listing_id = g.id))
    LIMIT 1 ON CONFLICT DO NOTHING`)
    .bind(generationId, profileId, userId, context.inputs.modelIdentity, context.inputHash, generationId, userId).run();
  const row = await db.prepare(`SELECT vector_json FROM generation_profile_vectors
    WHERE generation_id = ? AND profile_id = ? AND input_hash = ? AND EXISTS (${RETAINED})`)
    .bind(generationId, profileId, context.inputHash, generationId, userId).first<{ vector_json: string }>();
  return row ? vector(JSON.parse(row.vector_json)) : undefined;
}
export async function saveProfileVector(db: D1Database, userId: string, generationId: string, profileId: string, value: readonly number[]): Promise<number[] | undefined> {
  const json = JSON.stringify(vector(value));
  const context = await profileContext(db, userId, generationId, profileId);
  if (!context) return undefined;
  await db.prepare(`INSERT INTO generation_profile_vectors (generation_id, profile_id, input_hash, vector_json)
    SELECT ?, ?, ?, ? WHERE EXISTS (${ACTIVE}) ON CONFLICT DO NOTHING`)
    .bind(generationId, profileId, context.inputHash, json, generationId, userId).run();
  return readProfileVector(db, userId, generationId, profileId);
}

export interface CachedSummary {
  cacheKey: string;
  summary: string;
  actualModel?: string;
  createdAt: string;
}
/** Derive identity from the actual frozen paper, verified pinned text, exact sent
 * messages, and frozen provider/model/output settings. Budget/token estimates
 * are not generation settings and do not invalidate successful scientific text.
 */
export async function summaryContext(db: D1Database, userId: string, generationId: string, paper: PaperIdentity, extractor: string) {
  const context = await paperContext(db, userId, generationId, paper, false);
  if (!context) return undefined;
  const source = await readExtractedText(db, userId, generationId, paper, extractor);
  if (source?.result.status !== 'available') return undefined;
  return frozenSummaryContext(context.paper, source, parseConfig((context.inputs.summaryConfig ?? context.inputs.config).text));
}

/** Internal fast path: paper/config from the validated frozen snapshot, source
 * from a verified generation pin. Never pass request-supplied content here.
 * SQL eligibility and pin checks still happen at cache/effect/write boundaries.
 */
export async function frozenSummaryContext(paper: Paper, source: SharedExtractedText, config: SummaryConfig) {
  if (source.result.status !== 'available' || !source.result.text || !source.result.contentHash ||
      source.result.paperId !== paper.id || source.result.version !== paper.version) throw new Error('Expected verified summary source');
  const identity = { paperId: paper.id, version: paper.version, textHash: source.result.contentHash, extractor: source.result.extractor,
    promptVersion: SUMMARY_PROMPT_VERSION, promptHash: await hash(summaryMessages(paper, source.result.text)),
    provider: config.llm.provider, model: config.llm.model, maxCompletionTokens: config.summaries.max_completion_tokens };
  const json = JSON.stringify(identity);
  if (encoder.encode(json).length > 16384) throw new Error('Summary identity exceeds 16 KiB');
  return { cacheKey: await hash(identity), json, identity, sourceId: source.id };
}
export function summaryText(value: unknown): string {
  if (typeof value !== 'string' || encoder.encode(value).length > MAX_CACHED_SUMMARY_BYTES) {
    throw new SummaryError('summarization_error', 'Summary exceeds the hosted 8 KiB byte limit');
  }
  return validateSummary(value);
}
interface SummaryRow { cache_key: string; summary: string; actual_model: string | null; created_at: string }
function summary(row: SummaryRow): CachedSummary {
  return { cacheKey: row.cache_key, summary: summaryText(row.summary), createdAt: row.created_at,
    ...(row.actual_model === null ? {} : { actualModel: row.actual_model }) };
}

/** Cache reads may pin compatible source text, but never reserve tokens or call
 * a provider. Failure/skip outcomes and request accounting do not belong here.
 */
export async function readCachedSummary(db: D1Database, userId: string, generationId: string, paper: PaperIdentity, extractor: string): Promise<CachedSummary | undefined> {
  const context = await summaryContext(db, userId, generationId, paper, extractor);
  return context ? readFrozenCachedSummary(db, userId, generationId, context) : undefined;
}

/** Reuse the derived identity, but freshly verify owner eligibility and the pin. */
export async function readFrozenCachedSummary(db: D1Database, userId: string, generationId: string,
  context: Awaited<ReturnType<typeof frozenSummaryContext>>): Promise<CachedSummary | undefined> {
  const row = await db.prepare(`SELECT cache_key, summary, actual_model, created_at FROM summary_cache
    WHERE cache_key = ? AND identity_json = ? AND EXISTS (${RETAINED})
      AND EXISTS (SELECT 1 FROM generation_text_refs WHERE generation_id = ? AND text_id = ?)`)
    .bind(context.cacheKey, context.json, generationId, userId, generationId, context.sourceId).first<SummaryRow>();
  return row ? summary(row) : undefined;
}

/** Accept only completed successful content, atomically and first-writer-wins.
 * This is result persistence, NOT permission to make a request. Execution must
 * claim/reserve first. summary-execution uses this same context/validation in an
 * atomic cache/outcome transaction, keeping per-user accounting separate.
 */
export async function saveCachedSummary(db: D1Database, userId: string, generationId: string, paper: PaperIdentity, extractor: string,
  result: { summary: string; actualModel?: string }): Promise<CachedSummary | undefined> {
  const text = summaryText(result.summary), actualModel = result.actualModel ?? null;
  if (actualModel !== null && (typeof actualModel !== 'string' || !actualModel.trim() || encoder.encode(actualModel).length > 1024)) {
    throw new Error('Invalid actual summary model');
  }
  const context = await summaryContext(db, userId, generationId, paper, extractor);
  if (!context) return undefined;
  await db.prepare(`INSERT INTO summary_cache (cache_key, paper_id, version, identity_json, summary, actual_model, created_at)
    SELECT ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE EXISTS (${ACTIVE})
      AND EXISTS (SELECT 1 FROM generation_text_refs r WHERE r.generation_id = ? AND r.text_id = ?)
    ON CONFLICT DO NOTHING`)
    .bind(context.cacheKey, paper.id, paper.version, context.json, text, actualModel, generationId, userId, generationId, context.sourceId).run();
  return readFrozenCachedSummary(db, userId, generationId, context);
}
