// Copyright 2026 Guilhem Ribeill
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { startHostedFixture } from '../scripts/hosted-fixtures.ts';
import { runScheduledPass, scheduledRunDate } from '../src/hosted/scheduled.ts';
import { readReading } from '../src/hosted/reading-store.ts';
import { readGenerationInputs } from '../src/hosted/generation-inputs.ts';
import { readSavedConfig, saveConfig } from '../src/hosted/saved-inputs.ts';
import { adminRunStatus } from '../src/hosted/run-status.ts';
import { parseConfig } from '../src/config-text.ts';
import { extractArxivHtml } from '../src/html-extraction.ts';
import { summaryMessages } from '../src/summary-content.ts';
import { estimatePromptTokens } from '../src/tokenizer.ts';

const xml = readFileSync('test/fixtures/quant-ph.xml', 'utf8');
const timestamp = (date: string) => Date.parse(date + 'T11:00:00Z');
const feed = (category: string, date = '2026-11-09', empty = false) => {
  const body = xml.replace('quant-ph updates on arXiv.org', `${category} updates on arXiv.org`)
    .replaceAll(/<pubDate>[^<]+<\/pubDate>/g, `<pubDate>${date}T12:00:00Z</pubDate>`);
  return empty ? body.replaceAll(/<item>[\s\S]*?<\/item>/g, '') : body;
};

test('weekday gate uses intended Eastern time across DST; categories are bounded validated settings', () => {
  for (const date of ['2026-03-06T11:00:00Z', '2026-03-09T10:00:00Z', '2026-10-30T10:00:00Z', '2026-11-02T11:00:00Z']) {
    assert.equal(scheduledRunDate(Date.parse(date)), date.slice(0, 10));
  }
  for (const date of ['2026-03-06T10:00:00Z', '2026-03-09T11:00:00Z', '2026-11-02T10:00:00Z',
    '2026-03-08T10:00:00Z', '2026-11-07T11:00:00Z', '2026-03-09T10:01:00Z']) assert.equal(scheduledRunDate(Date.parse(date)), undefined);
  assert.equal(scheduledRunDate(NaN), undefined);
  const config = readFileSync('config.toml', 'utf8');
  assert.deepEqual(parseConfig(config).ingestion.categories, ['quant-ph']);
  assert.deepEqual(parseConfig(config.replace('categories = ["quant-ph"]', 'categories = ["quant-ph", "cs.ET", "quant-ph"]')).ingestion.categories, ['cs.ET', 'quant-ph']);
  for (const value of ['[]', '["quant-ph,cs.ET"]', '["../escape"]', '[" quant-ph"]', '[1]', '"quant-ph"',
    '[' + Array(9).fill('"quant-ph"').join(',') + ']']) {
    assert.throws(() => parseConfig(config.replace('["quant-ph"]', value)));
  }
  assert.deepEqual(parseConfig(config.replace(/\[ingestion\][\s\S]*?(?=\[llm\])/, '')).ingestion.categories, ['quant-ph']);
});

