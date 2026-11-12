// Copyright 2026 Guilhem Ribeill
// SPDX-License-Identifier: Apache-2.0

import type { D1Database, D1DatabaseSession } from '@cloudflare/workers-types';
import type { Paper } from '../arxiv.ts';
import { createDigest, type Digest } from '../digest.ts';
import { parseConfig } from '../config-text.ts';
import { parseProfiles } from '../profile-text.ts';
import { readGenerationInputs, type GenerationInputs } from './generation-inputs.ts';
import type { ReadingMetadata } from './reading-store.ts';
import { voteCutoff } from './retention.ts';
import { withinRunWindow } from './run-window.ts';

export type StageResult = 'ready' | 'published' | 'conflict' | 'stale';
export type PublishResult = 'published' | 'not-ready' | 'stale';
interface ProjectionRow {
  ordinal: number; paper_id: string; paper_json: string;
  semantic_json: string; relevance_json: string; summary_json: string | null;
}
interface State { state: string; output_hash: string | null; current: string | null; working: string | null }
const PAGE_ROWS = 8;
const MAX_ROW_BYTES = 1024 * 1024;
// Canonical object keys make retries independent of JSON/driver property order.
const encode = (value: unknown) => JSON.stringify(value, (_key, item) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
const equal = (a: unknown, b: unknown) => encode(a) === encode(b);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const paperContent = (p: Paper) => [p.id, p.version, p.title, p.abstract, [...p.categories].sort(), p.authors ?? []];

function bounded(text: string): string {
  if (new TextEncoder().encode(text).length > MAX_ROW_BYTES) throw new Error('Reading projection row exceeds 1 MiB; refusing to truncate');
  return text;
}

/** Check completion and input identity, not recompute ranking. The future runner
 * must persist actual model/summary outcomes before supplying a completed digest.
 */
function projection(inputs: GenerationInputs, digest: Digest, cutoff: string): {
  metadata: string; rows: ProjectionRow[]; examples: { paperId: string; eventId: number; vector: string }[];
} {
  if (!inputs.batches) throw new Error('Posting batch is incomplete');
  const source = createDigest(inputs.batches);
  const ranking = digest.ranking, semantic = digest.semantic;
  if (!ranking || !semantic) throw new Error('A complete ranking is required for publication');
  const profiles = parseProfiles(inputs.interests.text);
  const config = parseConfig(inputs.config.text);
  if (digest.date !== source.date || !equal(digest.categories, source.categories) ||
      semantic.fingerprint !== inputs.modelIdentity || !equal(semantic.profiles, profiles) ||
      !equal(ranking.config.weights, config.scoring.weights) ||
      !equal(ranking.keywordProfiles, profiles.map(p => ({ id: p.id, keywords: p.keywords })))) {
    throw new Error('Digest does not match frozen generation inputs');
  }
  const feedback = ranking.feedbackSnapshot;
  const activeVotes = inputs.votes.filter(v => v.changedAt >= cutoff);
  const voteContent = (votes: { paper: Paper; value: number; createdAt: string }[]) => votes
    .map(v => [v.paper.id, paperContent(v.paper), v.value, v.createdAt]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  if ((activeVotes.length && !feedback) || (feedback && (
    feedback.fingerprint !== inputs.modelIdentity || feedback.capturedAt !== inputs.startedAt ||
    !equal(feedback.config, config.feedback) || !equal(voteContent(feedback.votes.filter(v => v.createdAt >= cutoff)), voteContent(activeVotes.map(v => ({
      paper: v.paper, value: v.value, createdAt: v.changedAt,
    }))))))) throw new Error('Feedback provenance does not match frozen inputs');
  const examples = (feedback?.examples ?? []).filter(e => e.createdAt >= cutoff).map(example => {
    const vote = activeVotes.find(v => v.paperId === example.paper.id);
    if (!vote || !equal(paperContent(vote.paper), paperContent(example.paper)) || vote.value !== example.value ||
        vote.changedAt !== example.createdAt || !Number.isSafeInteger(example.eventId) || !example.vector.length ||
        !example.vector.every(finite) || Math.abs(Math.hypot(...example.vector) - 1) > 1e-5) throw new Error('Invalid private feedback example');
    const vector = encode(example.vector);
    if (new TextEncoder().encode(vector).length > 65536) throw new Error('Feedback vector exceeds 64 KiB');
    return { paperId: example.paper.id, eventId: example.eventId, vector };
  });
  if (new Set(examples.map(e => e.paperId)).size !== examples.length) throw new Error('Duplicate feedback example');

  const sourceById = new Map(source.papers.map(p => [p.id, p]));
  const papersById = new Map(digest.papers.map(p => [p.id, p]));
  const featured = ranking.featured.map(p => p.id);
  const order = [...featured, ...ranking.remainingIds];
  if (featured.length !== Math.min(6, source.papers.length) || order.length !== source.papers.length ||
      new Set(order).size !== order.length || papersById.size !== digest.papers.length || papersById.size !== sourceById.size ||
      ranking.featured.some(p => !['relevant', 'adjacent', 'wildcard'].includes(p.role)) ||
      order.some(id => !sourceById.has(id) || !papersById.has(id) || !equal(paperContent(sourceById.get(id)!), paperContent(papersById.get(id)!)))) {
    throw new Error('Publication must contain every frozen paper exactly once');
  }
  for (const id of order) {
    const score = ranking.scores[id], sem = semantic.papers[id];
    if (!score || !sem || ![score.semantic, score.keywords, score.feedback, score.total, sem.score, sem.cosine].every(finite) ||
        profiles.some(p => !finite(sem.similarities[p.id])) || !profiles.some(p => p.id === sem.profileId)) {
      throw new Error('Missing or invalid saved paper scores');
    }
  }
  if (ranking.remainingIds.some(id => !finite(ranking.mmrScores[id]))) throw new Error('Missing remaining-paper order scores');
  for (const [id, summary] of Object.entries(digest.summaries ?? {})) {
    if (!featured.includes(id) || summary.paperId !== id || summary.version !== sourceById.get(id)!.version ||
        !['available', 'token_budget', 'api_unavailable', 'html_unavailable', 'summarization_error'].includes(summary.status) ||
        (summary.status === 'available' && !summary.summary?.trim())) throw new Error('Invalid summary outcome');
  }
  if (inputs.summariesRequested && featured.some(id => !digest.summaries?.[id])) throw new Error('Requested summary outcomes are incomplete');

  const { papers: _papers, ...semanticMetadata } = semantic;
  const { scores: _scores, remainingIds: _remaining, feedbackSnapshot: _feedback, ...rankingMetadata } = ranking;
  const meta: ReadingMetadata = { date: digest.date, categories: digest.categories, featuredIds: featured, paperCount: order.length,
    semantic: semanticMetadata, ranking: rankingMetadata };
  const metadata = bounded(encode(meta));
  const rows = order.map((id, ordinal): ProjectionRow => {
    const row = { ordinal, paper_id: id, paper_json: encode(sourceById.get(id)), semantic_json: encode(semantic.papers[id]),
      relevance_json: encode(ranking.scores[id]), summary_json: digest.summaries?.[id] ? encode(digest.summaries[id]) : null };
    bounded(encode(row)); // Aggregate row bound, not just one bound per column.
    return row;
  });
  return { metadata, rows, examples };
}

async function state(session: D1DatabaseSession, userId: string, generationId: string): Promise<State | null> {
  return session.prepare(`SELECT s.state, s.output_hash, c.listing_id AS current, w.generation_id AS working
    FROM generation_inputs s JOIN users u ON u.id = s.user_id
    LEFT JOIN current_readings c ON c.user_id = s.user_id
    LEFT JOIN working_generations w ON w.user_id = s.user_id
    WHERE s.user_id = ? AND s.id = ? AND u.enabled = 1`).bind(userId, generationId).first<State>();
}
function stageStatus(s: State | null, generationId: string, hash: string): StageResult | undefined {
  if (!s || (s.working !== generationId && s.current !== generationId) || s.state === 'failed') return 'stale';
  if (s.output_hash !== hash) return 'conflict';
  if (s.state === 'published') return s.current === generationId ? 'published' : 'stale';
  if (s.state === 'ready') return 'ready';
  return undefined;
}

/** Stage one immutable output for a trusted user's working generation. Replays
 * with identical content resume; competing different outputs cannot mix rows.
 * Nothing becomes visible until publishGeneration performs its pointer swap.
 */
export async function stagePublication(db: D1Database, userId: string, generationId: string, digest: Digest): Promise<StageResult> {
  digest = structuredClone(digest); // Caller mutation during persistence cannot change the candidate.
  const inputs = await readGenerationInputs(db, userId, generationId);
  if (!inputs) return 'stale';
  const cutoff = voteCutoff();
  const output = projection(inputs, digest, cutoff);
  if (inputs.action === 'summaries') {
    const original = await db.prepare(`SELECT r.metadata_json FROM reading_listings r JOIN current_readings c ON c.listing_id = r.id
      WHERE c.user_id = ? AND r.id = ?`).bind(userId, inputs.basePublication).first<{ metadata_json: string }>();
    if (!original || !equal(JSON.parse(original.metadata_json), JSON.parse(output.metadata))) throw new Error('Summary regeneration must preserve ranking');
    for (let first = 0; first < output.rows.length; first += PAGE_ROWS) {
      const rows = (await db.prepare(`SELECT ordinal,paper_id,paper_json,semantic_json,relevance_json FROM reading_papers
        WHERE listing_id = ? AND ordinal >= ? AND ordinal < ? ORDER BY ordinal`)
        .bind(inputs.basePublication, first, first + PAGE_ROWS).all<Omit<ProjectionRow, 'summary_json'>>()).results;
      const expected = output.rows.slice(first, first + PAGE_ROWS).map(({ summary_json: _summary, ...row }) => row);
      if (!equal(rows, expected)) throw new Error('Summary regeneration must preserve paper scores and order');
    }
  }
  // Expirable private provenance is deliberately not part of display identity.
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(encode({ metadata: output.metadata, rows: output.rows })))), b => b.toString(16).padStart(2, '0')).join('');
  const session = db.withSession('first-primary');
  if (inputs.summariesRequested) {
    const existing = await state(session, userId, generationId);
    if (existing?.output_hash && existing.output_hash !== hash) return 'conflict';
    const outcomes = (await session.prepare(`SELECT paper_id, ordinal, state, outcome_json FROM summary_outcomes
      WHERE generation_id = ? ORDER BY ordinal`).bind(generationId)
      .all<{ paper_id: string; ordinal: number; state: string; outcome_json: string | null }>()).results;
    const featured = digest.ranking!.featured;
    if (outcomes.length !== featured.length || outcomes.some((r, i) => r.ordinal !== i || r.paper_id !== featured[i].id ||
      r.state !== 'complete' || !r.outcome_json || !equal(JSON.parse(r.outcome_json), digest.summaries![r.paper_id]))) {
      throw new Error('Requested summary outcomes are not durably complete');
    }
  }
  await session.batch([
    session.prepare(`UPDATE generation_inputs SET output_hash = ?, paper_count = ?, state = 'staging'
      WHERE id = ? AND user_id = ? AND state = 'working' AND output_hash IS NULL AND batch_complete = 1
        AND ${withinRunWindow('generation_inputs.id')}
        AND NOT EXISTS (SELECT 1 FROM embedding_requests e WHERE e.generation_id = generation_inputs.id AND e.state = 'claimed')
        AND NOT EXISTS (SELECT 1 FROM summary_outcomes o WHERE o.generation_id = generation_inputs.id AND o.state != 'complete')
        AND (summaries_requested = 0 OR (SELECT count(*) FROM summary_outcomes o WHERE o.generation_id = generation_inputs.id) = ?)
        AND EXISTS (SELECT 1 FROM working_generations w JOIN users u ON u.id = w.user_id
          WHERE w.generation_id = generation_inputs.id AND u.id = ? AND u.enabled = 1)`)
      .bind(hash, output.rows.length, generationId, userId, Math.min(6, output.rows.length), userId),
    session.prepare(`INSERT INTO reading_listings (id, user_id, metadata_json)
      SELECT s.id, s.user_id, ? FROM generation_inputs s JOIN working_generations w ON w.generation_id = s.id
      JOIN users u ON u.id = s.user_id
      WHERE s.id = ? AND s.user_id = ? AND s.output_hash = ? AND s.state = 'staging' AND u.enabled = 1
        AND ${withinRunWindow('s.id')}
      ON CONFLICT DO NOTHING`).bind(output.metadata, generationId, userId, hash),
  ]);
  const initial = stageStatus(await state(session, userId, generationId), generationId, hash);
  if (initial) return initial;
  for (let first = 0; first < output.examples.length; first += PAGE_ROWS) {
    await session.batch(output.examples.slice(first, first + PAGE_ROWS).map(example => session.prepare(`INSERT INTO generation_feedback_examples
      (generation_id, paper_id, event_id, vector_json)
      SELECT s.id, v.paper_id, ?, ? FROM generation_inputs s
      JOIN working_generations w ON w.generation_id = s.id JOIN users u ON u.id = s.user_id
      JOIN generation_input_votes v ON v.generation_id = s.id
      WHERE s.id = ? AND s.user_id = ? AND s.output_hash = ? AND s.state = 'staging' AND u.enabled = 1
        AND v.paper_id = ? AND v.changed_at >= ? AND ${withinRunWindow('s.id')}
      ON CONFLICT (generation_id, paper_id) DO UPDATE SET vector_json = CASE
        WHEN generation_feedback_examples.event_id = excluded.event_id AND generation_feedback_examples.vector_json = excluded.vector_json
        THEN generation_feedback_examples.vector_json ELSE NULL END`)
      .bind(example.eventId, example.vector, generationId, userId, hash, example.paperId, cutoff)));
  }
  for (let first = 0; first < output.rows.length; first += PAGE_ROWS) {
    await session.batch(output.rows.slice(first, first + PAGE_ROWS).map(row => session.prepare(`INSERT INTO reading_papers
      (listing_id, ordinal, paper_id, paper_json, semantic_json, relevance_json, summary_json)
      SELECT s.id, ?, ?, ?, ?, ?, ? FROM generation_inputs s
      JOIN working_generations w ON w.generation_id = s.id JOIN users u ON u.id = s.user_id
      WHERE s.id = ? AND s.user_id = ? AND s.output_hash = ? AND s.state = 'staging' AND u.enabled = 1
        AND ${withinRunWindow('s.id')}
      ON CONFLICT DO NOTHING`).bind(row.ordinal, row.paper_id, row.paper_json, row.semantic_json, row.relevance_json,
      row.summary_json, generationId, userId, hash)));
  }
  const stored = await session.prepare('SELECT metadata_json FROM reading_listings WHERE id = ? AND user_id = ?')
    .bind(generationId, userId).first<{ metadata_json: string }>();
  if (stored?.metadata_json !== output.metadata) throw new Error('Staged publication metadata mismatch');
  for (let first = 0; first < output.rows.length; first += PAGE_ROWS) {
    const rows = (await session.prepare(`SELECT ordinal, paper_id, paper_json, semantic_json, relevance_json, summary_json
      FROM reading_papers WHERE listing_id = ? AND ordinal >= ? AND ordinal < ? ORDER BY ordinal`)
      .bind(generationId, first, first + PAGE_ROWS).all<ProjectionRow>()).results;
    if (!equal(rows, output.rows.slice(first, first + PAGE_ROWS))) {
      if (stageStatus(await state(session, userId, generationId), generationId, hash) === 'stale') return 'stale';
      throw new Error('Staged publication paper data mismatch');
    }
  }
  await session.prepare(`UPDATE generation_inputs SET state = 'ready'
    WHERE id = ? AND user_id = ? AND output_hash = ? AND state = 'staging' AND ${withinRunWindow('generation_inputs.id')}
      AND paper_count = (SELECT count(*) FROM reading_papers WHERE listing_id = generation_inputs.id)
      AND EXISTS (SELECT 1 FROM working_generations w JOIN users u ON u.id = w.user_id
        WHERE w.generation_id = generation_inputs.id AND u.id = ? AND u.enabled = 1)`)
    .bind(generationId, userId, hash, userId).run();
  const final = stageStatus(await state(session, userId, generationId), generationId, hash);
  if (!final) throw new Error('Staged publication is incomplete');
  return final;
}

