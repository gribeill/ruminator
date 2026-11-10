import { pdfUrl, type Paper } from './arxiv.ts';
import type { Digest } from './digest.ts';
import { escapeHtml as escape, renderMathText } from './math.ts';
import { compactAuthors, displayName } from './authors.ts';
import { summaryUnavailableLabel } from './summaries.ts';

// Keep the cow as literal text, then escape it like any other HTML content.
const cow = String.raw`            ^__^
            (oo)\_______
            (__)\       )\/\
                ||----w |
                ||     ||`;

function abstract(paper: Paper, collapsible = false): string {
  const text = `<p class="abstract">${renderMathText(paper.abstract)}</p>`;
  // Keep links outside the featured disclosure so they remain visible when closed.
  const body = collapsible ? `<details class="featured-abstract"><summary>Abstract</summary>${text}</details>` : text;
  return `${body}<p><a href="${escape(pdfUrl(paper))}">PDF</a> · <a href="https://arxiv.org/abs/${escape(paper.id)}v${paper.version}">arXiv:${escape(paper.id)}</a></p>`;
}

function summary(paper: Paper, digest: Digest): string {
  const result = digest.summaries?.[paper.id];
  if (result?.status === 'available') {
    return `<div class="paper-summary"><p class="text-label">AI summary</p><p>${renderMathText(result.summary!)}</p></div>`;
  }
  const reason = result ? summaryUnavailableLabel(result.status) : 'not generated';
  return `<p class="summary-unavailable">Summary unavailable: ${escape(reason)}</p>`;
}

function authors(paper: Paper): string {
  const names = paper.authors ?? [];
  return names.length ? `<span class="authors" title="${escape(names.map(displayName).join('; '))}">${escape(compactAuthors(names))}</span>`
    : '<span class="authors">Authors unavailable</span>';
}

function selectionLabel(id: string, digest: Digest): string {
  const role = digest.ranking?.featured.find(p => p.id === id)?.role;
  return role ? `<small class="selection">${{ relevant: 'For you', adjacent: 'Adjacent topic', wildcard: 'Wildcard' }[role]}</small>` : '';
}

/** Render only stored data; opening the page never generates a new selection. */
export function renderDigest(digest: Digest): string {
  const byId = new Map(digest.papers.map(p => [p.id, p]));
  const featuredIds = digest.ranking?.featured.map(p => p.id) ?? digest.featuredIds;
  const featured = featuredIds.map(id => byId.get(id)!);
  const selected = new Set(featuredIds);
  const rest = digest.ranking ? digest.ranking.remainingIds.map(id => byId.get(id)!) : digest.papers.filter(p => !selected.has(p.id));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ruminator · ${escape(digest.date)}</title>
<link rel="stylesheet" href="/assets/katex/katex.min.css">
<style>
/* Approximate the personal site's XMin theme without importing Hugo navigation/assets. */
body { max-width: 800px; margin: auto; padding: 1em; line-height: 1.5; font-family: Optima, Candara, Calibri, Arial, sans-serif; color: #000; background: #fff; }
h1, h2, h3 { line-height: 1.3; }
h3 { font-size: 1.1rem; }
header { border-bottom: 1px dashed #ddd; padding-bottom: 1em; }
.brand { display: flex; align-items: center; gap: 1.5rem; flex-wrap: wrap; background: #eee; padding: 5px; border-radius: 5px; margin: 1em 0; }
.brand h1 { margin: 0.3em 0; }
.cow { margin: 0 0 0 auto; font: 12px/1.2 "Lucida Console", Monaco, monospace; white-space: pre; }
main { hyphens: auto; overflow-wrap: break-word; }
main > section + section { border-top: 1px dashed #ddd; }
article { margin: 2em 0; }
article + article { border-top: 1px dashed #ddd; padding-top: 1em; }
.abstract { white-space: pre-wrap; }
.paper-summary { background: #f9f9f9; border-left: 5px solid #ccc; padding: 3px 1em; }
.text-label, .summary-unavailable { font-size: 0.85rem; color: #555; }
.text-label { font-weight: 600; margin-bottom: 0; }
.katex { white-space: normal; }
.katex-display { overflow-x: auto; overflow-y: hidden; }
summary { cursor: pointer; }
details { margin: 1rem 0; }
/* Links intentionally inherit browser defaults, including visited-link colours. */
.selection { background: #eee; padding: 2px 5px; border-radius: 5px; }
.selection { font-size: 0.85rem; font-weight: normal; color: #555; white-space: nowrap; margin-left: 0.5rem; }
.authors { display: block; font-size: 0.85rem; color: #555; margin: 0.2rem 0; }
</style>
</head>
<body>
<header><div class="brand"><h1>ruminator</h1>
<pre class="cow" aria-hidden="true">${escape(cow)}</pre></div>
<p>${escape(digest.categories.join(', '))} · Announcement: <time datetime="${escape(digest.date)}">${escape(digest.date)}</time> · ${digest.papers.length} papers</p>
<main>
<section><h2>${digest.ranking ? 'Featured papers' : 'Random picks'}</h2>
${featured.map(p => `<article><h3>${renderMathText(p.title)} ${selectionLabel(p.id, digest)}</h3>${authors(p)}${summary(p, digest)}${abstract(p, true)}</article>`).join('\n')}
${digest.papers.length === 0 ? '<p>No new papers in this announcement batch.</p>' : ''}
</section>
<section><h2>Other postings (${rest.length})</h2>
${rest.map(p => `<details><summary>${renderMathText(p.title)}${authors(p)}</summary>${abstract(p)}</details>`).join('\n')}
</section>
</main>
</body>
</html>`;
}
