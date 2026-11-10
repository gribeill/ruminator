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
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { get as httpGet } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseHTML } from 'linkedom';
import type { Batch, Paper } from '../src/arxiv.ts';
import type { EmbeddingProvider } from '../src/embeddings.ts';
import { DEFAULT_FEEDBACK_CONFIG, paperAnchor } from '../src/feedback.ts';
import { createDigestServer } from '../src/server.ts';
import { scoreDigest } from '../src/scoring.ts';
import { captureFeedback, latestDigest, openAppDatabase, readVotes, saveDigest, saveVote } from '../src/store.ts';

const quiet = () => {};
const profiles = [{ id: 'interest', title: 'Interest', subjects: ['Physics'], keywords: [] }];
const batch: Batch = { category: 'quant-ph', date: '2026-11-10', sourceUrl: 'fixture', papers: [
  { id: '2611.00001', version: 1, title: 'Up example', abstract: 'Up text.', categories: ['quant-ph'] },
  { id: '2611.00002', version: 1, title: 'Down example', abstract: 'Down text.', categories: ['quant-ph'] },
  { id: '2611.00003', version: 1, title: 'Unrelated', abstract: 'Other text.', categories: ['quant-ph'] },
] };
const provider: EmbeddingProvider = {
  fingerprint: 'vote-test-model', dimensions: 2,
  async embed(input) {
    if (input.kind === 'profile') return [Math.SQRT1_2, Math.SQRT1_2];
    if (input.title.includes('Up')) return [1, 0];
    if (input.title.includes('Down')) return [0, 1];
    return [-1, 0];
  },
};

function future(date: string): Batch {
  return { ...batch, date, papers: batch.papers.map((p, i) => ({ ...p, id: `2611.0001${i}`, title: p.title + ' future' })) };
}

