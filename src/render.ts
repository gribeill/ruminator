import { pdfUrl, type Paper } from './arxiv.ts';
import type { Digest } from './digest.ts';
import { escapeHtml as escape, renderMathText } from './math.ts';
import { compactAuthors, displayName } from './authors.ts';

function abstract(paper: Paper): string {
  return `<p class="abstract">${renderMathText(paper.abstract)}</p><p><a href="${escape(pdfUrl(paper))}">PDF</a> · <a href="https://arxiv.org/abs/${escape(paper.id)}v${paper.version}">arXiv:${escape(paper.id)}</a></p>`;
}

function scoreLabel(paper: Paper, digest: Digest): string {
  const semantic = digest.semantic?.papers[paper.id];
  if (!semantic) return '<small class="score">unscored</small>';
  const profile = digest.semantic!.profiles.find(p => p.id === semantic.profileId);
  const score = digest.ranking?.scores[paper.id];
  const breakdown = score ? `Semantic: ${score.semantic.toFixed(3)}; Keywords: ${score.keywords.toFixed(3)}; Feedback: ${score.feedback.toFixed(3)} (neutral). ` : '';
  const tooltip = `${breakdown}Closest profile: ${profile?.title ?? semantic.profileId}`;
  return `<small class="score" title="${escape(tooltip)}">${(score?.total ?? semantic.score).toFixed(3)}</small>`;
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
.score, .selection { font-size: 0.85rem; font-weight: normal; color: #555; white-space: nowrap; margin-left: 0.5rem; }
.authors { display: block; font-size: 0.85rem; color: #555; margin: 0.2rem 0; }
</style>
</head>
<body>
<header><h1>arXiv digest</h1>
<p>${escape(digest.categories.join(', '))} · Announcement: <time datetime="${escape(digest.date)}">${escape(digest.date)}</time> · ${digest.papers.length} papers</p>
<p>Latest downloaded announcement batch, including cross-listings; revisions excluded.</p>
<p>${digest.ranking ? 'Relevance scores: 0–1, not probabilities. Hover for semantic/keyword/feedback components. The remaining list balances relevance and topic diversity, so scores need not decrease monotonically.' : 'Ranking not yet saved. Run npm run score to score and order this batch locally.'}</p></header>
<main>
<section><h2>${digest.ranking ? 'Featured papers' : 'Random picks'}</h2>
<p>${digest.ranking ? 'Four relevant picks, one adjacent topic, and one gently relevance-weighted wildcard, when enough papers are available.' : 'Temporary random selection; run scoring to generate recommendations.'}</p>
${featured.map(p => `<article><h3>${renderMathText(p.title)} ${scoreLabel(p, digest)} ${selectionLabel(p.id, digest)}</h3>${authors(p)}${abstract(p)}</article>`).join('\n')}
${digest.papers.length === 0 ? '<p>No new papers in this announcement batch.</p>' : ''}
</section>
<section><h2>Other postings (${rest.length})</h2>
${rest.map(p => `<details><summary>${renderMathText(p.title)} ${scoreLabel(p, digest)}${authors(p)}</summary>${abstract(p)}</details>`).join('\n')}
</section>
</main>
</body>
</html>`;
}
