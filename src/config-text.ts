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

import { parse } from 'smol-toml';
import { BGE_CONFIG } from './bge-config.ts';
import { validateWeights, type ScoreWeights } from './ranking.ts';
import { validateFeedbackConfig, type FeedbackConfig } from './feedback.ts';

export interface TokenizerConfig {
  implementation: 'gpt-tokenizer';
  encoding: 'o200k_base';
  safety_multiplier: number;
  message_overhead: number;
  request_overhead: number;
}

export interface SummaryLimits {
  run_input_tokens: number;
  paper_input_tokens: number;
  max_completion_tokens: number;
  context_tokens: number;
}

export function validateSummaryLimits(limits: SummaryLimits): void {
  if (Object.values(limits).some(v => !Number.isSafeInteger(v) || v <= 0) ||
      limits.context_tokens <= limits.max_completion_tokens) {
    throw new Error('Summary limits must be positive safe integers with context larger than completion allowance');
  }
}

export interface Config {
  llm: { provider: 'cloudflare'; model: string };
  embedding: typeof BGE_CONFIG;
  scoring: { weights: ScoreWeights };
  tokenizer: TokenizerConfig;
  summaries: SummaryLimits;
  feedback: FeedbackConfig;
}

export function validateTokenizer(config: TokenizerConfig): void {
  if (config.implementation !== 'gpt-tokenizer' || config.encoding !== 'o200k_base') {
    throw new Error('Only gpt-tokenizer with o200k_base is currently supported');
  }
  if (!Number.isFinite(config.safety_multiplier) || config.safety_multiplier < 1 ||
      !Number.isSafeInteger(config.message_overhead) || config.message_overhead < 0 ||
      !Number.isSafeInteger(config.request_overhead) || config.request_overhead < 0) {
    throw new Error('Tokenizer multiplier must be >= 1 and overheads must be nonnegative safe integers');
  }
}

/** Require explicit settings and reject typos; this file is also the editable documentation. */
export function parseConfig(text: string): Config {
  const raw = parse(text);
  function table(value: unknown, keys: string[], path: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Missing configuration table: ${path}`);
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) if (!keys.includes(key)) throw new Error(`Unknown configuration key: ${path}.${key}`);
    for (const key of keys) if (!(key in record)) throw new Error(`Missing configuration key: ${path}.${key}`);
    return record;
  }
  table(raw, ['llm', 'embedding', 'scoring', 'tokenizer', 'summaries', 'feedback'], 'config');
  const llm = table(raw.llm, ['provider', 'model'], 'llm');
  if (llm.provider !== 'cloudflare') throw new Error('Changing LLM provider away from cloudflare is not yet supported');
  if (typeof llm.model !== 'string' || !llm.model.trim()) throw new Error('llm.model must be a nonempty model ID');
  const embedding = table(raw.embedding, Object.keys(BGE_CONFIG), 'embedding');
  for (const key of Object.keys(BGE_CONFIG) as (keyof typeof BGE_CONFIG)[]) {
    if (embedding[key] !== BGE_CONFIG[key]) throw new Error(`Changing embedding configuration is not yet supported: ${key}`);
  }
  const scoring = table(raw.scoring, ['weights'], 'scoring');
  const weights = table(scoring.weights, ['semantic', 'keywords', 'feedback'], 'scoring.weights') as unknown as ScoreWeights;
  validateWeights(weights);
  const tokenizer = table(raw.tokenizer,
    ['implementation', 'encoding', 'safety_multiplier', 'message_overhead', 'request_overhead'], 'tokenizer') as unknown as TokenizerConfig;
  validateTokenizer(tokenizer);
  const summaries = table(raw.summaries,
    ['run_input_tokens', 'paper_input_tokens', 'max_completion_tokens', 'context_tokens'], 'summaries') as unknown as SummaryLimits;
  validateSummaryLimits(summaries);
  const feedback = table(raw.feedback, ['min_similarity', 'near_duplicate_similarity'], 'feedback') as unknown as FeedbackConfig;
  validateFeedbackConfig(feedback);
  return { llm: { provider: 'cloudflare', model: llm.model }, embedding: { ...BGE_CONFIG }, scoring: { weights: { ...weights } }, tokenizer: { ...tokenizer }, summaries: { ...summaries }, feedback: { ...feedback } };
}

