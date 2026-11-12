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

import { pdfUrl, type Paper } from './arxiv.ts';
import type { Digest } from './digest.ts';
import { escapeHtml as escape, renderMathText } from './math.ts';
import { compactAuthors, displayName } from './authors.ts';
import { uiText, uiHtml } from './ui-text.ts';
import { paperAnchor, type Votes } from './feedback.ts';

export interface VotingView {
  votes: Votes;
  csrfToken: string;
  action?: string;
}

export interface ReadingLink { href: string; label: string }
export interface CowNavigation { links: readonly ReadingLink[]; email?: string }

export const brandStyles = `
.brand { display: flex; align-items: center; gap: 1.5rem; flex-wrap: wrap; background: #eee; padding: 5px; border-radius: 5px; margin: 1em 0; }
.brand h1 { margin: 0.3em 0; }
.cow { margin: 0 0 0 auto; font: 12px/1.2 "Lucida Console", Monaco, monospace; white-space: pre; }
.cow-account { margin-left: auto; max-width: 100%; }
.cow-bubble { white-space: pre; font: 11px/1.2 "Lucida Console", Monaco, monospace; }
.brand-user { min-width: 0; max-width: 100%; }
.cow-email { margin: 0.4em 0 0; font: 11px/1.4 "Lucida Console", Monaco, monospace; overflow-wrap: anywhere; }
`;

/** Hosted navigation is accessible text; only the decorative cow/tail is hidden. */
export function renderBrand(navigation?: CowNavigation): string {
  const drawing = `<pre class="cow" aria-hidden="true">${escape(navigation ? '          \\\n           \\\n' + cow : cow)}</pre>`;
  if (!navigation) return `<div class="brand"><h1>${uiHtml('shared.name')}</h1>${drawing}</div>`;
  const links = navigation.links.map(link => `<a href="${escape(link.href)}">${escape(link.label)}</a>`).join(' | ');
  // Measure visible labels, not HTML markup, so the ASCII frame stays aligned.
  const length = navigation.links.map(link => link.label).join(' | ').length;
  const width = Math.max(12, length);
  const bubble = `<nav class="cow-bubble" aria-label="${uiHtml('navigation.account')}"><span aria-hidden="true"> ${'_'.repeat(width + 2)}\n&lt; </span>${links}<span aria-hidden="true">${' '.repeat(width - length)} &gt;\n ${'-'.repeat(width + 2)}</span></nav>`;
  const account = navigation.email ? `<p class="cow-email">${escape(navigation.email)} | <a href="/reader">${uiHtml('navigation.digest')}</a></p>` : '';
  return `<div class="brand"><div class="brand-user"><h1>${uiHtml('shared.name')}</h1>${account}</div><div class="cow-account">${bubble}${drawing}</div></div>`;
}

export const footerStyles = `
footer { text-align: center; margin-top: 2em; border-top: 1px dashed #ddd; padding-top: 1em; }
footer a { text-decoration: none; }
.footer-cow { display: inline-block; vertical-align: middle; text-align: left; white-space: pre; font: 12px/1.2 "Lucida Console", Monaco, monospace; }
`;

/** Resolve the year when serving, even when the saved digest predates New Year. */
export function renderFooter(): string {
  return `<footer>${uiHtml('footer.copyright', { year: new Date().getFullYear() })} | <a href="https://github.com/gribeill/ruminator">${uiHtml('footer.github')}</a> | <span class="footer-cow" aria-hidden="true">  ^__^\n  (oo)</span></footer>`;
}

function voteControls(id: string, voting?: VotingView): string {
  if (!voting) return '';
  const current = voting.votes[id] ?? 0;
  return `<form class="vote-controls" method="post" action="${escape(voting.action ?? '/vote')}">
<input type="hidden" name="paper" value="${escape(id)}">
<input type="hidden" name="token" value="${escape(voting.csrfToken)}">
<button type="submit" name="value" value="${current === 1 ? 0 : 1}" aria-pressed="${current === 1}" aria-label="${uiHtml(current === 1 ? 'votes.clear_up' : 'votes.more')}" title="${uiHtml(current === 1 ? 'votes.clear_up' : 'votes.more_tooltip')}">${uiHtml('votes.up_symbol')}</button>
<button type="submit" name="value" value="${current === -1 ? 0 : -1}" aria-pressed="${current === -1}" aria-label="${uiHtml(current === -1 ? 'votes.clear_down' : 'votes.less')}" title="${uiHtml(current === -1 ? 'votes.clear_down' : 'votes.less_tooltip')}">${uiHtml('votes.down_symbol')}</button>
</form>`;
}

