// Copyright 2026 Guilhem Ribeill
// SPDX-License-Identifier: Apache-2.0

import { Tokenizer } from '@huggingface/tokenizers';
import tokenizerJSON from './assets/bge/tokenizer.json' with { type: 'json' };
import tokenizerConfig from './assets/bge/tokenizer_config.json' with { type: 'json' };
import { splitChunks, normalize, type EmbeddingInput } from '../embeddings.ts';
import { readResponseText } from '../http-body.ts';

export const HOSTED_BGE_MODEL = '@cf/baai/bge-small-en-v1.5';
export const TOKENIZER_REVISION = '5c38ec7c405ec4b44b94cc5a9bb96e735b38267a';
export const TOKENIZER_HASHES = {
  'tokenizer.json': 'd241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66',
  'tokenizer_config.json': '9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3',
};
const QUERY = 'Represent this sentence for searching relevant passages: ';
export const EMBEDDING_BATCH_SIZE = 8;
export const EMBEDDING_REQUEST_TIMEOUT_MS = 60_000;
export const HOSTED_BGE_FINGERPRINT = JSON.stringify({ provider: 'workers-ai', model: HOSTED_BGE_MODEL,
  pooling: 'cls', dimensions: 384, tokenizer: '@huggingface/tokenizers@0.2.0', tokenizerRevision: TOKENIZER_REVISION,
  tokenizerHashes: TOKENIZER_HASHES, query: QUERY, preprocessing: 'title-sentence-chunks-512-v1',
  aggregation: 'normalized-chunk-mean', requestBatchSize: EMBEDDING_BATCH_SIZE, maxInputTokens: 512, epoch: 1 });
let tokenizer: Tokenizer | undefined;
function loaded(): Tokenizer { return tokenizer ??= new Tokenizer(tokenizerJSON, tokenizerConfig); }
export function embeddingTokenCount(text: string): number {
  return loaded().encode(text, { add_special_tokens: true }).ids.length;
}
/** Title repeated on every chunk; the retrieval instruction belongs to profiles
 * only. Count the final request including CLS/SEP; never rely on server truncation.
 */
export function embeddingChunks(input: EmbeddingInput): string[] {
  const chunks = splitChunks(`${input.kind === 'profile' ? QUERY : ''}${input.title}\n\n`, input.text, {
    encode: text => loaded().encode(text, { add_special_tokens: false }).ids,
    decode: ids => loaded().decode(ids, { skip_special_tokens: false }),
  });
  if (!chunks.length || chunks.some(text => embeddingTokenCount(text) > 512)) throw new Error('Invalid hosted embedding token count');
  return chunks;
}

/** Tokens alone do not bound bytes (a huge unknown word can be one token). */
export function validateEmbeddingBatch(texts: readonly string[]): void {
  if (!texts.length || texts.length > EMBEDDING_BATCH_SIZE ||
      new TextEncoder().encode(JSON.stringify({ text: texts, pooling: 'cls' })).length > 1024 * 1024 ||
      texts.some(t => embeddingTokenCount(t) > 512)) throw new Error('Embedding request exceeds local batch/token/byte limits');
}

export type EmbeddingTransport = (texts: readonly string[]) => Promise<unknown>;
/** Validate the actual API shape, including any echoed pooling, before caching.
 * Normalize each chunk before averaging (the runner aggregates complete inputs).
 */
export function embeddingResponse(value: unknown, count: number): number[][] {
  const result = value as { shape?: unknown; data?: unknown; pooling?: unknown } | null;
  if (!result || (result.pooling !== undefined && result.pooling !== 'cls') ||
      !Array.isArray(result.shape) || result.shape.length !== 2 || result.shape[0] !== count || result.shape[1] !== 384 ||
      !Array.isArray(result.data) || result.data.length !== count) throw new Error('Invalid Workers AI embedding response');
  return Array.from(result.data, row => {
    if (!Array.isArray(row) || row.length !== 384 || !Array.from(row).every(v => typeof v === 'number' && Number.isFinite(v)) ||
        !Number.isFinite(Math.hypot(...row)) || !Math.hypot(...row)) throw new Error('Invalid Workers AI embedding vector');
    return normalize(row, 384);
  });
}

/** Construct only at an explicitly authorized execution boundary. No env lookup,
 * SDK/Gateway retries, redirects, or fallbacks. Construction makes no request;
 * the runner durably admits every invocation before calling this transport.
 */
export function workersAiEmbeddings(accountId: string, token: string, fetcher: typeof fetch = fetch): EmbeddingTransport {
  if (!/^[a-f0-9]{32}$/i.test(accountId) || !token.trim() || /[\r\n]/.test(token)) throw new Error('Missing or invalid Workers AI credentials');
  return async texts => {
    validateEmbeddingBatch(texts);
    try {
      const response = await fetcher(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${HOSTED_BGE_MODEL}`, {
        method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(EMBEDDING_REQUEST_TIMEOUT_MS),
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: texts, pooling: 'cls' }),
      });
      if (!response.ok) { await response.body?.cancel(); throw new Error('HTTP error'); }
      const body = JSON.parse(await readResponseText(response, 1024 * 1024)) as { success?: boolean; result?: unknown };
      if (body.success !== true || !body.result) throw new Error('Provider error');
      return body.result;
    } catch { throw new Error('Workers AI embedding request failed; do not retry this attempt'); }
  };
}
