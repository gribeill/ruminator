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
import { extractArxivHtml } from './html-extraction.ts';
export { extractArxivHtml } from './html-extraction.ts';
import type { Paper } from './arxiv.ts';
import { featuredPapers, type Digest } from './digest.ts';
import { readResponseText } from './http-body.ts';
import { readPaperText, savePaperText } from './store.ts';

export const HTML_EXTRACTOR = 'arxiv-html-v2';
const MAX_HTML_BYTES = 16 * 1024 * 1024;

export interface PaperText {
  paperId: string;
  version: number;
  status: 'available' | 'unavailable';
  sourceUrl: string;
  checkedAt: string;
  extractor: string;
  text?: string;
  contentHash?: string;
  reason?: string;
}

export interface CachedPaperText {
  html: string | null;
  result: PaperText;
}

/** Bound downloads before parsing; reject rather than truncate oversized articles. */
async function downloadHtml(url: string, fetcher: typeof fetch): Promise<string> {
  const response = await fetcher(url, {
    headers: { 'User-Agent': 'ruminator/0.1 (local literature browser)', Accept: 'text/html' },
    signal: AbortSignal.timeout(30_000),
  });
  try {
    if (!response.ok) throw new Error(`HTML request returned HTTP ${response.status}`);
    if (!/^(text\/html|application\/xhtml\+xml)(;|$)/i.test(response.headers.get('content-type') ?? '')) {
      throw new Error('Response is not HTML');
    }
    if (!response.body) throw new Error('HTML response has no body');
    return await readResponseText(response, MAX_HTML_BYTES);
  } finally {
    if (!response.bodyUsed) await response.body?.cancel();
  }
}

function extraction(paper: Paper, html: string, sourceUrl: string, checkedAt: string): PaperText {
  const base = { paperId: paper.id, version: paper.version, sourceUrl, checkedAt, extractor: HTML_EXTRACTOR };
  try {
    const text = extractArxivHtml(html);
    return { ...base, status: 'available', text, contentHash: createHash('sha256').update(text).digest('hex') };
  } catch (error) {
    return { ...base, status: 'unavailable', reason: (error as Error).message };
  }
}

/** Cache successes AND failures by version; explicit retries avoid repeated development requests.
 * Raw HTML allows later extractor revisions to run without downloading the paper again.
 */
export async function retrieveFeaturedText(db: DatabaseSync, digest: Digest, {
  offline = false, retryUnavailable = false, fetcher = fetch, minIntervalMs = 3000,
  log = console.log,
}: {
  offline?: boolean;
  retryUnavailable?: boolean;
  fetcher?: typeof fetch;
  minIntervalMs?: number;
  log?: (message: string) => void;
} = {}): Promise<PaperText[]> {
  const papers = featuredPapers(digest);
  if (offline && retryUnavailable) throw new Error('Cannot retry HTML downloads offline');
  const results: PaperText[] = [];
  let lastRequest = 0;
  for (const paper of papers) {
    const cached = readPaperText(db, paper);
    let result = cached?.result;
    // Re-extract locally on extractor changes, including previously unusable HTML.
    if (cached && cached.html !== null && cached.result.extractor !== HTML_EXTRACTOR) {
      result = extraction(paper, cached.html, cached.result.sourceUrl, cached.result.checkedAt);
      savePaperText(db, { html: cached.html, result });
    }
    if (!result || (retryUnavailable && result.status === 'unavailable')) {
      const sourceUrl = `https://arxiv.org/html/${paper.id}v${paper.version}`;
      const base = { paperId: paper.id, version: paper.version, sourceUrl, checkedAt: new Date().toISOString(), extractor: HTML_EXTRACTOR };
      if (offline) {
        result = { ...base, status: 'unavailable', reason: 'HTML is not cached (offline)' };
      } else {
        const wait = minIntervalMs - (Date.now() - lastRequest);
        if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
        lastRequest = Date.now();
        // A failed manual download must not destroy HTML available for re-extraction.
        let html: string | null = cached?.html ?? null;
        try {
          html = await downloadHtml(sourceUrl, fetcher);
          result = extraction(paper, html, sourceUrl, new Date().toISOString());
        } catch (error) {
          result = { ...base, status: 'unavailable', reason: (error as Error).message };
        }
        savePaperText(db, { html, result });
      }
    }
    results.push(result);
    log(`${paper.id}v${paper.version}: ${result.status === 'available' ? `HTML text available (${result.text!.length} characters)` : `unsummarized — ${result.reason}`}`);
  }
  return results;
}