// Keep the cow as literal text, then escape it like any other HTML content.
const cow = String.raw`            ^__^
            (oo)\_______
            (__)\       )\/\
                ||----w |
                ||     ||`;

function abstract(paper: Paper, collapsible = false): string {
  const text = `<p class="abstract">${renderMathText(paper.abstract)}</p>`;
  return collapsible ? `<details class="featured-abstract"><summary>${uiHtml('reading.abstract')}</summary>${text}</details>` : text;
}

// Keep actions outside both featured disclosures, but inside remaining-paper dropdowns.
function paperLinks(paper: Paper): string {
  return `<div class="paper-actions"><span><a href="${escape(pdfUrl(paper))}">${uiHtml('reading.pdf')}</a> | <a href="https://arxiv.org/abs/${escape(paper.id)}v${paper.version}">${uiHtml('reading.arxiv', { id: paper.id })}</a></span>`;
}

function summary(paper: Paper, digest: Digest): string {
  const result = digest.summaries?.[paper.id];
  if (result?.status === 'available') {
    return `<details class="paper-summary"><summary>${uiHtml('reading.summary')}</summary><p>${renderMathText(result.summary!)}</p></details>`;
  }
  const reason = uiText(result ? `summary.${result.status}` : 'summary.not_generated');
  return `<p class="summary-unavailable">${uiHtml('summary.unavailable', { reason })}</p>`;
}

function authors(paper: Paper): string {
  const names = paper.authors ?? [];
  return names.length ? `<span class="authors" title="${escape(names.map(displayName).join('; '))}">${escape(compactAuthors(names))}</span>`
    : `<span class="authors">${uiHtml('reading.authors_unavailable')}</span>`;
}

/** Round only for display; saved relevance and ordering retain their full precision. */
function score(id: string, digest: Digest): string {
  const value = digest.ranking?.scores[id]?.total ?? digest.semantic?.papers[id]?.score;
  return value === undefined ? '' : `<small class="score" title="${uiHtml(digest.ranking ? 'reading.combined_score' : 'reading.semantic_score')}">${value.toFixed(2)}</small>`;
}

function selectionLabel(id: string, digest: Digest): string {
  const role = digest.ranking?.featured.find(p => p.id === id)?.role;
  return role ? `<small class="selection">${uiHtml({ relevant: 'reading.selected', adjacent: 'reading.adjacent', wildcard: 'reading.wildcard' }[role])}</small>` : '';
}

/** Pre-render scientific content; only the small form is dynamic. No placeholder
 * replacement is used, so paper text cannot accidentally become a template slot.
 */
function preparePaper(paper: Paper, digest: Digest, featured: boolean): (voting?: VotingView) => string {
  const id = paper.id;
  const title = `${renderMathText(paper.title)} ${score(id, digest)}`;
  const beforeVotes = featured
    ? `<article id="${escape(paperAnchor(id))}"><h3>${title} ${selectionLabel(id, digest)}</h3>${authors(paper)}${abstract(paper, true)}${summary(paper, digest)}${paperLinks(paper)}`
    : `<div class="posting" id="${escape(paperAnchor(id))}"><details><summary>${title}${authors(paper)}</summary>${abstract(paper)}${paperLinks(paper)}`;
  const afterVotes = featured ? '</div></article>' : '</div></details></div>';
  return voting => beforeVotes + voteControls(id, voting) + afterVotes;
}

/** Compile one publication into static HTML fragments, including all KaTeX output.
 * Reuse the returned renderer across requests; votes and CSRF tokens remain live.
 */
