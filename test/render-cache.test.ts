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
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import katex from 'katex';
import { parseHTML } from 'linkedom';
import { createDigest } from '../src/digest.ts';
import { paperAnchor } from '../src/feedback.ts';
import type { Publication } from '../src/listing-store.ts';
import { createDigestRenderer, renderDigest } from '../src/render.ts';
import { createDigestServer } from '../src/server.ts';
import { openAppDatabase, readVotes, saveVote } from '../src/store.ts';

function digestFixture() {
  const digest = createDigest([{ category: 'quant-ph', date: '2026-11-11', sourceUrl: 'fixture', papers:
    Array.from({ length: 8 }, (_, i) => ({ id: `2611.${String(i + 1).padStart(5, '0')}`, version: 1,
      title: `Paper $x^2$ ${i} <script>not HTML</script>`, abstract: `Result $E=mc^2$ ${i} <!-- not a template slot -->`,
      categories: ['quant-ph'], authors: ['A. Researcher'],
    })),
  }]);
  digest.summaries = Object.fromEntries(digest.featuredIds.map(id => [id, {
    paperId: id, version: 1, status: 'available' as const, createdAt: '2026-11-11T12:00:00Z',
    summary: 'Scientific description $y=2$ <img src=x onerror=alert(1)>.',
  }]));
  return digest;
}

test('compiled rendering snapshots paper content and safely updates only forms', () => {
  const digest = digestFixture();
  const voting = { csrfToken: 'token<&"', votes: { [digest.papers[0].id]: 1 as const } };
  const expected = renderDigest(digest, voting);
  const render = createDigestRenderer(digest);
  assert.equal(render(voting), expected);
  digest.papers[0].title = 'Changed outside the compiled snapshot';
  digest.papers[0].id = '2611.99999';
  assert.equal(render(voting), expected);
  assert.match(render(voting), /value="token&lt;&amp;&quot;"/);
  assert.doesNotMatch(render(voting), /<script>|<img /);
  const updated = parseHTML(render({ ...voting, votes: {} })).document;
  assert.equal(updated.querySelectorAll('button[aria-pressed="true"]').length, 0);
  assert.equal(updated.querySelectorAll('form').length, 8);
});

test('loopback GET/HEAD/votes reuse frozen KaTeX; publication changes recompile once and reject stale forms', async t => {
  const db = openAppDatabase(':memory:');
  const math = t.mock.method(katex, 'renderToString'); // Wrap the real renderer, counting actual KaTeX work.
  let publication: Publication = { generationId: 'first', digest: digestFixture() };
  let voteReads = 0;
  const server = createDigestServer(() => structuredClone(publication), {
    read: () => { voteReads++; return readVotes(db); }, write: (paper, value) => saveVote(db, paper, value),
  });
  assert.equal(math.mock.callCount(), 8 * 2 + 6); // Titles, abstracts, and featured summaries, once each.
  const originalCalls = math.mock.callCount();
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const page = async () => parseHTML(await (await fetch(base)).text()).document;
  const post = (body: URLSearchParams) => fetch(`${base}/vote`, {
    method: 'POST', headers: { Origin: base }, body, redirect: 'manual',
  });
  try {
    const initial = await page();
    await page();
    const form = initial.querySelector('form')!;
    const id = form.querySelector('input[name="paper"]')!.getAttribute('value')!;
    const token = form.querySelector('input[name="token"]')!.getAttribute('value')!;
    const body = new URLSearchParams({ paper: id, token, value: '1' });
    const reads = voteReads;
    assert.equal((await fetch(base, { method: 'HEAD' })).status, 200);
    assert.equal(voteReads, reads);
    assert.equal((await post(body)).status, 303);
    const upvoted = await page();
    assert.equal(upvoted.getElementById(paperAnchor(id))!.querySelector('button[aria-pressed="true"]')!.textContent, '+');
    assert.deepEqual([...upvoted.querySelectorAll('.abstract')].map(p => p.innerHTML), [...initial.querySelectorAll('.abstract')].map(p => p.innerHTML));
    body.set('value', '0');
    assert.equal((await post(body)).status, 303);
    assert.equal((await page()).querySelectorAll('button[aria-pressed="true"]').length, 0);
    assert.equal(math.mock.callCount(), originalCalls);
    // Adding a summary under the same generation ID must refresh content too.
    publication.digest.summaries![id].summary = 'Replaced summary $z=3$.';
    assert.equal((await post(body)).status, 403);
    const replacementCalls = math.mock.callCount();
    assert.equal(replacementCalls, originalCalls * 2);
    const updated = await page();
    assert.match(updated.getElementById(paperAnchor(id))!.querySelector('.paper-summary')!.textContent, /Replaced summary/);
    assert.notEqual(updated.querySelector('input[name="token"]')!.getAttribute('value'), token);
    assert.equal(math.mock.callCount(), replacementCalls);
    publication = { ...publication, generationId: 'second' };
    await page();
    assert.equal(math.mock.callCount(), originalCalls * 3);
    await page();
    assert.equal(math.mock.callCount(), originalCalls * 3);
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); db.close();
  }
});