/** Atomically publish only a sealed, still-current working generation. Rechecking
 * enabled state/ownership here fences stale workers even after staging succeeded.
 * Readers validate pinned projections and retry once if cleanup overtakes them.
 */
export async function publishGeneration(db: D1Database, userId: string, generationId: string): Promise<PublishResult> {
  const session = db.withSession('first-primary');
  await session.batch([
    session.prepare(`INSERT INTO current_readings (user_id, listing_id)
      SELECT s.user_id, s.id FROM generation_inputs s
      JOIN working_generations w ON w.user_id = s.user_id AND w.generation_id = s.id
      JOIN users u ON u.id = s.user_id
      JOIN reading_listings r ON r.id = s.id AND r.user_id = s.user_id
      WHERE s.user_id = ? AND s.id = ? AND s.state = 'ready' AND s.batch_complete = 1 AND u.enabled = 1
        AND ${withinRunWindow('s.id')}
        AND NOT EXISTS (SELECT 1 FROM embedding_requests e WHERE e.generation_id = s.id AND e.state = 'claimed')
        AND NOT EXISTS (SELECT 1 FROM summary_outcomes o WHERE o.generation_id = s.id AND o.state != 'complete')
        AND (s.summaries_requested = 0 OR (SELECT count(*) FROM summary_outcomes o WHERE o.generation_id = s.id) = min(6, s.paper_count))
        AND s.paper_count = (SELECT count(*) FROM reading_papers WHERE listing_id = s.id)
      ON CONFLICT (user_id) DO UPDATE SET listing_id = excluded.listing_id`).bind(userId, generationId),
    session.prepare(`UPDATE generation_inputs SET state = 'published' WHERE user_id = ? AND id = ? AND state = 'ready'
      AND EXISTS (SELECT 1 FROM current_readings c JOIN working_generations w ON w.user_id = c.user_id
        JOIN users u ON u.id = c.user_id WHERE c.user_id = generation_inputs.user_id
        AND c.listing_id = generation_inputs.id AND w.generation_id = c.listing_id AND u.enabled = 1)`)
      .bind(userId, generationId),
    session.prepare(`UPDATE generation_runs SET last_success_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), failure_reason = NULL
      WHERE user_id = ? AND generation_id = ? AND finished_at IS NULL
        AND EXISTS (SELECT 1 FROM generation_inputs g JOIN current_readings c ON c.listing_id = g.id
          WHERE g.id = generation_runs.generation_id AND c.user_id = generation_runs.user_id AND g.state = 'published')`)
      .bind(userId, generationId),
    session.prepare(`DELETE FROM working_generations WHERE user_id = ? AND generation_id = ?
      AND EXISTS (SELECT 1 FROM generation_inputs s JOIN current_readings c ON c.user_id = s.user_id
        WHERE s.id = working_generations.generation_id AND s.state = 'published' AND c.listing_id = s.id)`)
      .bind(userId, generationId),
  ]);
  const current = await state(session, userId, generationId);
  if (current?.state === 'published' && current.current === generationId) return 'published';
  return current?.working === generationId && current.state !== 'failed' ? 'not-ready' : 'stale';
}

export { failGeneration } from './generation-lifecycle.ts';
