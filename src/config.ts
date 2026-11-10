import { readFileSync } from 'node:fs';
import { parse } from 'smol-toml';
import { BGE_CONFIG } from './bge.ts';
import { validateWeights, type ScoreWeights } from './ranking.ts';

export interface TokenizerConfig {
  implementation: 'gpt-tokenizer';
  encoding: 'o200k_base';
  safety_multiplier: number;
  message_overhead: number;
  request_overhead: number;
}

export interface Config {
  llm: { provider: 'cloudflare'; model: string };
  embedding: typeof BGE_CONFIG;
  scoring: { weights: ScoreWeights };
  tokenizer: TokenizerConfig;
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
  table(raw, ['llm', 'embedding', 'scoring', 'tokenizer'], 'config');
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
  return { llm: { provider: 'cloudflare', model: llm.model }, embedding: { ...BGE_CONFIG }, scoring: { weights: { ...weights } }, tokenizer: { ...tokenizer } };
}

export function loadConfig(path = 'config.toml'): Config {
  return parseConfig(readFileSync(path, 'utf8'));
}