test('shared weekday pass uses real D1/Workflows with recorded feeds, no live transport', { timeout: 180000 }, async t => {
  const fixture = await startHostedFixture('scripts/hosted-workflow-fixture.ts', 'FixtureGenerationWorkflow');
  const { db, worker, owner, friend } = fixture;
  const binding = (await worker.getEnv()).GENERATION;
  const inspector = await worker.introspectWorkflow('GENERATION');
  await inspector.modifyAll(async c => { await c.disableSleeps(); await c.disableRetryDelays(); });
  const completed: string[] = [];
  const done = async (id: string) => {
    const i = await worker.introspectWorkflowInstance('GENERATION', id);
    try { await i.waitForStatus('complete'); return await i.getOutput(); } finally { await i.dispose(); }
  };
  // Delay acknowledgement until the real Workflow finishes, deterministically
  // exercising cross-user cache reuse without replacing the execution engine.
  const serial = { create: async (options: Parameters<typeof binding.create>[0]) => {
    const instance = await binding.create(options);
    assert.equal(await done(instance.id), 'published'); completed.push(instance.id);
    return instance;
  } };
  const calls: string[] = [];
  let bodyDate = '2026-11-09', bad: 'network' | 'http' | 'xml' | 'mixed' | undefined, empty = false;
  const transport: typeof fetch = async (input, init) => {
    assert.equal(init?.redirect, 'manual');
    const category = decodeURIComponent(new URL(String(input)).pathname.split('/').at(-1)!);
    calls.push(category);
    if (category === 'quant-ph' && bad === 'network') throw new Error('sensitive transport details');
    if (category === 'quant-ph' && bad === 'http') return new Response('recorded failure', { status: 503 });
    if (category === 'quant-ph' && bad === 'xml') return new Response('<not-rss>');
    return new Response(feed(category, category === 'quant-ph' && bad === 'mixed' ? '2026-11-10' : bodyDate, empty));
  };
  const pass = (date: string, workflow = serial, now = new Date(timestamp(date))) =>
    runScheduledPass(db, workflow, timestamp(date), transport, () => now);
  try {
    await db.batch([
      db.prepare('CREATE TABLE fixture_calls (generation_id TEXT, kind TEXT, request_key TEXT, calls INTEGER, PRIMARY KEY(generation_id,kind,request_key))'),
      db.prepare('CREATE TABLE fixture_faults (generation_id TEXT PRIMARY KEY, consumed INTEGER DEFAULT 0, after_publish INTEGER DEFAULT 0)'),
      db.prepare('CREATE TABLE fixture_feeds (category TEXT PRIMARY KEY, xml TEXT, status INTEGER, calls INTEGER DEFAULT 0)'),
    ]);
    const config = (await readSavedConfig(db, owner.id))!;
    assert.equal((await saveConfig(db, owner.id, config.revision, config.text.replace('["quant-ph"]', '["quant-ph", "cs.ET"]'))).status, 'saved');
    const before = [await readReading(db, owner.id), await readReading(db, friend.id)];

    await t.test('partial HTTP/XML/mixed-date ingestion consumes the day without admitting anyone', async t => {
      const diagnostics: string[] = [];
      t.mock.method(console, 'error', (message: string) => diagnostics.push(message));
      for (const [date, failure] of [['2030-01-07', 'network'], ['2030-01-08', 'http'], ['2030-01-09', 'xml'], ['2030-01-10', 'mixed']] as const) {
        bad = failure;
        const count = calls.length;
        const results = await Promise.all([pass(date), pass(date)]);
        assert.deepEqual(results.map(r => r.status).sort(), ['duplicate', 'feed-failed']);
        assert.deepEqual(calls.slice(count), ['cs.ET', 'quant-ph']);
        assert.deepEqual(JSON.parse(diagnostics.at(-1)!), {
          event: 'hosted-ingestion-failed', runDate: date,
          stage: failure === 'http' || failure === 'network' ? 'feed-fetch' : failure === 'xml' ? 'feed-read-parse' : 'batch-validation',
          ...(failure === 'mixed' ? {} : { category: 'quant-ph' }),
          ...(failure === 'http' || failure === 'xml' ? { httpStatus: failure === 'http' ? 503 : 200 } : {}),
        });
        bad = undefined;
        assert.equal((await pass(date)).status, 'duplicate'); // Repair is not a same-day retry.
        assert.equal(await db.prepare('SELECT 1 FROM generation_runs').first(), null);
        assert.deepEqual([await readReading(db, owner.id), await readReading(db, friend.id)], before);
      }
      assert.equal(diagnostics.length, 4); // Duplicates never emit another failure or retry ingestion.
      assert.ok(diagnostics.every(message => !message.includes('recorded failure') && !message.includes('<not-rss>') && !message.includes('sensitive transport details')));
      assert.match(await adminRunStatus(db, owner.id), /feed ingestion failed; no users were admitted/);
      assert.equal(await adminRunStatus(db, friend.id), '');
    });

    await t.test('all enabled users get independent frozen summary-enabled runs from one shared batch', async () => {
      const count = calls.length;
      const result = await pass('2030-01-11');
      assert.equal(result.status, 'complete'); assert.ok('launched' in result); assert.equal(result.launched, 2);
      assert.deepEqual(calls.slice(count), ['cs.ET', 'quant-ph']);
      const spending: number[] = [];
      for (const user of [owner, friend]) {
        const current = (await readReading(db, user.id))!;
        assert.equal(current.digest.date, bodyDate); // Announcement date, not scheduler date.
        assert.equal(Object.keys(current.digest.summaries!).length, 6);
        const inputs = (await readGenerationInputs(db, user.id, current.generationId))!;
        assert.equal(inputs.summariesRequested, true); assert.equal(inputs.batches!.length, 2);
        spending.push((await db.prepare('SELECT sum(charged_input) AS n FROM summary_outcomes WHERE generation_id = ?')
          .bind(inputs.id).first<{ n: number }>())!.n);
      }
      assert.equal(spending.filter(n => n === 0).length, 1); assert.ok(spending.some(n => n > 0));
      assert.equal((await db.prepare("SELECT sum(calls) AS n FROM fixture_calls WHERE kind = 'summary'").first<{ n: number }>())!.n, 6);
      assert.equal((await pass('2030-01-11')).status, 'duplicate');
    });

    await t.test('unchanged holiday feeds are no-ops; delayed events keep their original date', async () => {
      const count = completed.length;
      const result = await pass('2030-01-14', serial, new Date('2030-01-15T09:00:00Z'));
      assert.ok('unchanged' in result); assert.equal(result.unchanged, 2);
      assert.equal(completed.length, count);
      const rows = await db.prepare('SELECT run_date, generation_id FROM generation_runs').all<{ run_date: string; generation_id: string | null }>();
      assert.ok(rows.results.every(r => r.run_date === '2030-01-14' && r.generation_id === null));
      assert.equal((await pass('2030-01-15', serial, new Date('2030-01-16T11:00:00Z'))).status, 'ignored');
      assert.equal((await pass('2030-01-15', serial, new Date('2030-01-15T10:59:59Z'))).status, 'ignored');
    });

    await t.test('failed feeds still close disabled and snapshot-less expired admissions', async () => {
      const old = (await readReading(db, friend.id))!;
      await db.prepare(`UPDATE generation_runs SET run_date = '2030-01-14', generation_id = 'interrupted-admission',
        deadline = '2030-01-15T11:00:00.000Z', finished_at = NULL WHERE user_id = ?`).bind(friend.id).run();
      await db.prepare('UPDATE users SET enabled = 0 WHERE id = ?').bind(friend.id).run();
      bad = 'http'; assert.equal((await pass('2030-01-15')).status, 'feed-failed'); bad = undefined;
      const failed = await db.prepare('SELECT finished_at, failure_reason FROM generation_runs WHERE user_id = ?').bind(friend.id)
        .first<{ finished_at: string; failure_reason: string }>();
      assert.ok(failed!.finished_at); assert.equal(failed!.failure_reason, 'deadline');
      await db.prepare('UPDATE users SET enabled = 1 WHERE id = ?').bind(friend.id).run();
      assert.deepEqual(await readReading(db, friend.id), old);
    });

    await t.test('an ambiguous launch does not stop the next user, and duplicate triggers never relaunch', async () => {
      bodyDate = '2030-01-16';
      const first = (await db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').first<{ id: string }>())!.id;
      let attempts = 0;
      const failing = { create: async (options: Parameters<typeof binding.create>[0]) => {
        attempts++;
        if (options!.params!.userId === first) throw new Error('fixture unconfirmed launch');
        return serial.create(options);
      } };
      const result = await pass('2030-01-16', failing);
      assert.ok('failed' in result && 'launched' in result); assert.equal(result.failed, 1); assert.equal(result.launched, 1);
      const row = await db.prepare('SELECT failure_reason, finished_at FROM generation_runs WHERE user_id = ?').bind(first)
        .first<{ failure_reason: string; finished_at: string | null }>();
      assert.equal(row!.failure_reason, 'launch'); assert.equal(row!.finished_at, null);
      assert.equal((await pass('2030-01-16', failing)).status, 'duplicate'); assert.equal(attempts, 2);
    });

    await t.test('regressed feeds and responses arriving after the deadline cannot admit users', async () => {
      bodyDate = '2026-11-09'; assert.equal((await pass('2030-01-17')).status, 'feed-failed');
      let now = new Date(timestamp('2030-01-18'));
      const result = await runScheduledPass(db, serial, now.getTime(), async (input, init) => {
        const response = await transport(input, init); now = new Date('2030-01-21T11:00:00Z'); return response;
      }, () => now);
      assert.equal(result.status, 'stale');
      assert.equal((await pass('2030-01-18')).status, 'duplicate');
    });

    await t.test('empty valid feeds reuse the latest nonempty batch without new model calls', async () => {
      bodyDate = '2030-01-21'; empty = true;
      const paid = (await db.prepare("SELECT sum(calls) AS n FROM fixture_calls WHERE kind != 'step'").first<{ n: number }>())!.n;
      assert.equal((await pass('2030-01-21')).status, 'complete');
      for (const user of [owner, friend]) {
        const reading = (await readReading(db, user.id))!;
        assert.equal(reading.digest.date, '2030-01-16');
        assert.ok(reading.digest.papers.length > 0);
      }
      assert.equal((await db.prepare("SELECT sum(calls) AS n FROM fixture_calls WHERE kind != 'step'").first<{ n: number }>())!.n, paid);
    });

    await t.test('the local scheduled-event entry uses recorded transport and duplicate events remain no-ops', async () => {
      for (const category of ['quant-ph', 'cs.ET']) await db.prepare('INSERT INTO fixture_feeds (category,xml,status) VALUES (?,?,200)')
        .bind(category, feed(category, bodyDate, true)).run();
      await worker.scheduled({ scheduledTime: new Date(timestamp('2030-01-22')), cron: '0 10,11 * * 1-5' });
      assert.equal((await db.prepare('SELECT status FROM scheduled_pass').first<{ status: string }>())!.status, 'complete');
      await worker.scheduled({ scheduledTime: new Date(timestamp('2030-01-22')), cron: '0 10,11 * * 1-5' });
      assert.ok((await db.prepare('SELECT calls FROM fixture_feeds').all<{ calls: number }>()).results.every(r => r.calls === 1));
      for (const category of ['quant-ph', 'cs.ET']) await db.prepare('UPDATE fixture_feeds SET xml = ? WHERE category = ?')
        .bind(feed(category, '2030-01-23', true), category).run();
      await worker.scheduled({ scheduledTime: new Date(timestamp('2030-01-23')), cron: '0 10,11 * * 1-5' });
      for (const row of (await db.prepare('SELECT generation_id FROM generation_runs WHERE generation_id IS NOT NULL').all<{ generation_id: string }>()).results) {
        assert.equal(await done(row.generation_id), 'published');
      }
      for (const user of [owner, friend]) assert.equal((await readReading(db, user.id))!.digest.date, '2030-01-16');
      assert.doesNotMatch(readFileSync('wrangler.hosted.jsonc', 'utf8'), /"crons"\s*:\s*\[\s*"/);
    });
    await t.test('an account disabled during ingestion is not admitted', async () => {
      const before = await readReading(db, friend.id);
      empty = false; bodyDate = '2030-01-24';
      const result = await runScheduledPass(db, serial, timestamp(bodyDate), async (input, init) => {
        await db.prepare('UPDATE users SET enabled = 0 WHERE id = ?').bind(friend.id).run();
        return transport(input, init);
      }, () => new Date(timestamp(bodyDate)));
      assert.ok('skipped' in result && 'launched' in result); assert.equal(result.skipped, 1); assert.equal(result.launched, 1);
      assert.equal((await db.prepare('SELECT run_date FROM generation_runs WHERE user_id = ?').bind(friend.id).first<{ run_date: string }>())!.run_date, '2030-01-23');
      await db.prepare('UPDATE users SET enabled = 1 WHERE id = ?').bind(friend.id).run();
      assert.deepEqual(await readReading(db, friend.id), before);
    });

    await t.test('scheduled summary ceilings are per user, not one shared allowance', async () => {
      const config = (await readSavedConfig(db, owner.id))!;
      const reading = (await readReading(db, owner.id))!;
      const text = extractArxivHtml(readFileSync('test/fixtures/paper-unsectioned.html', 'utf8'));
      const budget = Math.max(...reading.digest.papers.map(p =>
        estimatePromptTokens(summaryMessages(p, text), parseConfig(config.text).tokenizer).estimatedInputTokens));
      assert.ok(budget > 0);
      assert.equal((await saveConfig(db, owner.id, config.revision, config.text.replace('run_input_tokens = 500000', `run_input_tokens = ${budget}`)
        .replace('openai/gpt-6-luna', 'fixture/budget-test'))).status, 'saved');
      bodyDate = '2030-01-25';
      assert.equal((await pass(bodyDate)).status, 'complete');
      let total = 0;
      for (const user of [owner, friend]) {
        const reading = (await readReading(db, user.id))!;
        const charge = (await db.prepare('SELECT sum(charged_input) AS n FROM summary_outcomes WHERE generation_id = ?')
          .bind(reading.generationId).first<{ n: number }>())!.n;
        assert.ok(charge > 0 && charge <= budget); total += charge;
        assert.ok(Object.values(reading.digest.summaries!).some(s => s.status === 'token_budget'));
        assert.equal((await db.prepare("SELECT sum(calls) AS n FROM fixture_calls WHERE generation_id = ? AND kind = 'summary'")
          .bind(reading.generationId).first<{ n: number }>())!.n, 1);
      }
      assert.ok(total > budget);
    });
  } finally { await inspector.dispose(); await fixture.close(); }
});
