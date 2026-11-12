// Copyright 2026 Guilhem Ribeill
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { extractArxivHtml } from '../src/html-extraction.ts';
import { HTML_EXTRACTOR } from '../src/fulltext-types.ts';
import { executeHostedSummaries } from '../src/hosted/summary-execution.ts';
import { fixtureDigest, startHostedFixture } from '../scripts/hosted-fixtures.ts';
import { easternRunDate, nextWeekdayBoundary, launchDailyGeneration, expireDailyRun, prepareDailyRunStep } from '../src/hosted/daily-runs.ts';
import { HOSTED_BGE_FINGERPRINT, embeddingChunks } from '../src/hosted/bge.ts';
import { embeddingHash, embeddingRequest } from '../src/hosted/embedding-requests.ts';
import { paperEmbeddingInput } from '../src/embeddings.ts';
import { freezeFixtureInputs as freezeGenerationInputs } from '../scripts/hosted-fixtures.ts';
import { failGeneration, publishGeneration, stagePublication } from '../src/hosted/publication.ts';
import { readReading } from '../src/hosted/reading-store.ts';
import { cleanupHostedState } from '../src/hosted/retention.ts';
import { adminRunStatus } from '../src/hosted/run-status.ts';

test('weekday boundary uses Eastern calendar dates and observes both DST transitions', () => {
  assert.equal(easternRunDate(new Date('2026-03-09T03:30:00Z')), '2026-03-08');
  assert.equal(nextWeekdayBoundary('2026-03-06'), '2026-03-09T10:00:00.000Z');
  assert.equal(nextWeekdayBoundary('2026-10-30'), '2026-11-02T11:00:00.000Z');
  assert.equal(nextWeekdayBoundary('2026-11-02'), '2026-11-03T11:00:00.000Z');
  assert.throws(() => nextWeekdayBoundary('2026-02-30'), /Invalid/);
});

