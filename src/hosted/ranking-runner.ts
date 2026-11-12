// Copyright 2026 Guilhem Ribeill
// SPDX-License-Identifier: Apache-2.0

import type { D1Database } from '@cloudflare/workers-types';
import type { Paper } from '../arxiv.ts';
import type { Profile } from '../profile-text.ts';
import { parseProfiles } from '../profile-text.ts';
import { parseConfig } from '../config-text.ts';
import { summaryReplacement } from './summary-regeneration.ts';
import { createDigest, type Digest } from '../digest.ts';
import { averageVectors, paperEmbeddingInput, profileEmbeddingInput, type EmbeddingInput } from '../embeddings.ts';
import { scorePaper } from '../semantic-scoring.ts';
import { rankPapers } from '../ranking.ts';
import type { FeedbackSnapshot } from '../feedback.ts';
import { readGenerationInputs, type GenerationInputs } from './generation-inputs.ts';
import { validateHostedVector } from './inference-cache.ts';
import { HOSTED_BGE_FINGERPRINT, EMBEDDING_BATCH_SIZE, embeddingChunks, type EmbeddingTransport } from './bge.ts';
import { activeEmbeddingWork, embeddingHash, embeddingRequest, EmbeddingPause } from './embedding-requests.ts';
import { failGeneration, stagePublication, publishGeneration } from './publication.ts';
import { cleanupHostedState } from './retention.ts';
import { executeFrozenSummaries, type SummaryExecution } from './summary-execution.ts';

/** Ranking-only entry retains an explicit no-summary contract. */
export function runHostedRanking(db: D1Database, userId: string, generationId: string, transport: EmbeddingTransport,
  maxRequests = 8): Promise<RankingRunResult> {
  return runHostedGeneration(db, userId, generationId, { embedding: transport }, maxRequests);
}

export interface GenerationAdapters { embedding: EmbeddingTransport; summaries?: SummaryExecution }
export type GenerationAdapterContext = Pick<GenerationInputs, 'id' | 'userId' | 'summariesRequested'>;

export type RankingRunResult = 'published' | 'paused' | 'waiting' | 'failed' | 'stale';
interface Entry { input: EmbeddingInput; hash: string; paper?: Paper; profile?: Profile; feedback: boolean; vector?: number[] }
const cacheKey = (paper: Paper, hash: string) => JSON.stringify([paper.id, paper.version, hash]);

/** Internal effect runner, never an HTTP action or automatic admission loop.
 * Caller supplies an already frozen generation and an explicitly authorized
 * transport. Defaults to eight actual requests per invocation. Pauses happen
 * only before admission; no unresolved admitted effect is retried on resumption.
 * Reentrant calls for the same generation may conservatively fail it rather
 * than risk repeating an in-flight request. The Workflow serializes them.
 * The admission caller owns beginning-of-run maintenance; continuations never
 * sweep global retention. Successful publication performs bounded end cleanup.
 */