test('votes persist by base arXiv ID across versions, support change/clear, and retain idempotent history', () => {
  const dir = mkdtempSync('data/votes-test-');
  const path = join(dir, 'app.sqlite');
  let db = openAppDatabase(path);
  try {
    const paper = batch.papers[0];
    saveVote(db, paper, 1);
    saveVote(db, { ...paper, version: 2 }, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vote_events').get()!.n, 1);
    assert.deepEqual(readVotes(db), { [paper.id]: 1 });
    saveVote(db, { ...paper, version: 2 }, -1);
    assert.deepEqual(readVotes(db), { [paper.id]: -1 });
    db.close(); db = openAppDatabase(path);
    assert.deepEqual(readVotes(db), { [paper.id]: -1 });
    const snapshot = captureFeedback(db, saveDigest(db, [batch]), DEFAULT_FEEDBACK_CONFIG);
    assert.equal(snapshot.votes[0].paper.version, 2);
    saveVote(db, paper, 0);
    saveVote(db, paper, 0);
    assert.deepEqual(readVotes(db), {});
    const history = db.prepare('SELECT value, created_at FROM vote_events ORDER BY event_id').all();
    assert.deepEqual(history.map(row => row.value), [1, -1, 0]);
    assert.ok(history.every(row => typeof row.created_at === 'string'));
    assert.deepEqual(captureFeedback(db, saveDigest(db, [batch]), DEFAULT_FEEDBACK_CONFIG), snapshot);
    assert.throws(() => saveVote(db, { ...paper, id: paper.id + 'v2' }, 1), /base arXiv ID/);
  } finally { db.close(); rmSync(dir, { recursive: true }); }
});

test('feedback uses only votes captured at generation start and never changes a published ranking', async () => {
  const db = openAppDatabase(':memory:');
  try {
    const old = await scoreDigest(db, saveDigest(db, [batch]), profiles, async () => provider, quiet);
    const oldRanking = JSON.stringify(old.ranking);
    assert.ok(Object.values(old.ranking!.scores).every(s => s.feedback === 0.5));
    saveVote(db, batch.papers[0], 1);
    saveVote(db, batch.papers[1], -1);
    const pending = saveDigest(db, [future('2026-11-11')]);
    const first = await scoreDigest(db, pending, profiles, async () => {
      // This arrives after captureFeedback, before any new embeddings finish.
      saveVote(db, batch.papers[0], -1);
      return provider;
    }, quiet);
    assert.equal(first.ranking!.scores['2611.00010'].feedback, 0.75);
    assert.equal(first.ranking!.scores['2611.00011'].feedback, 0.25);
    assert.equal(first.ranking!.scores['2611.00012'].feedback, 0.5);
    assert.equal(first.ranking!.feedbackSnapshot!.fingerprint, provider.fingerprint);
    assert.equal(first.ranking!.feedbackSnapshot!.votes[0].value, 1);
    const stored = JSON.stringify(latestDigest(db, ['quant-ph'])!.ranking);
    saveVote(db, batch.papers[1], 0);
    const again = await scoreDigest(db, pending, profiles, async () => { throw new Error('Never recompute saved ranking'); }, quiet);
    assert.equal(JSON.stringify(again.ranking), stored);
    const next = await scoreDigest(db, saveDigest(db, [future('2026-11-12')]), profiles, async () => provider, quiet);
    assert.equal(next.ranking!.scores['2611.00010'].feedback, 0.25);
    assert.equal(next.ranking!.scores['2611.00011'].feedback, 0.5);
    assert.equal(JSON.stringify(old.ranking), oldRanking);
    const score = first.ranking!.scores['2611.00010'];
    assert.equal(score.total, 0.60 * score.semantic + 0.25 * score.keywords + 0.15 * score.feedback);
  } finally { db.close(); }
});

test('interrupted scoring retains its original feedback snapshot and thresholds on resumption', async () => {
  const db = openAppDatabase(':memory:');
  try {
    saveVote(db, batch.papers[0], 1);
    const pending = saveDigest(db, [future('2026-11-11')]);
    const failing: EmbeddingProvider = { ...provider, async embed(input) {
      if (input.title === 'Down example future') throw new Error('Interrupted');
      return provider.embed(input);
    } };
    await assert.rejects(scoreDigest(db, pending, profiles, async () => failing, quiet), /Interrupted/);
    saveVote(db, batch.papers[0], -1);
    const resumed = await scoreDigest(db, pending, profiles, async () => provider, quiet, undefined,
      { min_similarity: 0.99, near_duplicate_similarity: 1 });
    assert.equal(resumed.ranking!.feedbackSnapshot!.config.min_similarity, 0.90);
    assert.equal(resumed.ranking!.scores['2611.00010'].feedback, 0.75);
    const futureDigest = await scoreDigest(db, saveDigest(db, [future('2026-11-12')]), profiles, async () => provider, quiet);
    assert.equal(futureDigest.ranking!.scores['2611.00010'].feedback, 0.25);
  } finally { db.close(); }
});

test('native voting forms cover every posting, persist toggle/change/clear, and protect local POSTs', async () => {
  const db = openAppDatabase(':memory:');
  const all: Batch = { ...batch, papers: Array.from({ length: 8 }, (_, i): Paper => ({
    ...batch.papers[i % 3], id: `2611.${String(i + 1).padStart(5, '0')}`, title: `Paper ${i}`,
  })) };
  const digest = await scoreDigest(db, saveDigest(db, [all]), profiles, async () => provider, quiet);
  const ranking = JSON.stringify(digest.ranking);
  const server = createDigestServer(digest, { read: () => readVotes(db), write: (paper, value) => saveVote(db, paper, value) });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (form: URLSearchParams, headers: Record<string, string> = {}) => fetch(`${base}/vote`, {
    method: 'POST', headers: { Origin: base, 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    body: form.toString(), redirect: 'manual',
  });
  try {
    const initial = await fetch(base);
    assert.match(initial.headers.get('content-security-policy')!, /form-action 'self'/);
    const html = await initial.text();
    const doc = parseHTML(html).document;
    const forms = doc.querySelectorAll('form.vote-controls');
    assert.equal(forms.length, 8);
    assert.equal(doc.querySelectorAll('article form.vote-controls').length, 6);
    assert.equal(doc.querySelectorAll('.posting details form.vote-controls').length, 2);
    assert.equal(doc.querySelectorAll('article details form').length, 0);
    for (const actions of doc.querySelectorAll('.paper-actions')) {
      assert.equal(actions.querySelectorAll('a').length, 2);
      const buttons = actions.querySelectorAll('button');
      assert.deepEqual([...buttons].map(button => button.textContent), ['+', '−']);
      assert.equal(buttons[0].getAttribute('title'), 'More relevant to my interests');
      assert.equal(buttons[1].getAttribute('title'), 'Less relevant to my interests');
    }
    for (const posting of doc.querySelectorAll('.posting')) {
      const details = posting.querySelector('details')!;
      assert.equal(details.hasAttribute('open'), false);
      assert.ok(details.querySelector('.paper-actions form'));
    }
    assert.doesNotMatch(html, /👍|👎/);
    assert.equal(doc.querySelector('script'), null);
    const remaining = digest.ranking!.remainingIds[0];
    const token = forms[0].querySelector('input[name="token"]')!.getAttribute('value')!;
    const form = new URLSearchParams({ paper: remaining, token, value: '1' });
    const up = await post(form);
    assert.equal(up.status, 303);
    assert.equal(up.headers.get('location'), `/#${paperAnchor(remaining)}`);
    assert.equal(readVotes(db)[remaining], 1);
    let updated = parseHTML(await (await fetch(base)).text()).document;
    const anchor = updated.getElementById(paperAnchor(remaining))!;
    const active = anchor.querySelector('button[aria-pressed="true"]')!;
    assert.equal(active.textContent, '+');
    assert.equal(active.getAttribute('value'), '0');
    const historySize = db.prepare('SELECT COUNT(*) AS n FROM vote_events').get()!.n;
    await post(form); // Same desired state, not a second toggle.
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vote_events').get()!.n, historySize);
    form.set('value', '-1');
    assert.equal((await post(form)).status, 303);
    assert.equal(readVotes(db)[remaining], -1);
    form.set('value', '0');
    await post(form);
    assert.equal(readVotes(db)[remaining], undefined);
    assert.equal(JSON.stringify(latestDigest(db, ['quant-ph'])!.ranking), ranking);

    form.set('value', '1');
    assert.equal((await post(form, { Origin: 'https://attacker.example' })).status, 403);
    assert.equal((await post(new URLSearchParams({ paper: remaining, token: 'wrong', value: '1' }))).status, 403);
    assert.equal((await post(new URLSearchParams({ paper: 'unknown', token, value: '1' }))).status, 400);
    assert.equal((await post(new URLSearchParams({ paper: remaining, token, value: '99' }))).status, 400);
    assert.equal((await post(form, { 'Content-Type': 'text/plain' })).status, 415);
    assert.equal((await post(new URLSearchParams({ paper: remaining, token, value: '1', large: 'x'.repeat(4096) }))).status, 413);
    const reboundStatus = await new Promise<number | undefined>((resolve, reject) => {
      httpGet(base, { headers: { Host: 'attacker.example' } }, response => {
        response.resume(); resolve(response.statusCode);
      }).on('error', reject);
    });
    assert.equal(reboundStatus, 403);
    assert.deepEqual(readVotes(db), {});
    // A version change doesn't reset the saved vote identity or pressed state.
    saveVote(db, { ...digest.papers[0], version: 2 }, 1);
    updated = parseHTML(await (await fetch(base)).text()).document;
    assert.equal(updated.getElementById(paperAnchor(digest.papers[0].id))!.querySelector('button[aria-pressed="true"]')!.textContent, '+');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    db.close();
  }
});
