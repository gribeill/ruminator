// Copyright 2026 Guilhem Ribeill
// SPDX-License-Identifier: Apache-2.0

import type { D1Database } from '@cloudflare/workers-types';
import type { Paper } from '../arxiv.ts';
import { createDigest, type Digest } from '../digest.ts';
import { parseConfig } from '../config-text.ts';
import { estimatePromptTokens } from '../tokenizer.ts';
import { HTML_EXTRACTOR, type CachedPaperText } from '../fulltext-types.ts';
import { SummaryError, summaryMessages, type PaperSummary, type SummaryConfig,
  type SummaryProvider, type SummaryUsage } from '../summary-content.ts';
import { withinRunWindow } from './run-window.ts';
import { readGenerationInputs, type GenerationInputs } from './generation-inputs.ts';
import { readExtractedText, saveSourceText } from './source-store.ts';
import { readFrozenCachedSummary, frozenSummaryContext, summaryText } from './inference-cache.ts';

export interface SummaryExecution {
  /** Explicitly authorized factory. Must disable transport/Gateway retries and fallbacks. */
  createProvider(config: SummaryConfig): SummaryProvider;
  /** Optional source adapter. Tests supply recorded extraction; no default network access. */
  loadSource?(paper: Paper): Promise<CachedPaperText>;
  extractor?: string;
  /** Explicit source-only refresh for pending papers, never a retry of a model outcome. */
  retryUnavailableSource?: boolean;
  maxRequests?: number;
}
export type SummaryProgress = 'complete' | 'paused' | 'waiting';
interface Row {
  paper_id: string; version: number; ordinal: number; state: 'pending' | 'claimed' | 'complete';
  outcome_json: string | null; created_at: string;
}
const ACTIVE = `SELECT 1 FROM generation_inputs g JOIN working_generations w ON w.generation_id = g.id
  JOIN users u ON u.id = g.user_id WHERE g.id = ? AND g.user_id = ? AND u.enabled = 1
  AND g.state = 'working' AND g.batch_complete = 1 AND g.summaries_requested = 1 AND ${withinRunWindow('g.id')}`;
const SHARED = `SELECT 1 FROM summary_outcomes o JOIN working_generations w ON w.generation_id = o.generation_id
  WHERE o.cache_key = ? AND o.state = 'claimed'`;
