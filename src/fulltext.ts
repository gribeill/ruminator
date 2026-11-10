import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { parseHTML } from 'linkedom';
import type { Paper } from './arxiv.ts';
import type { Digest } from './digest.ts';
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

/** Extract only the article, not arXiv navigation or an abstract-page/error response.
 * Keep headings, captions, tables, and equation TeX; never execute page scripts.
 */
export function extractArxivHtml(html: string): string {
  const { document } = parseHTML(html);
  const article = document.querySelector('article.ltx_document');
  if (!article) throw new Error('No arXiv HTML article found');
  for (const node of article.querySelectorAll('script, style, nav, form, button')) node.remove();
  // Some complete papers consist of unsectioned paragraphs. Check for substantive
  // content without assuming heading/section markup, and don't count an abstract
  // plus author metadata or references as proof that the full body is present.
  // Use a clone so this check does not discard metadata/references from the output.
  const body = article.cloneNode(true) as typeof article;
  for (const node of body.querySelectorAll('.ltx_title_document, .ltx_authors, .ltx_dates, .ltx_abstract, .ltx_bibliography, .ltx_pagination, header, [role="doc-abstract"], [role="doc-bibliography"]')) node.remove();
  if (body.textContent.replace(/\s+/g, ' ').trim().length < 200) {
    throw new Error('No substantive full-text body found');
  }
  for (const math of article.querySelectorAll('math')) {
    const tex = math.getAttribute('alttext') || math.querySelector('annotation[encoding="application/x-tex"]')?.textContent;
    math.replaceWith(document.createTextNode(tex ? ` $${tex}$ ` : ` ${math.textContent} `));
  }
  for (const image of article.querySelectorAll('img')) {
    image.replaceWith(document.createTextNode(image.getAttribute('alt') ? ` [Image: ${image.getAttribute('alt')}] ` : ''));
  }
  // TextContent alone merges adjacent paragraphs and table cells without separators.
  for (const node of article.querySelectorAll('h1,h2,h3,h4,h5,h6,p,div,section,figure,figcaption,table,tr,li,blockquote,br')) {
    node.before(document.createTextNode('\n'));
    node.after(document.createTextNode('\n'));
  }
  for (const cell of article.querySelectorAll('td,th')) cell.after(document.createTextNode('\t'));
  const text = article.textContent.replace(/[\t \f\v]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!text) throw new Error('HTML article is empty');
  return text;
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
    if (Number(response.headers.get('content-length')) > MAX_HTML_BYTES) throw new Error('HTML exceeds download size limit');
    if (!response.body) throw new Error('HTML response has no body');
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      if (bytes > MAX_HTML_BYTES) throw new Error('HTML exceeds download size limit');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
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
  if (!digest.ranking) throw new Error('Save a ranking with npm run score before retrieving featured text');
  if (offline && retryUnavailable) throw new Error('Cannot retry HTML downloads offline');
  const selected = digest.ranking.featured;
  if (selected.length > 6 || new Set(selected.map(p => p.id)).size !== selected.length) throw new Error('Invalid featured selection');
  const papers = selected.map(({ id }) => {
    const paper = digest.papers.find(p => p.id === id);
    if (!paper) throw new Error(`Missing featured paper: ${id}`);
    return paper;
  });
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
