import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Paper } from './arxiv.ts';
import type { Config } from './config.ts';
import { validateSummaryLimits } from './config.ts';
import type { Digest } from './digest.ts';
import { estimatePromptTokens, type TextMessage } from './tokenizer.ts';
import { claimSummary, completeSummary, readPaperText, readSummaryCache, readSummaries, startSummaryRun } from './store.ts';

export const SUMMARY_PROMPT_VERSION = 'fulltext-three-sentences-v1';
export type SummaryFailure = 'token_budget' | 'api_unavailable' | 'html_unavailable' | 'summarization_error';
export type SummaryConfig = Pick<Config, 'llm' | 'tokenizer' | 'summaries'>;

export interface SummaryUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
}

export interface SummaryResponse {
  summary: string;
  model?: string;
  usage?: SummaryUsage;
}

/** Providers return plain scientific prose; transport details stay outside generation. */
export interface SummaryProvider {
  summarize(messages: readonly TextMessage[], maxCompletionTokens: number): Promise<SummaryResponse>;
}

export class SummaryError extends Error {
  readonly kind: 'api_unavailable' | 'summarization_error' | 'token_budget';
  readonly usage?: SummaryUsage;
  constructor(kind: 'api_unavailable' | 'summarization_error' | 'token_budget', message: string, usage?: SummaryUsage) {
    super(message);
    this.kind = kind;
    this.usage = usage;
  }
}

export interface PaperSummary {
  paperId: string;
  version: number;
  status: 'available' | SummaryFailure;
  createdAt: string;
  summary?: string;
  detail?: string;
  cacheKey?: string;
  estimatedInputTokens?: number;
  provenance?: {
    provider: string;
    model: string;
    actualModel?: string;
    textHash: string;
    extractor: string;
    promptVersion: string;
    maxCompletionTokens: number;
  };
  usage?: SummaryUsage;
}

export function summaryMessages(paper: Paper, text: string): TextMessage[] {
  return [
    { role: 'system', content: 'You are an editor preparing a daily research digest for working scientists and engineers. You will receive the title, abstract, and full text of a scientific preprint. Your task is to write a concise, technically specific description that helps a researcher decide whether to read the paper. The reader can already see the title and abstract. First, identify internally what the authors actually did (experiment, simulation, theory, design, or review), the central technical contribution or finding, and the single most distinctive result or detail that differentiates this paper from similar work. Then write exactly two sentences, approximately 35–55 words total. The first sentence should identify the approach and contribution. The second should highlight the most informative result, distinctive technical detail, or consequential qualification. Do not paraphrase the abstract or repeat the title. Prefer concrete methods, numbers, and results over broad claims. Do not include generic statements about significance, novelty, or future applications. Do not systematically append a limitation or caveat unless it is essential to understanding the result. Distinguish demonstrations from simulations and proposals. Avoid formulaic openings such as "This paper presents," "The authors investigate," or "The study explores." Write for a technically literate reader; do not explain basic terminology. Use only claims supported by the supplied paper. Return only the two-sentence description, without headings, bullet points, or JSON.' },
    { role: 'user', content: `arXiv:${paper.id}v${paper.version}\nTitle: ${paper.title}\n\nFull paper text:\n${text}` },
  ];
}

/** Formatting checks cannot verify factuality or reliably count scientific sentences. */
export function validateSummary(text: unknown): string {
  if (typeof text !== 'string' || !text.trim() || text.trim().length > 4000 || /^\s*```/.test(text)) {
    throw new SummaryError('summarization_error', 'Missing, oversized, or malformed summary text');
  }
  return text.trim();
}

export function summaryUnavailableLabel(status: SummaryFailure): string {
  return {
    token_budget: 'exhausted token budget',
    api_unavailable: 'API unavailable',
    html_unavailable: 'HTML unavailable',
    summarization_error: 'summarization error',
  }[status];
}

function featuredPapers(digest: Digest): Paper[] {
  if (!digest.ranking) throw new Error('Save a ranking with npm run score before summarizing');
  const featured = digest.ranking.featured;
  if (featured.length > 6 || new Set(featured.map(p => p.id)).size !== featured.length) throw new Error('Invalid featured selection');
  return featured.map(({ id }) => {
    const paper = digest.papers.find(p => p.id === id);
    if (!paper) throw new Error(`Missing featured paper: ${id}`);
    return paper;
  });
}

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
    const textHash = createHash('sha256').update(fulltext.text).digest('hex');
    const provenance = {
      provider: run.config.llm.provider, model: run.config.llm.model, textHash,
      extractor: fulltext.extractor, promptVersion: SUMMARY_PROMPT_VERSION,
      maxCompletionTokens: run.config.summaries.max_completion_tokens,
    };
    const cacheKey = createHash('sha256').update(JSON.stringify({ paperId: paper.id, version: paper.version, title: paper.title, ...provenance })).digest('hex');
    const cached = readSummaryCache(appDb, cacheKey);
    if (cached) {
      claimSummary(appDb, digest, { ...cached, createdAt: base.createdAt }, 0);
      continue;
    }
    const messages = summaryMessages(paper, fulltext.text);
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
    // claimSummary atomically enforces the saved run budget, including failed calls.
    if (!claimSummary(appDb, digest, pending, estimate.estimatedInputTokens)) continue;
    let result: PaperSummary;
    let usage: SummaryUsage | undefined;
    try {
      provider ??= createProvider(run.config);
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
    completeSummary(appDb, digest, result);
  }
  const summaries = readSummaries(appDb, digest);
  for (const paper of papers) {
    const result = summaries[paper.id];
    log(`${paper.id}v${paper.version}: ${result.status === 'available' ? 'summary available' : `Summary unavailable: ${summaryUnavailableLabel(result.status)}`}`);
  }
  return { ...digest, summaries };
}
