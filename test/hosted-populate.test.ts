// Copyright 2026 Guilhem Ribeill
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseHTML } from 'linkedom';
import { startHostedFixture } from '../scripts/hosted-fixtures.ts';
import { readReading } from '../src/hosted/reading-store.ts';
import { readSavedConfig, saveConfig } from '../src/hosted/saved-inputs.ts';

test('Populate feed is confirmed, replay-safe, cohort-scoped and preserves listings on empty feeds', { timeout: 180000 }, async t => {
  const fixture = await startHostedFixture('scripts/hosted-workflow-fixture.ts', 'FixtureGenerationWorkflow');
  const { db, worker, owner, friend, access, origin } = fixture;
  const inspector = await worker.introspectWorkflow('GENERATION');
  await inspector.modifyAll(async c => { await c.disableSleeps(); await c.disableRetryDelays(); });
  const xml = readFileSync('test/fixtures/quant-ph.xml', 'utf8');
  const empty = xml.replaceAll(/<item>[\s\S]*?<\/item>/g, '');
  const admin = await access.token('owner@example.test');
  const regular = await access.token('friend@example.test');
  const request = (body?: URLSearchParams, token = admin, extra: Record<string, string> = {}, path = '/admin/populate') =>
    worker.fetch(origin + path, { method: body ? 'POST' : 'GET', redirect: 'manual', headers: {
      'Cf-Access-Jwt-Assertion': token,
      ...(body ? { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' } : {}), ...extra,
    }, ...(body ? { body: body.toString() } : {}) });
  const form = async () => {
    const r = await request(undefined, admin, {}, '/admin');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('cache-control')!, /private.*no-store/);
    assert.equal(r.headers.get('referrer-policy'), 'same-origin'); // Chromium form POSTs must retain their Origin.
    const f = parseHTML(await r.text()).document.querySelector('form[action="/admin/populate"]');
    assert.ok(f);
    return new URLSearchParams({ version: f.querySelector('[name="version"]')!.getAttribute('value')!,
      token: f.querySelector('[name="token"]')!.getAttribute('value')!, confirm: 'paid' });
  };
  const feedCalls = async () => (await db.prepare('SELECT calls FROM fixture_feeds').first<{ calls: number }>())!.calls;
  try {
    await db.batch([
      db.prepare('CREATE TABLE fixture_calls (generation_id TEXT, kind TEXT, request_key TEXT, calls INTEGER, PRIMARY KEY(generation_id,kind,request_key))'),
      db.prepare('CREATE TABLE fixture_faults (generation_id TEXT PRIMARY KEY, consumed INTEGER DEFAULT 0, after_publish INTEGER DEFAULT 0)'),
      db.prepare('CREATE TABLE fixture_feeds (category TEXT PRIMARY KEY, xml TEXT, status INTEGER, calls INTEGER DEFAULT 0)'),
      db.prepare("INSERT INTO fixture_feeds VALUES ('quant-ph', ?, 200, 0)").bind(empty),
    ]);
    await db.prepare('DELETE FROM current_readings WHERE user_id = ?').bind(owner.id).run(); // Real first-publication path.
    const before = [await readReading(db, owner.id), await readReading(db, friend.id)];
    assert.equal(before[0], undefined);
    await t.test('first empty fetch with no retained batch preserves publications; forms require consent and identity', async () => {
      const f = await form();
      const noConsent = new URLSearchParams(f); noConsent.delete('confirm');
      assert.equal((await request(noConsent)).status, 400);
      assert.equal((await request(f, regular)).status, 403);
      assert.equal((await request(f, admin, { Origin: 'https://wrong.test' })).status, 403);
      for (const invalidOrigin of ['null', '']) {
        const response = await request(f, admin, { Origin: invalidOrigin });
        assert.equal(response.status, 403);
        assert.equal(await response.text(), 'Invalid origin');
      }
      assert.equal((await request(f, await access.token('owner@example.test', { jti: 'different' }))).status, 403);
      const injected = new URLSearchParams(f); injected.append('user_id', friend.id);
      assert.equal((await request(injected)).status, 400);
      assert.equal(await feedCalls(), 0);
      const response = await request(f);
      assert.equal(response.status, 200);
      assert.match(await response.text(), /no matching nonempty batch is retained/);
      assert.equal(await feedCalls(), 1);
      assert.deepEqual([await readReading(db, owner.id), await readReading(db, friend.id)], before);
      assert.equal(await db.prepare('SELECT 1 FROM generation_runs').first(), null);
      assert.equal((await request(f)).status, 409);
    });
    await t.test('saved-config changes reject stale confirmation before fetching', async () => {
      const f = await form(), config = (await readSavedConfig(db, owner.id))!;
      await saveConfig(db, owner.id, config.revision, config.text + '\n# next population\n');
      assert.equal((await request(f)).status, 409);
      assert.equal(await feedCalls(), 1);
    });
    await t.test('failed ingestion preserves publications and needs a fresh explicit confirmation', async () => {
      await db.prepare("UPDATE fixture_feeds SET status = 503 WHERE category = 'quant-ph'").run();
      const f = await form();
      assert.equal((await request(f)).status, 503);
      assert.equal((await request(f)).status, 409);
      assert.equal(await feedCalls(), 2);
      assert.equal(await db.prepare('SELECT 1 FROM generation_runs').first(), null);
      assert.deepEqual([await readReading(db, owner.id), await readReading(db, friend.id)], before);
      await db.prepare("UPDATE fixture_feeds SET status = 200 WHERE category = 'quant-ph'").run();
    });
    await t.test('one concurrent confirmation fetches once and launches independent summary-enabled Workflows', async () => {
      await db.prepare("UPDATE fixture_feeds SET xml = ? WHERE category = 'quant-ph'").bind(xml).run();
      const f = await form();
      const responses = await Promise.all([request(f), request(f)]);
      assert.deepEqual(responses.map(r => r.status).sort(), [303, 409]);
      assert.equal(await feedCalls(), 3);
      const runs = (await db.prepare('SELECT generation_id FROM generation_runs').all<{ generation_id: string }>()).results;
      assert.equal(runs.length, 2);
      for (const row of runs) {
        const i = await worker.introspectWorkflowInstance('GENERATION', row.generation_id);
        try { await i.waitForStatus('complete'); assert.equal(await i.getOutput(), 'published'); }
        finally { await i.dispose(); }
      }
      for (const user of [owner, friend]) {
        const reading = (await readReading(db, user.id))!;
        assert.ok(reading.digest.papers.length > 0);
        assert.ok(Object.values(reading.digest.summaries!).every(s => s.status === 'available'));
      }
      assert.equal((await request(f)).status, 409);
    });
    await t.test('empty refresh reuses the retained batch and unchanged publications are no-ops, including the same day', async () => {
      const before = [await readReading(db, owner.id), await readReading(db, friend.id)];
      const paid = (await db.prepare("SELECT sum(calls) AS n FROM fixture_calls WHERE kind != 'step'").first<{ n: number }>())!.n;
      await db.prepare("UPDATE fixture_feeds SET xml = ? WHERE category = 'quant-ph'").bind(empty).run();
      assert.equal((await request(await form())).status, 303);
      assert.deepEqual([await readReading(db, owner.id), await readReading(db, friend.id)], before);
      assert.equal((await db.prepare("SELECT sum(calls) AS n FROM fixture_calls WHERE kind != 'step'").first<{ n: number }>())!.n, paid);
      const f = await form();
      await db.prepare("UPDATE users SET enabled = 0 WHERE id = ?").bind(owner.id).run();
      assert.equal((await request(f)).status, 403);
    });
  } finally { await inspector.dispose(); await fixture.close(); }
});