export async function runHostedGeneration(db: D1Database, userId: string, generationId: string,
  adapters: GenerationAdapters | ((context: GenerationAdapterContext) => GenerationAdapters), maxRequests = 8): Promise<RankingRunResult> {
  if (!Number.isSafeInteger(maxRequests) || maxRequests < 1 || maxRequests > 16) throw new Error('Expected 1–16 embedding requests per invocation');
  const inputs = await readGenerationInputs(db, userId, generationId);
  if (!inputs) return 'stale';
  if (!inputs.batches) return 'paused';
  // Adapter setup needs references/intent, not another copy of private inputs.
  const { embedding: transport, summaries } = typeof adapters === 'function'
    ? adapters({ id: inputs.id, userId: inputs.userId, summariesRequested: inputs.summariesRequested }) : adapters;
  if (inputs.action !== 'summaries' && inputs.modelIdentity !== HOSTED_BGE_FINGERPRINT) throw new Error('Runner requires its hosted fingerprint');
  if (inputs.summariesRequested !== Boolean(summaries)) {
    throw new Error('Summary intent requires matching explicit adapters; ranking-only execution requires no requested summaries');
  }
  const state = await db.prepare('SELECT state FROM generation_inputs WHERE id = ?').bind(generationId).first<{ state: string }>();
  if (state?.state === 'published' || state?.state === 'ready') return await publishGeneration(db, userId, generationId) === 'published' ? 'published' : 'stale';
  try {
    if (inputs.action === 'summaries') {
      const digest = await summaryReplacement(db, inputs);
      const progress = await executeFrozenSummaries(db, inputs, digest, { ...summaries!, retryUnavailableSource: true });
      return progress === 'complete' ? await finishGeneration(db, userId, generationId, digest) : progress;
    }
    if (await db.prepare("SELECT 1 FROM embedding_requests WHERE generation_id = ? AND state = 'claimed' LIMIT 1").bind(generationId).first()) {
      throw new Error('Interrupted embedding attempt; refusing to resend');
    }
    const digest = createDigest(inputs.batches), profiles = parseProfiles(inputs.interests.text), config = parseConfig(inputs.config.text);
    const entries: Entry[] = [];
    // No candidate papers means no scoring work, including profile/feedback
    // embeddings. Keep the frozen vote metadata, but no vectors are needed.
    if (digest.papers.length) {
      for (const vote of inputs.votes) entries.push({ paper: vote.paper, feedback: true, input: paperEmbeddingInput(vote.paper), hash: '' });
      for (const profile of profiles) entries.push({ profile, feedback: false, input: profileEmbeddingInput(profile), hash: '' });
      for (const paper of digest.papers) entries.push({ paper, feedback: false, input: paperEmbeddingInput(paper), hash: '' });
    }
    for (const entry of entries) entry.hash = await embeddingHash(entry.input);
    // Exact tuples bound result size: <=32 rows and 97 parameters per query.
    // Do not reload/decode the whole generation for each cached scientific paper.
    const paperEntries = entries.filter(e => e.paper);
    const cached = new Map<string, number[]>();
    for (let first = 0; first < paperEntries.length; first += 32) {
      const page = paperEntries.slice(first, first + 32);
      const rows = (await db.prepare(`SELECT paper_id, version, input_hash, vector_json FROM paper_vectors
        WHERE model_identity = ? AND (paper_id, version, input_hash) IN (${page.map(() => '(?, ?, ?)').join(',')})`)
        .bind(HOSTED_BGE_FINGERPRINT, ...page.flatMap(e => [e.paper!.id, e.paper!.version, e.hash]))
        .all<{ paper_id: string; version: number; input_hash: string; vector_json: string }>()).results;
      for (const row of rows) cached.set(JSON.stringify([row.paper_id, row.version, row.input_hash]), validateHostedVector(JSON.parse(row.vector_json)));
    }
    // Inputs were already authenticated, sealed, and parsed once. Keep cache SQL
    // bounded instead of reloading every vote/batch for each individual vector.
    const persist = async (entry: Entry, value: number[]): Promise<number[]> => {
      const json = JSON.stringify(validateHostedVector(value));
      if (entry.paper) {
        await db.prepare(`INSERT INTO paper_vectors (paper_id, version, model_identity, input_hash, vector_json)
          SELECT ?, ?, ?, ?, ? WHERE EXISTS (${activeEmbeddingWork}) ON CONFLICT DO NOTHING`)
          .bind(entry.paper.id, entry.paper.version, inputs.modelIdentity, entry.hash, json, generationId, userId, inputs.modelIdentity).run();
        const row = await db.prepare('SELECT vector_json FROM paper_vectors WHERE paper_id = ? AND version = ? AND model_identity = ? AND input_hash = ?')
          .bind(entry.paper.id, entry.paper.version, inputs.modelIdentity, entry.hash).first<{ vector_json: string }>();
        if (!row) throw new Error('Generation stopped before vector persistence');
        return validateHostedVector(JSON.parse(row.vector_json));
      }
      await db.prepare(`INSERT INTO generation_profile_vectors (generation_id, profile_id, input_hash, vector_json)
        SELECT ?, ?, ?, ? WHERE EXISTS (${activeEmbeddingWork}) ON CONFLICT DO NOTHING`)
        .bind(generationId, entry.profile!.id, entry.hash, json, generationId, userId, inputs.modelIdentity).run();
      const row = await db.prepare('SELECT vector_json FROM generation_profile_vectors WHERE generation_id = ? AND profile_id = ? AND input_hash = ?')
        .bind(generationId, entry.profile!.id, entry.hash).first<{ vector_json: string }>();
      if (!row) throw new Error('Generation stopped before vector persistence');
      return validateHostedVector(JSON.parse(row.vector_json));
    };
    const budget = { remaining: maxRequests };
    for (const entry of entries) {
      if (entry.paper) entry.vector = cached.get(cacheKey(entry.paper, entry.hash));
      else {
        const row = await db.prepare(`SELECT p.vector_json FROM generation_profile_vectors p JOIN generation_inputs g ON g.id = p.generation_id
          WHERE g.user_id = ? AND g.model_identity = ? AND p.input_hash = ?
            AND (EXISTS (SELECT 1 FROM working_generations w WHERE w.generation_id = g.id)
              OR EXISTS (SELECT 1 FROM current_readings c WHERE c.listing_id = g.id)) LIMIT 1`)
          .bind(userId, inputs.modelIdentity, entry.hash).first<{ vector_json: string }>();
        if (row) entry.vector = await persist(entry, validateHostedVector(JSON.parse(row.vector_json)));
      }
      if (entry.vector) continue;
      const chunks = embeddingChunks(entry.input), vectors: number[][] = [];
      for (let first = 0; first < chunks.length; first += EMBEDDING_BATCH_SIZE) {
        vectors.push(...await embeddingRequest(db, userId, generationId, chunks.slice(first, first + EMBEDDING_BATCH_SIZE), !!entry.profile, transport, budget));
      }
      const result = validateHostedVector(averageVectors(vectors, 384));
      entry.vector = await persist(entry, result);
      if (entry.paper) cached.set(cacheKey(entry.paper, entry.hash), entry.vector);
    }
    const queries = entries.filter(e => e.profile).map(e => e.vector!);
    const vectors = Object.fromEntries(entries.filter(e => e.paper && !e.feedback).map(e => [e.paper!.id, e.vector!]));
    digest.semantic = { fingerprint: inputs.modelIdentity, normalization: 'cosine-affine-v1', profiles,
      papers: Object.fromEntries(digest.papers.map(p => [p.id, scorePaper(profiles, queries, vectors[p.id])])) };
    const votes = inputs.votes.map((v, index) => ({ eventId: index + 1, paper: v.paper, value: v.value, createdAt: v.changedAt }));
    const feedback: FeedbackSnapshot = { fingerprint: inputs.modelIdentity, capturedAt: inputs.startedAt, config: config.feedback,
      votes, examples: digest.papers.length ? votes.map((v, index) => ({ ...v, vector: entries[index].vector! })) : [] };
    digest.ranking = rankPapers(digest, digest.semantic, vectors, profiles, config.scoring.weights, feedback);
    if (summaries) {
      const progress = await executeFrozenSummaries(db, inputs, digest, summaries);
      if (progress !== 'complete') return progress;
    }
    return await finishGeneration(db, userId, generationId, digest);
  } catch (error) {
    if (error instanceof EmbeddingPause) return error.reason;
    // Invalid responses, transport failures and unresolved attempts preserve the
    // prior publication. A later separately admitted generation may try again.
    await failGeneration(db, userId, generationId);
    return 'failed';
  }
}

async function finishGeneration(db: D1Database, userId: string, generationId: string, digest: Digest): Promise<RankingRunResult> {
  const staged = await stagePublication(db, userId, generationId, digest);
  if (staged !== 'ready' && staged !== 'published') throw new Error('Generation could not stage its ranking');
  if (await publishGeneration(db, userId, generationId) !== 'published') return 'stale';
  // Maintenance failure cannot turn a committed publication into failed work.
  try { await cleanupHostedState(db, new Date(), 2); } catch { /* Next admission resumes maintenance. */ }
  return 'published';
}
