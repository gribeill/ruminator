// Copyright 2026 Guilhem Ribeill
// SPDX-License-Identifier: Apache-2.0

import { parseHTML } from 'linkedom';

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
