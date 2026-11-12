/**
 * Copyright 2026 Guilhem Ribeill
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { validateSummaryLimits } from './config.ts';
import { featuredPapers, type Digest } from './digest.ts';
import { estimatePromptTokens } from './tokenizer.ts';
import { claimSummary, completeSummary, readPaperText, readSummaryCache, readSummaries, startSummaryRun } from './store.ts';

import { SUMMARY_PROMPT_VERSION, validateSummary, summaryMessages, summaryUnavailableLabel, SummaryError, type SummaryConfig, type SummaryProvider, type SummaryUsage, type PaperSummary } from './summary-content.ts';
export * from './summary-content.ts';


/** Local preflight for all featured papers, irrespective of saved summary outcomes.
 * Missing text makes totals partial; output allowances are caps, not predictions.
 * Do not initialize a summary run or reserve/spend any budget in this mode.
 */
export function reportSummaryTokens(
  papersDb: DatabaseSync, digest: Digest, config: SummaryConfig,
  log: (message: string) => void = console.log,
): void {
  const papers = featuredPapers(digest);
  validateSummaryLimits(config.summaries);
  let textTokens = 0, inputTokens = 0, estimatedPapers = 0;
  log(`Token estimates (${config.tokenizer.encoding}, approximate; includes papers with cached summaries):`);
  for (const paper of papers) {
    const fulltext = readPaperText(papersDb, paper)?.result;
    if (fulltext?.status !== 'available' || !fulltext.text?.trim()) {
      log(`${paper.id}v${paper.version}: unavailable — HTML not cached or unusable`);
      continue;
    }
    const estimate = estimatePromptTokens(summaryMessages(paper, fulltext.text), config.tokenizer);
    textTokens += estimate.textTokens;
    inputTokens += estimate.estimatedInputTokens;
    estimatedPapers++;
    log(`${paper.id}v${paper.version}: raw text ${estimate.textTokens}; estimated input ${estimate.estimatedInputTokens}; completion allowance ${config.summaries.max_completion_tokens}`);
  }
  const completionTokens = estimatedPapers * config.summaries.max_completion_tokens;
  log(`Total (${estimatedPapers}/${papers.length} papers${estimatedPapers < papers.length ? '; partial — missing HTML' : ''}): raw text ${textTokens}; estimated input ${inputTokens}; completion allowance ${completionTokens}; combined reservation ${inputTokens + completionTokens}`);
  log('Estimate only; no API calls or summary-state changes. Completion allowances are caps, not predicted usage.');
}

/** Separate sequential requests for saved featured selections only; never acquire HTML here.
 * Persist a claim and budget charge BEFORE calling a provider. An interrupted call is
 * not retried: its outcome may be unknown, and repeating it could incur another charge.
 */
export async function summarizeFeatured(
  appDb: DatabaseSync, papersDb: DatabaseSync, digest: Digest, config: SummaryConfig,
  createProvider: (config: SummaryConfig) => SummaryProvider,
  log: (message: string) => void = console.log,
): Promise<Digest> {
  const papers = featuredPapers(digest);
  validateSummaryLimits(config.summaries);
  const run = startSummaryRun(appDb, digest, config);
  let provider: SummaryProvider | undefined;
  for (const paper of papers) {
    const previous = readSummaries(appDb, digest)[paper.id];
    // Missing HTML never triggered a model request. A manual rerun may now have
    // usable text; all actual attempts and budget outcomes remain non-retryable.
    if (previous && previous.status !== 'html_unavailable') continue;
    const base: PaperSummary = { paperId: paper.id, version: paper.version, createdAt: new Date().toISOString(), status: 'html_unavailable' };
    const fulltext = readPaperText(papersDb, paper)?.result;
    if (fulltext?.status !== 'available' || !fulltext.text?.trim()) {
      claimSummary(appDb, digest, { ...base, detail: 'Usable full text is not cached; run npm run text before summarizing' }, 0);
      continue;
    }
    const messages = summaryMessages(paper, fulltext.text);
    const textHash = createHash('sha256').update(fulltext.text).digest('hex');
    // Hash exactly what is sent, including roles and user-message framing: prompt
    // edits invalidate reusable results even if the human-readable version is unchanged.
    const promptHash = createHash('sha256').update(JSON.stringify(messages)).digest('hex');
    const provenance = {
      provider: run.config.llm.provider, model: run.config.llm.model, textHash,
      extractor: fulltext.extractor, promptVersion: SUMMARY_PROMPT_VERSION, promptHash,
      maxCompletionTokens: run.config.summaries.max_completion_tokens,
    };
    const cacheKey = createHash('sha256').update(JSON.stringify({ paperId: paper.id, version: paper.version, title: paper.title, ...provenance })).digest('hex');
    const cached = readSummaryCache(appDb, cacheKey);
    if (cached) {
      claimSummary(appDb, digest, { ...cached, createdAt: base.createdAt }, 0);
      continue;
    }
    const estimate = estimatePromptTokens(messages, run.config.tokenizer);
    const pending: PaperSummary = {
      ...base, status: 'summarization_error', cacheKey, provenance,
      estimatedInputTokens: estimate.estimatedInputTokens,
      detail: 'Request interrupted or not completed; no retry',
    };
    const limits = run.config.summaries;
    if (estimate.estimatedInputTokens > limits.paper_input_tokens ||
        estimate.estimatedInputTokens + limits.max_completion_tokens > limits.context_tokens) {
      claimSummary(appDb, digest, { ...pending, status: 'token_budget', detail: 'Paper exceeds input/context allowance; no truncation' }, 0);
      continue;
    }
    // Missing local credentials are a precondition, not an attempted paid request.
    provider ??= createProvider(run.config);
    // claimSummary atomically enforces the saved run budget, including failed calls.
    if (!claimSummary(appDb, digest, pending, estimate.estimatedInputTokens)) continue;
    let result: PaperSummary;
    let usage: SummaryUsage | undefined;
    try {
      const response = await provider.summarize(messages, limits.max_completion_tokens);
      usage = response.usage;
      result = {
        ...pending, status: 'available', detail: undefined, summary: validateSummary(response.summary),
        provenance: { ...provenance, actualModel: response.model }, usage: response.usage,
      };
    } catch (error) {
      result = {
        ...pending, status: error instanceof SummaryError ? error.kind : 'summarization_error',
        // Do not store raw provider errors, request bodies, or credentials.
        detail: error instanceof SummaryError ? error.message : 'Summary generation failed',
        usage: error instanceof SummaryError ? error.usage ?? usage : usage,
      };
    }
    await completeSummary(appDb, digest, result);
  }
  const summaries = readSummaries(appDb, digest);
  for (const paper of papers) {
    const result = summaries[paper.id];
    log(`${paper.id}v${paper.version}: ${result.status === 'available' ? 'summary available' : `Summary unavailable: ${summaryUnavailableLabel(result.status)}`}`);
  }
  return { ...digest, summaries };
}
