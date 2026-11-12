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

import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { readResponseText } from './http-body.ts';
import { DocumentError } from './document-error.ts';

export const MAX_RSS_BYTES = 8 * 1024 * 1024;

export interface Paper {
  id: string;
  version: number;
  title: string;
  abstract: string;
  categories: string[];
  authors?: string[];
}

export interface Batch {
  category: string;
  date: string;
  sourceUrl: string;
  papers: Paper[];
}

/** Normalize categories so equivalent requests share the same saved digest. */
export function categoriesFrom(value: string): string[] {
  const categories = [...new Set(value.split(',').map(c => c.trim()))].sort();
  if (!categories.length || categories.some(c => !/^[a-z][a-z0-9-]*(?:\.[A-Za-z][A-Za-z0-9-]*)?$/.test(c))) {
    throw new DocumentError('category_list', 'Use comma-separated arXiv categories, e.g. quant-ph,cs.ET');
  }
  return categories;
}

export function feedUrl(category: string): string {
  return `https://rss.arxiv.org/rss/${encodeURIComponent(category)}`;
}

/** RSS identifies announcement batches; submission-date API queries do not. */
export function parseFeed(xml: string, category: string): Batch {
  const validation = XMLValidator.validate(xml);
  if (validation !== true) throw new Error(`Invalid XML for ${category}`);
  const parsed = new XMLParser({
    ignoreAttributes: false,
    parseTagValue: false,
    isArray: name => name === 'item' || name === 'category',
  }).parse(xml);
  const channel = parsed.rss?.channel;
  if (!channel || !channel.title?.startsWith(`${category} updates on arXiv.org`)) {
    throw new Error(`Unexpected arXiv feed for ${category}`);
  }
  // Preserve the announcement's own calendar date, not the machine's timezone/date.
  const date = new Date(channel.pubDate);
  if (Number.isNaN(date.getTime())) throw new Error(`Missing announcement date for ${category}`);
  const batchDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
  const papers: Paper[] = [];
  for (const item of channel.item ?? []) {
    const kind = item['arxiv:announce_type'];
    if (kind === 'replace' || kind === 'replace-cross') continue;
    if (kind !== 'new' && kind !== 'cross') throw new Error(`Unknown announcement type: ${kind}`);
    const guid = typeof item.guid === 'string' ? item.guid : item.guid?.['#text'];
    const match = /^oai:arXiv\.org:((?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7}))v(\d+)$/.exec(guid ?? '');
    const description = item.description;
    const abstract = typeof description === 'string' ? description.match(/(?:^|\n)Abstract:\s*([\s\S]*)$/)?.[1]?.trim() : undefined;
    if (!match || !item.title || !abstract || !item.category?.length) {
      throw new Error(`Incomplete paper in ${category} feed`);
    }
    papers.push({
      id: match[1], version: Number(match[2]), title: item.title.trim(),
      abstract, categories: item.category,
      authors: typeof item['dc:creator'] === 'string'
        ? item['dc:creator'].split(/,\s*/).map((name: string) => name.trim()).filter(Boolean) : [],
    });
  }
  return { category, date: batchDate, sourceUrl: feedUrl(category), papers };
}

export async function fetchBatch(category: string, fetcher: typeof fetch = fetch): Promise<Batch> {
  const response = await fetcher(feedUrl(category), {
    headers: { 'User-Agent': 'ruminator/0.1 (local literature browser)' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`arXiv ${category}: HTTP ${response.status}`);
  }
  return parseFeed(await readResponseText(response, MAX_RSS_BYTES), category);
}

export function pdfUrl(paper: Paper): string {
  return `https://arxiv.org/pdf/${paper.id}v${paper.version}`;
}
