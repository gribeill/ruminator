// Copyright 2026 Guilhem Ribeill
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { loadHostedSource } from '../src/hosted/html-source.ts';
import { MAX_HTML_BYTES } from '../src/fulltext-types.ts';
import { startHostedFixture } from '../scripts/hosted-fixtures.ts';
import { productionAdapters, scheduledExecution } from '../src/hosted/execution.ts';
import { createHostedApp } from '../src/hosted/app.ts';
import { readReading } from '../src/hosted/reading-store.ts';

const html = readFileSync('test/fixtures/paper-unsectioned.html', 'utf8');

test('hosted HTML transport is bounded, versioned, credential-free and has no redirects/fallback/retries', async () => {
  const paper = { id: '2601.00001', version: 2 };
  let calls = 0;
  const source = await loadHostedSource(paper, async (input, init) => {
    calls++;
    assert.equal(input, 'https://arxiv.org/html/2601.00001v2');
    assert.equal(init?.redirect, 'error'); assert.ok(init?.signal);
    assert.equal(new Headers(init?.headers).has('Authorization'), false);
    return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  });
  assert.equal(calls, 1); assert.equal(source.result.status, 'available'); assert.equal(source.html, html);
  const cached = await loadHostedSource(paper, async () => { throw new Error('Must reuse verified raw text'); }, html);
  assert.equal(cached.result.text, source.result.text);
  for (const response of [new Response('not HTML', { headers: { 'Content-Type': 'text/plain' } }),
    new Response('redirect', { status: 302, headers: { Location: 'https://untrusted.test/' } }),
    new Response('missing', { status: 404 }),
    new Response('oversized', { headers: { 'Content-Type': 'text/html', 'Content-Length': String(MAX_HTML_BYTES + 1) } }),
    new Response('<html><body>short</body></html>', { headers: { 'Content-Type': 'text/html' } })]) {
    let count = 0;
    assert.equal((await loadHostedSource(paper, async () => { count++; return response; })).result.status, 'unavailable');
    assert.equal(count, 1);
  }
  const failed = await loadHostedSource(paper, async () => { throw new Error('SECRET upstream message'); }, '<html>old unusable HTML</html>');
  assert.equal(failed.html, '<html>old unusable HTML</html>'); assert.doesNotMatch(JSON.stringify(failed), /SECRET/);
  await assert.rejects(loadHostedSource({ id: '../private', version: 1 }, async () => { throw new Error('must not fetch'); }), /Invalid arXiv/);
});

