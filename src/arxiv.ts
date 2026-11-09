import { XMLParser, XMLValidator } from 'fast-xml-parser';

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
    throw new Error('Use comma-separated arXiv categories, e.g. quant-ph,cs.ET');
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

export async function fetchBatch(category: string): Promise<Batch> {
  const response = await fetch(feedUrl(category), {
    headers: { 'User-Agent': 'arxiv-digest/0.1 (local literature browser)' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`arXiv ${category}: HTTP ${response.status}`);
  return parseFeed(await response.text(), category);
}

export function pdfUrl(paper: Paper): string {
  return `https://arxiv.org/pdf/${paper.id}v${paper.version}`;
}