export function createDigestRenderer(digest: Digest, navigation?: CowNavigation): (voting?: VotingView) => string {
  const byId = new Map(digest.papers.map(p => [p.id, p]));
  const featuredIds = digest.ranking?.featured.map(p => p.id) ?? digest.featuredIds;
  const featured = featuredIds.map(id => byId.get(id)!);
  const selected = new Set(featuredIds);
  const rest = digest.ranking ? digest.ranking.remainingIds.map(id => byId.get(id)!) : digest.papers.filter(p => !selected.has(p.id));
  const featuredViews = featured.map(p => preparePaper(p, digest, true));
  const remainingViews = rest.map(p => preparePaper(p, digest, false));
  const featuredHeading = uiHtml(digest.ranking ? 'reading.featured' : 'reading.random');
  const empty = digest.papers.length === 0;
  const header = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${uiHtml('reading.title', { app_name: uiText('shared.name'), date: digest.date })}</title>
<link rel="stylesheet" href="/assets/katex/katex.min.css">
<style>
/* Approximate the personal site's XMin theme without importing Hugo navigation/assets. */
body { max-width: 800px; margin: auto; padding: 1em; line-height: 1.5; font-family: Optima, Candara, Calibri, Arial, sans-serif; color: #000; background: #fff; }
h1, h2, h3 { line-height: 1.3; }
h3 { font-size: 1.1rem; }
header { border-bottom: 1px dashed #ddd; padding-bottom: 1em; }
${brandStyles}
${footerStyles}
main { hyphens: auto; overflow-wrap: break-word; }
main > section + section { border-top: 1px dashed #ddd; }
article { margin: 2em 0; }
article + article { border-top: 1px dashed #ddd; padding-top: 1em; }
.abstract { white-space: pre-wrap; }
.paper-summary { background: #f9f9f9; padding: 3px 0; }
.summary-unavailable { font-size: 0.85rem; color: #555; }
.score { font-size: 0.85rem; font-weight: normal; color: #555; margin-left: 0.5rem; }
.katex { white-space: normal; }
.katex-display { overflow-x: auto; overflow-y: hidden; }
summary { cursor: pointer; }
details { margin: 1rem 0; }
/* Links intentionally inherit browser defaults, including visited-link colours. */
.selection { background: #eee; padding: 2px 5px; border-radius: 5px; }
.selection { font-size: 0.85rem; font-weight: normal; color: #555; white-space: nowrap; margin-left: 0.5rem; }
.authors { display: block; font-size: 0.85rem; color: #555; margin: 0.2rem 0; }
.paper-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 0.75em; margin: 1em 0; }
.vote-controls { display: inline-flex; gap: 0.3em; margin: 0; }
.vote-controls button { font: inherit; color: #555; cursor: pointer; background: #f9f9f9; border: 1px solid #ccc; border-radius: 3px; min-width: 1.7em; padding: 0 0.35em; }
.vote-controls button[aria-pressed="true"] { background: #ddd; border-color: #555; }
.posting { margin: 1em 0; }
.posting > details { margin-bottom: 0.4em; }
</style>
</head>
<body>
<header>${renderBrand(navigation)}
<p>${escape(digest.categories.join(', '))} · ${uiHtml('reading.announcement')} <time datetime="${escape(digest.date)}">${escape(digest.date)}</time> · ${uiHtml('reading.paper_count', { count: digest.papers.length })}</p>
`;
  return voting => `${header}${voting ? `<p>${uiHtml('votes.guidance')}</p>` : ''}
</header>
<main>
<section><h2>${featuredHeading}</h2>
${featuredViews.map(render => render(voting)).join('\n')}
${empty ? `<p>${uiHtml('reading.empty')}</p>` : ''}
</section>
<section><h2>${uiHtml('reading.other_postings', { count: remainingViews.length })}</h2>
${remainingViews.map(render => render(voting)).join('\n')}
</section>
</main>
${renderFooter()}
</body>
</html>`;
}

/** One-shot rendering for exports/tests; servers keep a compiled renderer instead. */
export function renderDigest(digest: Digest, voting?: VotingView): string {
  return createDigestRenderer(digest)(voting);
}