test('production composition remains gated, and real adapters execute only through recorded transports', { timeout: 180000 }, async t => {
  const fixture = await startHostedFixture('scripts/hosted-production-fixture.ts', 'FixtureProductionWorkflow');
  const { db, worker, owner, friend, access, origin } = fixture;
  const env = await worker.getEnv();
  const inspector = await worker.introspectWorkflow('GENERATION');
  await inspector.modifyAll(async c => { await c.disableSleeps(); await c.disableRetryDelays(); });
  try {
    await db.batch([
      db.prepare('CREATE TABLE fixture_transport (kind TEXT, key TEXT, calls INTEGER, PRIMARY KEY(kind,key))'),
      db.prepare('CREATE TABLE fixture_settings (key TEXT PRIMARY KEY, value TEXT)'),
      db.prepare("INSERT INTO fixture_settings VALUES ('rss', ?)").bind(readFileSync('test/fixtures/quant-ph.xml', 'utf8')),
      db.prepare("INSERT INTO fixture_settings VALUES ('lose_ack', '1')"),
    ]);
    const before = await readReading(db, owner.id);
    await t.test('binding/credentials alone do not enable execution; schedule needs both switches', async () => {
      let io = 0;
      const noIO: typeof fetch = async () => { io++; throw new Error('Unexpected network'); };
      const time = Date.parse('2030-01-08T11:00:00Z');
      for (const flags of [
        { HOSTED_EXECUTION_ENABLED: undefined, HOSTED_SCHEDULE_ENABLED: 'true' },
        { HOSTED_EXECUTION_ENABLED: 'TRUE', HOSTED_SCHEDULE_ENABLED: 'true' },
        { HOSTED_EXECUTION_ENABLED: 'false', HOSTED_SCHEDULE_ENABLED: 'true' },
        { HOSTED_EXECUTION_ENABLED: 'true', HOSTED_SCHEDULE_ENABLED: 'false' },
      ]) assert.equal((await scheduledExecution({ ...env, ...flags }, time, noIO)).status, 'disabled');
      const missing = { ...env, HOSTED_SCHEDULE_ENABLED: 'true', CLOUDFLARE_GATEWAY_ID: undefined };
      await assert.rejects(scheduledExecution(missing, time, noIO), /credentials/);
      assert.throws(() => productionAdapters(missing, { id: 'unadmitted', userId: owner.id, summariesRequested: true }, noIO), /credentials/);
      assert.throws(() => productionAdapters({ ...env, HOSTED_EXECUTION_ENABLED: 'false' },
        { id: 'unadmitted', userId: owner.id, summariesRequested: false }, noIO), /disabled/);
      assert.equal(io, 0); assert.equal(await db.prepare('SELECT 1 FROM scheduled_pass').first(), null);
      assert.equal(await db.prepare('SELECT 1 FROM generation_runs').first(), null);
      const token = await access.token('owner@example.test');
      for (const settings of [{ ...env, HOSTED_EXECUTION_ENABLED: 'false' }, missing]) {
        const app = createHostedApp(settings);
        const response = await app(new Request(origin + '/admin/rebuild', { method: 'POST',
          headers: { Origin: origin, 'Cf-Access-Jwt-Assertion': token, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'confirm=paid' }));
        assert.equal(response.status, 503);
      }
      assert.deepEqual(await readReading(db, owner.id), before);
    });

    await t.test('native scheduled dispatch runs production adapters and survives lost summary acknowledgement without resends', async () => {
      // Keep this test deterministic; shared concurrent claims are covered by the
      // existing Workflow tests. No account data or real secrets are used here.
      await db.prepare('UPDATE users SET enabled = 0 WHERE id = ?').bind(friend.id).run();
      await worker.scheduled({ scheduledTime: new Date('2030-01-08T11:00:00Z'), cron: '0 10,11 * * 1-5' });
      const run = (await db.prepare('SELECT generation_id FROM generation_runs WHERE user_id = ?').bind(owner.id)
        .first<{ generation_id: string }>())!;
      const instance = await worker.introspectWorkflowInstance('GENERATION', run.generation_id);
      try { await instance.waitForStatus('complete'); assert.equal(await instance.getOutput(), 'published'); }
      finally { await instance.dispose(); }
      const reading = (await readReading(db, owner.id))!;
      assert.notEqual(reading.generationId, before!.generationId);
      assert.equal(Object.keys(reading.digest.summaries!).length, 6);
      assert.ok(Object.values(reading.digest.summaries!).every(s => s.status === 'available' && s.provenance?.actualModel === 'fixture/actual-model'));
      const rows = (await db.prepare('SELECT kind, sum(calls) AS n FROM fixture_transport GROUP BY kind').all<{ kind: string; n: number }>()).results;
      assert.equal(rows.find(r => r.kind === 'feed')!.n, 1);
      assert.equal(rows.find(r => r.kind === 'html')!.n, 6);
      assert.equal(rows.find(r => r.kind === 'summary')!.n, 6);
      assert.ok(rows.find(r => r.kind === 'embedding')!.n > 0);
      assert.equal(await db.prepare("SELECT 1 FROM fixture_transport WHERE kind IN ('embedding','summary') AND calls != 1").first(), null);
      assert.equal((await db.prepare("SELECT value FROM fixture_settings WHERE key = 'lose_ack'").first<{ value: string }>())!.value, '0');
      await worker.scheduled({ scheduledTime: new Date('2030-01-08T11:00:00Z'), cron: '0 10,11 * * 1-5' });
      assert.deepEqual((await db.prepare('SELECT kind, sum(calls) AS n FROM fixture_transport GROUP BY kind').all()).results, rows);
      const saved = await db.prepare('SELECT config, interests FROM generation_inputs WHERE id = ?').bind(run.generation_id).first();
      assert.doesNotMatch(JSON.stringify(saved), /fixture-only-token|CLOUDFLARE_API_TOKEN/);
    });
    await t.test('disabled execution stops an admitted cache-compatible run before effects or publication', async () => {
      const before = await readReading(db, owner.id);
      const paid = (await db.prepare("SELECT sum(calls) AS n FROM fixture_transport WHERE kind IN ('embedding','summary')").first<{ n: number }>())!.n;
      await db.prepare("INSERT INTO fixture_settings VALUES ('disable', '1')").run();
      await db.prepare("UPDATE fixture_settings SET value = ? WHERE key = 'rss'")
        .bind(readFileSync('test/fixtures/quant-ph.xml', 'utf8').replaceAll(/<pubDate>[^<]+<\/pubDate>/g, '<pubDate>2030-01-09T12:00:00Z</pubDate>')).run();
      await worker.scheduled({ scheduledTime: new Date('2030-01-09T11:00:00Z'), cron: '0 10,11 * * 1-5' });
      const run = (await db.prepare('SELECT generation_id FROM generation_runs WHERE user_id = ?').bind(owner.id).first<{ generation_id: string }>())!;
      const instance = await worker.introspectWorkflowInstance('GENERATION', run.generation_id);
      try { await instance.waitForStatus('complete'); assert.equal(await instance.getOutput(), 'failed'); }
      finally { await instance.dispose(); }
      assert.deepEqual(await readReading(db, owner.id), before);
      assert.equal((await db.prepare("SELECT sum(calls) AS n FROM fixture_transport WHERE kind IN ('embedding','summary')").first<{ n: number }>())!.n, paid);
      assert.equal(await db.prepare('SELECT 1 FROM embedding_requests WHERE generation_id = ?').bind(run.generation_id).first(), null);
    });
  } finally { await inspector.dispose(); await fixture.close(); }
});

test('default Worker scheduled handler and manifests remain inert', { timeout: 120000 }, async () => {
  const fixture = await startHostedFixture();
  try {
    await fixture.worker.scheduled({ scheduledTime: new Date('2030-01-08T11:00:00Z'), cron: '0 10,11 * * 1-5' });
    assert.equal(await fixture.db.prepare('SELECT 1 FROM scheduled_pass').first(), null);
    assert.equal(await fixture.db.prepare('SELECT 1 FROM generation_runs').first(), null);
    for (const path of ['wrangler.hosted.jsonc', 'wrangler.production.jsonc']) {
      const config = readFileSync(path, 'utf8');
      assert.match(config, /"HOSTED_EXECUTION_ENABLED": "false"/);
      assert.match(config, /"HOSTED_SCHEDULE_ENABLED": "false"/);
      assert.doesNotMatch(config, /"(?:crons|workflows)"\s*:/);
    }
  } finally { await fixture.close(); }
});
