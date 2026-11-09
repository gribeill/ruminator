import { pdfUrl, type Paper } from './arxiv.ts';
import type { Digest } from './digest.ts';
import { escapeHtml as escape, renderMathText } from './math.ts';

function abstract(paper: Paper): string {
  return `<p class="abstract">${renderMathText(paper.abstract)}</p><p><a href="${escape(pdfUrl(paper))}">PDF</a> · <a href="https://arxiv.org/abs/${escape(paper.id)}v${paper.version}">arXiv:${escape(paper.id)}</a></p>`;
}

/** Render only stored data; opening the page never generates a new selection. */
export function renderDigest(digest: Digest): string {
  const byId = new Map(digest.papers.map(p => [p.id, p]));
  const featured = digest.featuredIds.map(id => byId.get(id)!);
  const selected = new Set(digest.featuredIds);
  const rest = digest.papers.filter(p => !selected.has(p.id));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>arXiv digest · ${escape(digest.date)}</title>
<link rel="stylesheet" href="/assets/katex/katex.min.css">
<style>
body { max-width: 54rem; margin: 2rem auto; padding: 0 1rem; font: 17px/1.55 system-ui, sans-serif; color: #222; background: #fff; }
h1, h2, h3 { line-height: 1.3; }
h3 { font-size: 1.1rem; }
article { margin: 2rem 0; }
.abstract { white-space: pre-wrap; }
.katex { white-space: normal; }
.katex-display { overflow-x: auto; overflow-y: hidden; }
summary { cursor: pointer; }
details { margin: 1rem 0; }
a { color: #174b92; }
</style>
</head>
<body>
<header><h1>arXiv digest</h1>
<p>${escape(digest.categories.join(', '))} · Announcement: <time datetime="${escape(digest.date)}">${escape(digest.date)}</time> · ${digest.papers.length} papers</p>
<p>Latest downloaded announcement batch, including cross-listings; revisions excluded.</p></header>
<main>
<section><h2>Random picks</h2>
<p>A fixed daily random selection—not recommendations yet.</p>
${featured.map(p => `<article><h3>${renderMathText(p.title)}</h3>${abstract(p)}</article>`).join('\n')}
${digest.papers.length === 0 ? '<p>No new papers in this announcement batch.</p>' : ''}
</section>
<section><h2>Other postings (${rest.length})</h2>
${rest.map(p => `<details><summary>${renderMathText(p.title)}</summary>${abstract(p)}</details>`).join('\n')}
</section>
</main>
</body>
</html>`;
}
