// Copyright 2026 Guilhem Ribeill
// SPDX-License-Identifier: Apache-2.0

import type { Paper } from '../arxiv.ts';
import { extractArxivHtml } from '../html-extraction.ts';
import { readResponseText } from '../http-body.ts';
import { HTML_EXTRACTOR, MAX_HTML_BYTES, type CachedPaperText } from '../fulltext-types.ts';

export const HTML_REQUEST_TIMEOUT_MS = 30_000;

/** Versioned arXiv only: never use an arbitrary URL from metadata. No assets,
 * redirects, PDF fallback or HTTP retries. Verified cached raw HTML can avoid IO.
 */
export async function loadHostedSource(paper: Pick<Paper, 'id' | 'version'>, fetcher: typeof fetch,
  cachedHtml: string | null = null): Promise<CachedPaperText> {
  if (!/^(?:\d{4}\.\d{4,5}|[a-z][a-z.\-]+\/\d{7})$/i.test(paper.id) ||
      !Number.isSafeInteger(paper.version) || paper.version < 1) throw new Error('Invalid arXiv identity');
  const sourceUrl = `https://arxiv.org/html/${paper.id}v${paper.version}`;
  const base = { paperId: paper.id, version: paper.version, sourceUrl, checkedAt: new Date().toISOString(), extractor: HTML_EXTRACTOR };
  let html = cachedHtml;
  if (html !== null) {
    try { return { html, result: { ...base, status: 'available', text: extractArxivHtml(html) } }; }
    catch { /* A fresh source attempt may repair an unavailable precondition. */ }
  }
  try {
    const response = await fetcher(sourceUrl, { redirect: 'error', signal: AbortSignal.timeout(HTML_REQUEST_TIMEOUT_MS),
      headers: { 'User-Agent': 'ruminator/0.1 (literature browser)', Accept: 'text/html' } });
    try {
      if (!response.ok || !response.body || !/^(text\/html|application\/xhtml\+xml)(;|$)/i.test(response.headers.get('content-type') ?? '')) {
        throw new Error('HTML unavailable');
      }
      html = await readResponseText(response, MAX_HTML_BYTES);
    } finally { if (!response.bodyUsed) await response.body?.cancel(); }
    return { html, result: { ...base, status: 'available', text: extractArxivHtml(html) } };
  } catch {
    return { html, result: { ...base, status: 'unavailable', reason: 'Usable versioned arXiv HTML is unavailable' } };
  }
}
