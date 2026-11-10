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

import katex from 'katex';

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]!);
}

function isEscaped(text: string, index: number): boolean {
  let slashes = 0;
  while (index > 0 && text[--index] === '\\') slashes++;
  return slashes % 2 === 1;
}

/** Respect escaped characters and braces so dollars inside math text don't end it. */
function findEnd(text: string, start: number, delimiter: string): number {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (depth === 0 && text.startsWith(delimiter, i)) return i;
    if (text[i] === '\\') { i++; continue; }
    if (text[i] === '{') depth++;
    if (text[i] === '}') depth = Math.max(0, depth - 1);
  }
  return -1;
}

/** Render delimited TeX without accepting HTML from paper titles or abstracts. */
export function renderMathText(text: string): string {
  const delimiters = /\$\$|\$|\\\(|\\\[/g;
  let html = '';
  let cursor = 0;
  for (let match; (match = delimiters.exec(text));) {
    if (isEscaped(text, match.index)) continue;
    const opening = match[0];
    const closing = opening === '\\(' ? '\\)' : opening === '\\[' ? '\\]' : opening;
    const start = match.index + opening.length;
    const end = findEnd(text, start, closing);
    if (end < 0) continue;
    const after = end + closing.length;
    html += escapeHtml(text.slice(cursor, match.index));
    try {
      html += katex.renderToString(text.slice(start, end), {
        displayMode: opening === '$$' || opening === '\\[',
        throwOnError: true,
        trust: false,
        strict: 'ignore',
        maxSize: 20,
        maxExpand: 1000,
      });
    } catch {
      // Unsupported/malformed TeX remains readable instead of breaking the digest.
      html += escapeHtml(text.slice(match.index, after));
    }
    cursor = after;
    delimiters.lastIndex = after;
  }
  return html + escapeHtml(text.slice(cursor));
}