test('minimal local Workflow: daily admission, replay, bounded waiting, fencing, and durable admin status', { timeout: 180000 }, async t => {
  const fixture = await startHostedFixture('scripts/hosted-workflow-fixture.ts', 'FixtureGenerationWorkflow');
  const { db, worker, owner, friend, access, origin } = fixture;
  const binding = (await worker.getEnv()).GENERATION;
  await db.batch([
    db.prepare(`CREATE TABLE fixture_calls (generation_id TEXT, kind TEXT, request_key TEXT, calls INTEGER,
      PRIMARY KEY (generation_id, kind, request_key))`),
    db.prepare('CREATE TABLE fixture_faults (generation_id TEXT PRIMARY KEY, consumed INTEGER NOT NULL DEFAULT 0, after_publish INTEGER NOT NULL DEFAULT 0)'),
  ]);
  const inspector = await worker.introspectWorkflow('GENERATION');
  await inspector.modifyAll(async control => { await control.disableSleeps(); await control.disableRetryDelays(); });
  const batches = (label: string, date: string) => [{ category: 'quant-ph', date, sourceUrl: 'fixture', papers: fixtureDigest(label).papers }];
  const now = (day: number) => new Date(`2099-01-${String(day).padStart(2, '0')}T12:00:00Z`);
  const status = async (userId = owner.id) => db.prepare('SELECT * FROM generation_runs WHERE user_id = ?').bind(userId)
    .first<{ generation_id: string | null; run_date: string; deadline: string; finished_at: string | null; failure_reason: string | null; last_success_at: string | null }>();
  const done = async (id: string) => {
    const instance = await worker.introspectWorkflowInstance('GENERATION', id);
    try { await instance.waitForStatus('complete'); return await instance.getOutput(); }
    finally { await instance.dispose(); }
  };
  const count = async (id: string, kind: string) => (await db.prepare('SELECT coalesce(sum(calls), 0) AS n FROM fixture_calls WHERE generation_id = ? AND kind = ?')
    .bind(id, kind).first<{ n: number }>())!.n;
  const launch = (day: number, label: string, options: { fault?: boolean; finalFault?: boolean; loseLaunch?: boolean; announcement?: string } = {}) =>
    launchDailyGeneration(db, { create: async input => {
      if (options.loseLaunch) throw new Error('SECRET launch diagnostics');
      if (options.fault) await db.prepare('INSERT INTO fixture_faults (generation_id, after_publish) VALUES (?, ?)').bind(input!.id!, Number(options.finalFault ?? false)).run();
      if (options.fault && !options.finalFault) {
        // Arrives after capture: maintenance must wait until publication, not
        // run again on each embedding/summary continuation or step replay.
        const paper = { ...fixtureDigest('Expired sentinel').papers[0], id: '9901.99999' };
        await db.prepare('INSERT INTO user_votes VALUES (?, ?, 1, ?, ?)')
          .bind(owner.id, paper.id, JSON.stringify(paper), new Date(Date.now() - 366 * 86400000).toISOString()).run();
      }
      return binding.create(input);
    } }, owner.id, batches(label, options.announcement ?? `2099-01-${String(day).padStart(2, '0')}`), HOSTED_BGE_FINGERPRINT, { summariesRequested: true, now: now(day) });
  const token = await access.token('owner@example.test');
  const admin = async () => (await worker.fetch(origin + '/admin', { headers: { 'Cf-Access-Jwt-Assertion': token } })).text();
  try {
    await t.test('duplicate launches choose one generation; lost step acknowledgement never repeats paid effects', async () => {
      await db.prepare(`CREATE TRIGGER reject_midrun_cleanup BEFORE DELETE ON user_votes
        WHEN OLD.paper_id = '9901.99999' AND EXISTS (SELECT 1 FROM working_generations WHERE user_id = OLD.user_id)
        BEGIN SELECT RAISE(ABORT, 'fixture cleanup during continuation'); END`).run();
      const result = await Promise.all([launch(5, 'Workflow success', { fault: true }), launch(5, 'Workflow success', { fault: true })]);
      const admitted = result.find(r => r.status === 'launched')!;
      assert.ok(admitted && 'generationId' in admitted);
      assert.equal(result.filter(r => r.status === 'not-admitted').length, 1);
      assert.equal(await done(admitted.generationId!), 'published');
      assert.equal(await count(admitted.generationId!, 'embedding'), 15);
      assert.equal(await count(admitted.generationId!, 'summary'), 6);
      assert.equal(await db.prepare("SELECT 1 FROM user_votes WHERE paper_id = '9901.99999'").first(), null);
      await db.prepare('DROP TRIGGER reject_midrun_cleanup').run();
      assert.equal(await db.prepare("SELECT 1 FROM fixture_calls WHERE kind != 'step' AND calls != 1").first(), null);
      assert.equal((await readReading(db, owner.id))!.generationId, admitted.generationId);
      const recorded = (await status())!;
      assert.ok(recorded.last_success_at && recorded.finished_at); assert.equal(recorded.failure_reason, null);
      assert.match(await admin(), /Last successful run:/);
      assert.match(await admin(), /completed successfully/);
      assert.equal(await adminRunStatus(db, friend.id), '');
      assert.equal((await launch(5, 'Different redelivery')).status, 'not-admitted');
      // A repeated publication call cannot renew the displayed success time.
      await publishGeneration(db, owner.id, admitted.generationId!);
      assert.equal((await status())!.last_success_at, recorded.last_success_at);
    });

    await t.test('unchanged batches consume the daily check without launch or a false success time', async () => {
      const previous = (await status())!;
      const check = await launch(6, 'Workflow success', { announcement: '2099-01-05' });
      assert.equal(check.status, 'unchanged');
      assert.equal((await status())!.last_success_at, previous.last_success_at);
      assert.match(await admin(), /found no new posting batch/);
      assert.equal((await launch(6, 'Changed later that day')).status, 'not-admitted');
    });

    await t.test('known launch failure stays pending and visible; duplicate delivery never relaunches it', async () => {
      const previous = await readReading(db, owner.id), success = (await status())!.last_success_at;
      const lost = await launch(7, 'Lost launch', { loseLaunch: true });
      assert.equal(lost.status, 'launch-failed'); assert.ok('generationId' in lost);
      const row = (await status())!;
      assert.equal(row.finished_at, null); assert.equal(row.failure_reason, 'launch');
      assert.equal(row.last_success_at, success);
      assert.equal((await launch(7, 'Lost launch')).status, 'not-admitted');
      assert.equal(await prepareDailyRunStep(db, { userId: owner.id, generationId: lost.generationId! }), false);
      assert.match(await admin(), /Workflow launch failed or could not be confirmed/);
      assert.match(await admin(), /remains pending/); assert.doesNotMatch(await admin(), /SECRET/);
      assert.deepEqual(await readReading(db, owner.id), previous);
      // Boundary lifecycle is trusted system work, including disabled owners.
      await db.prepare('UPDATE users SET enabled = 0 WHERE id = ?').bind(owner.id).run();
      assert.equal(await failGeneration(db, owner.id, lost.generationId!), false);
      assert.equal((await status())!.finished_at, null);
      await db.prepare(`CREATE TRIGGER reject_boundary_failure BEFORE UPDATE OF finished_at ON generation_runs
        WHEN NEW.failure_reason = 'deadline' BEGIN SELECT RAISE(ABORT, 'fixture boundary rollback'); END`).run();
      await assert.rejects(expireDailyRun(db, owner.id, new Date(row.deadline)), /fixture boundary rollback/);
      assert.equal((await db.prepare('SELECT state FROM generation_inputs WHERE id = ?').bind(lost.generationId!)
        .first<{ state: string }>())!.state, 'working');
      assert.ok(await db.prepare('SELECT 1 FROM working_generations WHERE generation_id = ?').bind(lost.generationId!).first());
      assert.equal((await status())!.finished_at, null);
      await db.prepare('DROP TRIGGER reject_boundary_failure').run();
      await expireDailyRun(db, owner.id, new Date(row.deadline));
      assert.equal((await status())!.failure_reason, 'deadline'); assert.ok((await status())!.finished_at);
      assert.equal(await db.prepare('SELECT 1 FROM working_generations WHERE user_id = ?').bind(owner.id).first(), null);
      await db.prepare('UPDATE users SET enabled = 1 WHERE id = ?').bind(owner.id).run();
      await cleanupHostedState(db);
      assert.equal((await status())!.last_success_at, success);
      assert.match(await admin(), /encountered a failure/);
      assert.deepEqual(await readReading(db, owner.id), previous);
    });

    await t.test('an interrupted admission without a snapshot cannot be relaunched after cleanup', async () => {
      // Process loss after the durable daily check, before snapshot capture/launch.
      const id = crypto.randomUUID();
      await db.prepare(`UPDATE generation_runs SET run_date = '2099-01-10', generation_id = ?, deadline = ?,
        finished_at = NULL, failure_reason = NULL WHERE user_id = ?`).bind(id, nextWeekdayBoundary('2099-01-10'), owner.id).run();
      await cleanupHostedState(db);
      assert.equal((await launch(10, 'Interrupted admission')).status, 'not-admitted');
      assert.match(await admin(), /pending or in progress/);
      await expireDailyRun(db, owner.id, new Date(nextWeekdayBoundary('2099-01-10')));
      assert.equal((await status())!.failure_reason, 'deadline');
    });

    await t.test('real shared claims cause three bounded waits, then fail only the waiting generation', async () => {
      const batch = batches('Shared waiting', '2099-01-13');
      const other = (await freezeGenerationInputs(db, friend.id, batch, HOSTED_BGE_FINGERPRINT))!;
      const texts = embeddingChunks(paperEmbeddingInput(batch[0].papers[0]));
      const key = await embeddingHash([HOSTED_BGE_FINGERPRINT, ['paper'], texts]);
      await db.prepare("INSERT INTO embedding_requests (generation_id, request_key, state) VALUES (?, ?, 'claimed')").bind(other.id, key).run();
      const before = await readReading(db, owner.id);
      const waiting = await launch(13, 'Shared waiting');
      assert.equal(waiting.status, 'launched'); assert.ok('generationId' in waiting);
      assert.equal(await done(waiting.generationId!), 'failed');
      assert.equal(await count(waiting.generationId!, 'step'), 4);
      assert.equal((await status())!.failure_reason, 'waiting');
      assert.equal(await count(waiting.generationId!, 'embedding'), 0); // Own profiles reused, first scientific input still owned elsewhere.
      assert.equal((await db.prepare('SELECT state FROM embedding_requests WHERE generation_id = ? AND request_key = ?')
        .bind(other.id, key).first<{ state: string }>())!.state, 'claimed');
      assert.deepEqual(await readReading(db, owner.id), before);
      await failGeneration(db, friend.id, other.id);
    });

    await t.test('a late callback cannot persist or publish across the boundary, even without a new launch', async () => {
      const lost = await launch(14, 'Late callback', { loseLaunch: true });
      assert.ok('generationId' in lost);
      const id = lost.generationId!;
      // Simulate an unacknowledged launch's callback already running.
      await db.prepare('UPDATE generation_runs SET failure_reason = NULL WHERE generation_id = ?').bind(id).run();
      let calls = 0;
      const before = await readReading(db, owner.id);
      await assert.rejects(embeddingRequest(db, owner.id, id, ['a late fixture response'], false, async () => {
        calls++;
        // Deadline passes during the request. No scheduler callback is needed to fence persistence.
        await db.prepare("UPDATE generation_runs SET deadline = '2000-01-01T00:00:00.000Z' WHERE generation_id = ?").bind(id).run();
        return { shape: [1, 384], data: [[1, ...Array(383).fill(0)]] };
      }, { remaining: 1 }), /no longer active/);
      assert.equal(calls, 1);
      assert.notEqual(await publishGeneration(db, owner.id, id), 'published');
      await expireDailyRun(db, owner.id);
      assert.equal((await status())!.failure_reason, 'deadline');
      assert.equal((await db.prepare('SELECT state FROM embedding_requests WHERE generation_id = ?').bind(id).first<{ state: string }>())!.state, 'claimed');
      assert.equal(await prepareDailyRunStep(db, { userId: owner.id, generationId: id }), false);
      assert.deepEqual(await readReading(db, owner.id), before);
    });

    await t.test('success after failure replaces the message, and lost final acknowledgement preserves success timestamp', async () => {
      const result = await launch(15, 'Workflow success', { fault: true, finalFault: true });
      assert.equal(result.status, 'launched'); assert.ok('generationId' in result);
      assert.equal(await done(result.generationId!), 'published');
      assert.equal(await count(result.generationId!, 'embedding'), 0);
      // A new announcement date may choose different discovery papers.
      assert.ok(await count(result.generationId!, 'summary') <= 3);
      assert.equal(await db.prepare("SELECT 1 FROM fixture_calls WHERE generation_id = ? AND kind != 'step' AND calls != 1")
        .bind(result.generationId!).first(), null);
      assert.equal((await db.prepare('SELECT consumed FROM fixture_faults WHERE generation_id = ?').bind(result.generationId!)
        .first<{ consumed: number }>())!.consumed, 1);
      const success = (await status())!.last_success_at;
      assert.ok(success); assert.match(await admin(), /completed successfully/);
      assert.doesNotMatch(await admin(), /encountered a failure/);
      await cleanupHostedState(db);
      assert.equal((await status())!.last_success_at, success);
      assert.equal((await launch(5, 'Very late duplicate')).status, 'not-admitted');
    });
    await t.test('late delivery keeps its intended date; preparation failure is retained without a launch', async () => {
      let launches = 0;
      const neverLaunch = { create: async () => { launches++; throw new Error('Unexpected launch'); } };
      assert.equal((await launchDailyGeneration(db, neverLaunch, friend.id, batches('Late delivery', '2099-01-05'), HOSTED_BGE_FINGERPRINT,
        { now: now(20), runDate: '2099-01-05' })).status, 'not-admitted');
      assert.equal(await status(friend.id), null);
      const failed = await launchDailyGeneration(db, neverLaunch, friend.id, [], HOSTED_BGE_FINGERPRINT, { now: now(20) });
      assert.equal(failed.status, 'preparation-failed');
      assert.equal((await status(friend.id))!.failure_reason, 'preparation');
      assert.equal((await status(friend.id))!.finished_at, null);
      assert.equal((await launchDailyGeneration(db, neverLaunch, friend.id, batches('Fixed input', '2099-01-20'), HOSTED_BGE_FINGERPRINT,
        { now: now(20) })).status, 'not-admitted');
      assert.equal(launches, 0);
      assert.equal(await adminRunStatus(db, friend.id), '');
      await expireDailyRun(db, friend.id, new Date((await status(friend.id))!.deadline));
    });

    await t.test('deadline checks fence an already-ready publication and an in-flight summary transaction', async () => {
      const before = await readReading(db, owner.id), success = (await status())!.last_success_at;
      for (const summaries of [false, true]) {
        const day = summaries ? 17 : 16;
        const digest = fixtureDigest(summaries ? 'Boundary summary' : 'Boundary publication');
        digest.date = `2099-01-${day}`;
        const launch = await launchDailyGeneration(db, { create: async () => { throw new Error('Fixture unacknowledged launch'); } },
          owner.id, [{ category: 'quant-ph', date: digest.date, sourceUrl: 'fixture', papers: digest.papers }], 'fixture-only',
          { summariesRequested: summaries, now: now(day) });
        assert.ok('generationId' in launch);
        const id = launch.generationId!;
        await db.prepare('UPDATE generation_runs SET failure_reason = NULL WHERE generation_id = ?').bind(id).run();
        const expireClock = () => db.prepare("UPDATE generation_runs SET deadline = '2000-01-01T00:00:00.000Z' WHERE generation_id = ?").bind(id).run();
        if (!summaries) {
          assert.equal(await stagePublication(db, owner.id, id, digest), 'ready');
          await expireClock();
          assert.equal(await publishGeneration(db, owner.id, id), 'not-ready');
        } else {
          const html = readFileSync(new URL('fixtures/paper-unsectioned.html', import.meta.url), 'utf8');
          let calls = 0;
          await assert.rejects(executeHostedSummaries(db, owner.id, id, digest, {
            loadSource: async p => ({ html, result: { paperId: p.id, version: p.version, status: 'available',
              sourceUrl: 'https://arxiv.org/html/fixture', checkedAt: new Date().toISOString(), extractor: HTML_EXTRACTOR, text: extractArxivHtml(html) } }),
            createProvider: () => ({ summarize: async () => {
              calls++; await expireClock(); return { summary: 'Recorded late summary. No live service was called.' };
            } }),
          }), /could not be persisted/);
          assert.equal(calls, 1);
          const row = (await db.prepare('SELECT state, charged_input, outcome_json FROM summary_outcomes WHERE generation_id = ? ORDER BY ordinal LIMIT 1')
            .bind(id).first<{ state: string; charged_input: number; outcome_json: string }>())!;
          assert.equal(row.state, 'claimed'); assert.ok(row.charged_input > 0);
          assert.equal(await db.prepare('SELECT 1 FROM summary_cache WHERE cache_key = ?').bind(JSON.parse(row.outcome_json).cacheKey).first(), null);
        }
        await expireDailyRun(db, owner.id);
        assert.deepEqual(await readReading(db, owner.id), before);
        assert.equal((await status())!.last_success_at, success);
        assert.equal((await status())!.failure_reason, 'deadline');
      }
    });
    await t.test('admission pins the next batch before cleanup prunes reusable scientific work', async () => {
      const paper = { ...fixtureDigest('Novel cached paper').papers[0], id: '9901.00001' };
      const batch = [{ category: 'quant-ph', date: '2099-01-21', sourceUrl: 'fixture', papers: [paper] }];
      const previous = await freezeGenerationInputs(db, friend.id, batch, HOSTED_BGE_FINGERPRINT);
      await db.prepare('INSERT INTO paper_vectors (paper_id, version, model_identity, input_hash, vector_json) VALUES (?, ?, ?, ?, ?)')
        .bind(paper.id, paper.version, HOSTED_BGE_FINGERPRINT, await embeddingHash(paperEmbeddingInput(paper)), JSON.stringify([1, ...Array(383).fill(0)])).run();
      await failGeneration(db, friend.id, previous.id);
      // No current publication or vote refers to this paper. Before the new
      // snapshot pins it, a global sweep would discard its reusable vector.
      const next = await launchDailyGeneration(db, binding, owner.id, batch, HOSTED_BGE_FINGERPRINT, { now: now(21) });
      assert.equal(next.status, 'launched'); assert.ok('generationId' in next);
      assert.equal(await done(next.generationId!), 'published');
      assert.equal(await count(next.generationId!, 'embedding'), 0);
      assert.equal(await count(next.generationId!, 'summary'), 0);
    });
  } finally { await inspector.dispose(); await fixture.close(); }
});
