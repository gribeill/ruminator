// Copyright 2026 Guilhem Ribeill
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseHTML } from 'linkedom';
import { fixtureDigest, startHostedFixture } from '../scripts/hosted-fixtures.ts';
import { initializeSavedConfig, readSavedConfig, readSavedInterests } from '../src/hosted/saved-inputs.ts';
import { readGenerationInputs } from '../src/hosted/generation-inputs.ts';
import { freezeFixtureInputs as freezeGenerationInputs } from '../scripts/hosted-fixtures.ts';
import { publishGeneration, stagePublication } from '../src/hosted/publication.ts';
import { readReading } from '../src/hosted/reading-store.ts';

const config = readFileSync(new URL('../config.toml', import.meta.url), 'utf8');
// linkedom treats textarea as raw text, unlike browser RCDATA. Decode one
// escaped layer and discard the deliberate initial newline as a browser does.
const textareaValue = (document: Document) => parseHTML(`<div>${document.querySelector('textarea')!.textContent!.slice(1)}</div>`)
  .document.querySelector('div')!.textContent!;
test('hosted editors: real HTTP forms, conflict preservation, authorization, and next-generation status', { timeout: 120000 }, async t => {
  const fixture = await startHostedFixture();
  const { db, worker, access, origin, owner, friend } = fixture;
  try {
    await initializeSavedConfig(db, config);
    const admin = await access.token('owner@example.test'), regular = await access.token('friend@example.test');
    const request = (path: string, token: string, body?: URLSearchParams, headers: Record<string, string> = {}) => worker.fetch(origin + path, {
      method: body ? 'POST' : 'GET', redirect: 'manual', headers: { 'Cf-Access-Jwt-Assertion': token,
        ...(body ? { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' } : {}), ...headers },
      ...(body ? { body: body.toString() } : {}),
    });
    const readForm = async (path: string, token: string) => {
      const response = await request(path, token);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('cache-control')!, /private.*no-store/);
      const document = parseHTML(await response.text()).document;
      return new URLSearchParams({ revision: document.querySelector('[name="revision"]')!.getAttribute('value')!,
        token: document.querySelector('[name="token"]')!.getAttribute('value')!, text: textareaValue(document) });
    };
    const initial = await readForm('/interests', regular);
    const adminForm = await readForm('/admin', admin);
    const digest = fixtureDigest('Editor inputs');
    const batches = [{ category: 'quant-ph', date: digest.date, sourceUrl: 'fixture', papers: digest.papers }];
    const frozen = (await freezeGenerationInputs(db, friend.id, batches, 'fixture-only'))!;
    const before = await readReading(db, friend.id);
    const publicBefore = await (await worker.fetch(origin + '/')).text();

    await t.test('session, action, ownership, role, origin, and form shape are enforced', async () => {
      assert.match(await (await request('/admin', admin)).text(), /Execution is not enabled/);
      assert.equal((await request('/admin/rebuild', admin, adminForm)).status, 503);
      assert.equal((await request('/admin/summaries', admin, adminForm)).status, 503);
      assert.equal((await request('/admin', regular)).status, 403);
      assert.equal((await request('/admin', regular, adminForm)).status, 403);
      assert.equal((await request('/interests', admin, initial)).status, 403);
      assert.equal((await request('/interests', regular, initial, { Origin: 'https://other.test' })).status, 403);
      assert.equal((await request('/interests', regular, initial, { 'Content-Type': 'application/json' })).status, 415);
      const tampered = new URLSearchParams(initial); tampered.set('revision', '2');
      assert.equal((await request('/interests', regular, tampered)).status, 403);
      const extra = new URLSearchParams(initial); extra.set('user_id', owner.id);
      assert.equal((await request('/interests', regular, extra)).status, 400);
      const duplicate = new URLSearchParams(initial); duplicate.append('text', 'another');
      assert.equal((await request('/interests', regular, duplicate)).status, 400);
      const ownInterests = await readForm('/interests', admin);
      assert.equal((await request('/admin', admin, ownInterests)).status, 403);
      const newLogin = await access.token('friend@example.test', { jti: 'new-session' });
      assert.equal((await request('/interests', newLogin, initial)).status, 403);
      await db.prepare('UPDATE users SET enabled = 0 WHERE id = ?').bind(friend.id).run();
      assert.equal((await request('/interests', regular, initial)).status, 403);
      await db.prepare('UPDATE users SET enabled = 1 WHERE id = ?').bind(friend.id).run();
    });

    await t.test('invalid and oversized documents are escaped and preserved without saving', async () => {
      for (const [path, token, original, text] of [
        ['/interests', regular, initial, '\n</textarea><script>bad()</script>'],
        ['/interests', regular, initial, initial.get('text')! + '\n<!--' + 'x'.repeat(65536) + '-->'],
        ['/admin', admin, adminForm, '<script>not TOML</script>'],
      ] as const) {
        const body = new URLSearchParams(original); body.set('text', text);
        const response = await request(path, token, body);
        assert.equal(response.status, 422);
        assert.match(response.headers.get('cache-control')!, /no-store/);
        const document = parseHTML(await response.text()).document;
        assert.equal(textareaValue(document), text);
        assert.equal(document.querySelector('script'), null);
        assert.ok(document.querySelector('[role="alert"]'));
        assert.equal(document.querySelector('[name="revision"]')!.getAttribute('value'), '1');
      }
      assert.equal((await readSavedInterests(db, friend.id))!.revision, 1);
      assert.equal((await readSavedConfig(db, owner.id))!.revision, 1);
    });

    await t.test('successful saves redirect; stale forms preserve edits and cannot overwrite the newer revision', async () => {
      const body = new URLSearchParams(initial);
      body.set('text', body.get('text')! + '\n<!-- Unicode notes: ' + '漢'.repeat(15000) + ' -->');
      const response = await request('/interests', regular, body);
      assert.equal(response.status, 303); assert.equal(response.headers.get('location'), '/interests');
      const stale = new URLSearchParams(initial); stale.set('text', initial.get('text')! + '\n<!-- conflicting edit -->');
      const rejected = await request('/interests', regular, stale);
      assert.equal(rejected.status, 409);
      const document = parseHTML(await rejected.text()).document;
      assert.equal(textareaValue(document), stale.get('text'));
      assert.equal(document.querySelector('[name="revision"]')!.getAttribute('value'), '1');
      assert.equal(document.querySelector('a[target="_blank"]')!.getAttribute('href'), '/interests');
      assert.equal((await request('/interests', regular, stale)).status, 409);
      assert.equal((await readSavedInterests(db, friend.id))!.text, body.get('text'));
      adminForm.set('text', config + '\n# Pending global settings\n');
      assert.equal((await request('/admin', admin, adminForm)).status, 303);
      assert.equal((await request('/admin', admin, adminForm)).status, 409);
      assert.deepEqual(await readGenerationInputs(db, friend.id), frozen);
      assert.deepEqual(await readReading(db, friend.id), before);
      assert.equal(await (await worker.fetch(origin + '/')).text(), publicBefore);
      assert.equal((await db.prepare('SELECT count(*) AS n FROM generation_inputs').first<{ n: number }>())!.n, 1);
      assert.equal((await db.prepare('SELECT count(*) AS n FROM summary_cache').first<{ n: number }>())!.n, 0);
    });

    await t.test('saved, published, and working revisions describe different lifecycle states', async () => {
      let html = await (await request('/interests', regular)).text();
      assert.match(html, /Saved revision 2/); assert.match(html, /working generation is frozen at revision 1/);
      await stagePublication(db, friend.id, frozen.id, digest); await publishGeneration(db, friend.id, frozen.id);
      html = await (await request('/interests', regular)).text();
      assert.match(html, /current listing uses revision 1/); assert.match(html, /pending for a future publication/);
      const next = (await freezeGenerationInputs(db, friend.id, [{ ...batches[0], date: '2030-01-01' }], 'fixture-only'))!;
      assert.equal(next.interests.revision, 2); assert.equal(next.config.revision, 2);
      html = await (await request('/interests', regular)).text();
      assert.match(html, /current listing uses revision 1/); assert.match(html, /working generation is frozen at revision 2/);
      const head = await worker.fetch(origin + '/interests', { method: 'HEAD', headers: { 'Cf-Access-Jwt-Assertion': regular } });
      assert.equal(head.status, 200); assert.equal(await head.text(), '');
    });
  } finally { await fixture.close(); }
});
