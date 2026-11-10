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

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseFeed } from '../src/arxiv.ts';
import { abbreviateAuthor, compactAuthors, displayName } from '../src/authors.ts';
import { createDigest } from '../src/digest.ts';
import { renderDigest } from '../src/render.ts';
import { archivedBatch, openPaperDatabase, saveDownload } from '../src/store.ts';

const batch = parseFeed(readFileSync(new URL('./fixtures/quant-ph.xml', import.meta.url), 'utf8'), 'quant-ph');

test('RSS retains full author order and parses XML entities', () => {
  assert.deepEqual(batch.papers[0].authors, ['Jaeseong Heo', 'Young-Hoon Kiem', 'Chul-hee Lee']);
});

test('compact authors show all up to four, or first two … last two with no duplication', () => {
  const names = ['Ada Lovelace', 'Grace Hopper', 'Alan Turing', 'John von Neumann', 'Katherine Johnson'];
  assert.equal(compactAuthors([]), '');
  assert.equal(compactAuthors(names.slice(0, 1)), 'A. Lovelace');
  assert.equal(compactAuthors(names.slice(0, 3)), 'A. Lovelace, G. Hopper, A. Turing');
  assert.equal(compactAuthors(names.slice(0, 4)), 'A. Lovelace, G. Hopper, A. Turing, J. von Neumann');
  assert.equal(compactAuthors(names), 'A. Lovelace, G. Hopper … J. von Neumann, K. Johnson');
  assert.equal(abbreviateAuthor('María de la Cruz'), 'M. de la Cruz');
  assert.equal(abbreviateAuthor('John Smith Jr.'), 'J. Smith Jr.');
  assert.equal(abbreviateAuthor('The Quantum Collaboration'), 'The Quantum Collaboration');
  assert.equal(abbreviateAuthor('Cher'), 'Cher');
  assert.equal(displayName(String.raw`Mika A. Sillanp\"a\"a`), 'Mika A. Sillanpää');
});

test('author tooltips preserve every full name and safely escape HTML', () => {
  const names = ['Ada Lovelace', 'Grace Hopper', 'Alan Turing', 'John von Neumann', 'Katherine Johnson'];
  const digest = createDigest([{ ...batch, papers: [{ ...batch.papers[0], authors: names }] }]);
  const html = renderDigest(digest);
  assert.ok(html.includes(names.join('; ')));
  assert.ok(html.includes('A. Lovelace, G. Hopper … J. von Neumann, K. Johnson'));
  assert.match(renderDigest(createDigest([{ ...batch, papers: [{ ...batch.papers[0], authors: ['<script> & "x"'] }] }])), /&lt;script&gt;/);
  assert.match(renderDigest(createDigest([{ ...batch, papers: [{ ...batch.papers[0], authors: [] }] }])), /Authors unavailable/);
});

test('a feed refresh enriches matching archived authors without replacing source snapshots or versions', () => {
  const db = openPaperDatabase(':memory:');
  try {
    const old = { ...batch, papers: batch.papers.map(p => ({ ...p, authors: [] })) };
    saveDownload(db, { batch: old, checkedAt: '2026-11-09T10:00:00Z' });
    const before = db.prepare('SELECT papers_json FROM batches').get()?.papers_json;
    saveDownload(db, { batch, checkedAt: '2026-11-09T11:00:00Z' });
    assert.deepEqual(archivedBatch(db, batch.category, batch.date)?.papers[0].authors, batch.papers[0].authors);
    assert.equal(db.prepare('SELECT papers_json FROM batches').get()?.papers_json, before);
    saveDownload(db, { batch: { ...batch, papers: [{ ...batch.papers[0], version: 2, authors: ['Different Author'] }] }, checkedAt: '2026-11-09T12:00:00Z' });
    assert.deepEqual(archivedBatch(db, batch.category, batch.date)?.papers[0].authors, batch.papers[0].authors);
  } finally { db.close(); }
});