const SPENT = `SELECT coalesce(sum(charged_input), 0) FROM summary_outcomes WHERE generation_id = ?`;
const STOPPED = `SELECT 1 FROM summary_outcomes WHERE generation_id = ? AND budget_stopped = 1`;
const bytes = (value: string) => new TextEncoder().encode(value).length;
function encode(outcome: PaperSummary): string {
  const json = JSON.stringify(outcome);
  if (bytes(json) > 16384) throw new Error('Summary outcome exceeds 16 KiB');
  return json;
}
function usage(value: SummaryUsage | undefined): SummaryUsage | undefined {
  if (value === undefined) return undefined;
  if (![value.inputTokens, value.outputTokens, ...(value.reasoningTokens === undefined ? [] : [value.reasoningTokens])]
    .every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error('Invalid summary usage');
  return { inputTokens: value.inputTokens, outputTokens: value.outputTokens,
    ...(value.reasoningTokens === undefined ? {} : { reasoningTokens: value.reasoningTokens }) };
}

/** Run sequential featured summaries against frozen inputs. Serialize calls for
 * one generation. Own unresolved claims become unavailable, never another call.
 * Other users' claims are only observed. Budget is the sum of durable reservations,
 * not reported provider usage, and is never refunded. No admission loop or endpoint.
 */
export async function executeHostedSummaries(db: D1Database, userId: string, generationId: string,
  digest: Digest, execution: SummaryExecution): Promise<SummaryProgress> {
  const inputs = await readGenerationInputs(db, userId, generationId);
  if (!inputs) throw new Error('Summary execution requires owned, frozen summary intent');
  return executeFrozenSummaries(db, inputs, digest, execution);
}

/** Internal continuation using the runner's already loaded, validated snapshot.
 * Never accept this snapshot from a request. Fresh SQL authorization/claims still
 * guard each effect and write; loading inputs is not permission to dispatch.
 */
export async function executeFrozenSummaries(db: D1Database, inputs: GenerationInputs,
  digest: Digest, execution: SummaryExecution): Promise<SummaryProgress> {
  const { id: generationId, userId } = inputs;
  const allowance = execution.maxRequests ?? 1;
  if (!Number.isSafeInteger(allowance) || allowance < 1 || allowance > 6) throw new Error('Expected 1–6 summary requests');
  if (!inputs.batches || !inputs.summariesRequested) throw new Error('Summary execution requires owned, frozen summary intent');
  const config = parseConfig((inputs.summaryConfig ?? inputs.config).text), extractor = execution.extractor ?? HTML_EXTRACTOR;
  const source = createDigest(inputs.batches);
  const ids = digest.ranking?.featured.map(p => p.id) ?? [];
  if (ids.length !== Math.min(6, source.papers.length) || new Set(ids).size !== ids.length ||
    ids.some(id => !source.papers.some(p => p.id === id))) throw new Error('Invalid featured summary selection');
  const papers = ids.map(id => source.papers.find(p => p.id === id)!);
  if (papers.length) await db.batch(papers.map((paper, ordinal) => db.prepare(`INSERT INTO summary_outcomes
    (generation_id, paper_id, version, ordinal) SELECT ?, ?, ?, ? WHERE EXISTS (${ACTIVE}) ON CONFLICT DO NOTHING`)
    .bind(generationId, paper.id, paper.version, ordinal, generationId, userId)));
  const rows = (await db.prepare(`SELECT paper_id, version, ordinal, state, outcome_json, created_at
    FROM summary_outcomes WHERE generation_id = ? ORDER BY ordinal`).bind(generationId).all<Row>()).results;
  if (rows.length !== papers.length || rows.some((r, i) => r.ordinal !== i || r.paper_id !== papers[i].id || r.version !== papers[i].version)) {
    throw new Error('Featured selection changed or generation stopped');
  }
  digest.summaries = {};
  let calls = 0, provider: SummaryProvider | undefined;
  for (const [ordinal, paper] of papers.entries()) {
    const row = rows[ordinal];
    const active = async () => {
      if (!await db.prepare(ACTIVE).bind(generationId, userId).first()) throw new Error('Summary generation is no longer active');
    };
    const complete = async (outcome: PaperSummary, expected: 'pending' | 'claimed', stopped = false) => {
      const changed = await db.prepare(`UPDATE summary_outcomes SET state = 'complete', outcome_json = ?, budget_stopped = ?
        WHERE generation_id = ? AND paper_id = ? AND state = ? AND EXISTS (${ACTIVE})`)
        .bind(encode(outcome), Number(stopped), generationId, paper.id, expected, generationId, userId).run();
      if (changed.meta.changes !== 1) throw new Error('Summary outcome was fenced');
      digest.summaries![paper.id] = outcome;
    };
    if (row.state === 'complete') { digest.summaries[paper.id] = JSON.parse(row.outcome_json!); continue; }
    await active();
    if (row.state === 'claimed') {
      // The stored fallback was written atomically with the input reservation.
      await complete(JSON.parse(row.outcome_json!), 'claimed');
      continue;
    }
    const base: PaperSummary = { paperId: paper.id, version: paper.version, createdAt: row.created_at, status: 'html_unavailable' };
    let text = await readExtractedText(db, userId, generationId, paper, extractor);
    if ((!text || (text.result.status === 'unavailable' && execution.retryUnavailableSource === true)) && execution.loadSource) {
      await active();
      let loaded: CachedPaperText | undefined;
      try { loaded = await execution.loadSource(structuredClone(paper)); } catch { /* A source precondition, not a paid attempt. */ }
      if (loaded) {
        await active();
        if (loaded.result.extractor !== extractor) throw new Error('Unexpected source extractor');
        const saved = await saveSourceText(db, userId, generationId, paper, loaded, { retryUnavailable: execution.retryUnavailableSource === true });
        // The writer returns the verified winning pin. Reuse it rather than
        // reloading content, and do not retain raw HTML during model execution.
        text = saved && { id: saved.id, result: saved.result };
      }
    }
    if (text?.result.status !== 'available' || !text.result.text?.trim()) {
      await complete({ ...base, detail: 'Usable full text is unavailable' }, 'pending'); continue;
    }
    const context = await frozenSummaryContext(paper, text, config);
    const messages = summaryMessages(paper, text.result.text);
    const { paperId: _paperId, version: _version, ...provenance } = context.identity;
    // Explicit admin regeneration bypasses content hits only for this new run.
    // It never deletes shared cache content or resets anyone's old outcomes.
    const cached = inputs.action === 'summaries' ? undefined : await readFrozenCachedSummary(db, userId, generationId, context);
    if (cached) {
      await complete({ ...base, status: 'available', summary: cached.summary, cacheKey: cached.cacheKey,
        provenance: { ...provenance, ...(cached.actualModel === undefined ? {} : { actualModel: cached.actualModel }) } }, 'pending');
      continue;
    }
    const estimate = estimatePromptTokens(messages, config.tokenizer).estimatedInputTokens, limits = config.summaries;
    const pending: PaperSummary = { ...base, status: 'summarization_error', cacheKey: context.cacheKey, provenance,
      estimatedInputTokens: estimate, detail: 'Request interrupted or not completed; no retry' };
    if (estimate > limits.paper_input_tokens || estimate + limits.max_completion_tokens > limits.context_tokens) {
      await complete({ ...pending, status: 'token_budget', detail: 'Paper exceeds input/context allowance; no truncation' }, 'pending'); continue;
    }
    // Waiting may yield a free cache hit, even when this user's budget is exhausted.
    if (await db.prepare(SHARED).bind(context.cacheKey).first()) return 'waiting';
    const skipped: PaperSummary = { ...pending, status: 'token_budget', detail: 'Run input budget exhausted; no further uncached requests' };
    const stop = await db.prepare(`UPDATE summary_outcomes SET state = 'complete', outcome_json = ?, budget_stopped = 1
      WHERE generation_id = ? AND paper_id = ? AND state = 'pending' AND EXISTS (${ACTIVE})
        AND (EXISTS (${STOPPED}) OR (${SPENT}) + ? > ?)`)
      .bind(encode(skipped), generationId, paper.id, generationId, userId, generationId, generationId, estimate, limits.run_input_tokens).run();
    if (stop.meta.changes) { digest.summaries[paper.id] = skipped; continue; }
    if (calls >= allowance) return 'paused';
    provider ??= execution.createProvider(structuredClone(config)); // Credential/config failure does not acquire a claim.
    const admitted = await db.prepare(`UPDATE summary_outcomes SET state = 'claimed', cache_key = ?, charged_input = ?, outcome_json = ?
      WHERE generation_id = ? AND paper_id = ? AND state = 'pending' AND EXISTS (${ACTIVE})
        AND NOT EXISTS (${STOPPED}) AND (${SPENT}) + ? <= ?
        AND NOT EXISTS (${SHARED}) AND (EXISTS (SELECT 1 FROM generation_inputs WHERE id = ? AND action = 'summaries')
          OR NOT EXISTS (SELECT 1 FROM summary_cache WHERE cache_key = ?))`)
      .bind(context.cacheKey, estimate, encode(pending), generationId, paper.id, generationId, userId,
        generationId, generationId, estimate, limits.run_input_tokens, context.cacheKey, generationId, context.cacheKey).run();
    if (!admitted.meta.changes) return 'waiting';
    await active();
    if (!await db.prepare("SELECT 1 FROM summary_outcomes WHERE generation_id = ? AND paper_id = ? AND state = 'claimed'")
      .bind(generationId, paper.id).first()) throw new Error('Summary claim is no longer active');
    calls++;
    let result: PaperSummary;
    let reported: SummaryUsage | undefined;
    try {
      messages.forEach(Object.freeze); Object.freeze(messages);
      const response = await provider.summarize(messages, limits.max_completion_tokens);
      reported = usage(response.usage);
      const actualModel = response.model;
      if (actualModel !== undefined && (typeof actualModel !== 'string' || !actualModel.trim() || bytes(actualModel) > 1024)) throw new Error('Invalid actual model');
      result = { ...pending, status: 'available', detail: undefined, summary: summaryText(response.summary),
        provenance: { ...provenance, ...(actualModel === undefined ? {} : { actualModel }) }, usage: reported };
      encode(result); // Oversized escaped output is an individual invalid result.
    } catch (error) {
      result = { ...pending, status: error instanceof SummaryError ? error.kind : 'summarization_error',
        detail: 'Summary request failed or returned an invalid result; no retry', usage: reported };
      // Provider messages are never persisted. Preserve only validated usage, if supplied.
      if (error instanceof SummaryError && error.usage !== undefined) { try { result.usage = usage(error.usage); } catch { /* Untrusted usage. */ } }
    }
    const json = encode(result);
    // Atomic cache/outcome persistence, retried only while the response is in memory.
    // A lost acknowledgement can be reconciled by exact terminal JSON, not another call.
    let saved = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const statements = [];
        if (result.status === 'available') statements.push(db.prepare(`INSERT INTO summary_cache
          (cache_key, paper_id, version, identity_json, summary, actual_model, created_at)
          SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (${ACTIVE})
            AND EXISTS (SELECT 1 FROM summary_outcomes WHERE generation_id = ? AND paper_id = ? AND state = 'claimed')
            AND EXISTS (SELECT 1 FROM generation_text_refs WHERE generation_id = ? AND text_id = ?)
          ON CONFLICT DO NOTHING`).bind(context.cacheKey, paper.id, paper.version, context.json, result.summary!, result.provenance?.actualModel ?? null,
            result.createdAt, generationId, userId, generationId, paper.id, generationId, context.sourceId));
        statements.push(db.prepare(`UPDATE summary_outcomes SET state = 'complete', outcome_json = ?
          WHERE generation_id = ? AND paper_id = ? AND state = 'claimed' AND EXISTS (${ACTIVE})`)
          .bind(json, generationId, paper.id, generationId, userId));
        await db.batch(statements);
        const stored = await db.prepare("SELECT outcome_json FROM summary_outcomes WHERE generation_id = ? AND paper_id = ? AND state = 'complete'")
          .bind(generationId, paper.id).first<{ outcome_json: string }>();
        if (stored?.outcome_json !== json) throw new Error('Summary response persistence was fenced');
        saved = true; break;
      } catch { /* No provider retry, regardless of SQL/acknowledgement failure. */ }
    }
    if (!saved) throw new Error('Summary response could not be persisted; admitted request must not be resent');
    digest.summaries[paper.id] = result;
  }
  return 'complete';
}
