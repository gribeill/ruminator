// Copyright 2026 Guilhem Ribeill
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseHTML } from 'linkedom';
import { fixtureDigest, startHostedFixture } from '../scripts/hosted-fixtures.ts';
import { launchDailyGeneration, expireDailyRun } from '../src/hosted/daily-runs.ts';
import { HOSTED_BGE_FINGERPRINT } from '../src/hosted/bge.ts';
import { readGenerationInputs } from '../src/hosted/generation-inputs.ts';
import { readReading, saveUserVote } from '../src/hosted/reading-store.ts';
import { readSavedInterests, readSavedConfig, saveInterests, saveConfig } from '../src/hosted/saved-inputs.ts';
import { freezeFixtureInputs } from '../scripts/hosted-fixtures.ts';
import { failGeneration } from '../src/hosted/publication.ts';
import { cleanupHostedState } from '../src/hosted/retention.ts';

test('admin controls: explicit cost consent, own scope, immutable summary replacement and replay-safe admission', { timeout: 180000 }, async t => {
  const fixture = await startHostedFixture('scripts/hosted-workflow-fixture.ts', 'FixtureGenerationWorkflow');
  const { db, worker, owner, friend, access, origin } = fixture;
  const binding = (await worker.getEnv()).GENERATION;
  const inspector = await worker.introspectWorkflow('GENERATION');
  await inspector.modifyAll(async c => { await c.disableSleeps(); await c.disableRetryDelays(); });
  await db.batch([
    db.prepare('CREATE TABLE fixture_calls (generation_id TEXT, kind TEXT, request_key TEXT, calls INTEGER, PRIMARY KEY(generation_id,kind,request_key))'),
    db.prepare('CREATE TABLE fixture_faults (generation_id TEXT PRIMARY KEY, consumed INTEGER DEFAULT 0, after_publish INTEGER DEFAULT 0)'),
  ]);
  const admin = await access.token('owner@example.test'), regular = await access.token('friend@example.test');
  const request = (path: string, body?: URLSearchParams, token = admin, extra: Record<string, string> = {}) => worker.fetch(origin + path, {
    method: body ? 'POST' : 'GET', redirect: 'manual', headers: { 'Cf-Access-Jwt-Assertion': token,
      ...(body ? { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' } : {}), ...extra },
    ...(body ? { body: body.toString() } : {}),
  });
  const form = async (action: string) => {
    const response = await request('/admin');
    assert.equal(response.status, 200); assert.match(response.headers.get('cache-control')!, /private.*no-store/);
    const doc = parseHTML(await response.text()).document;
    const f = doc.querySelector(`form[action="/admin/${action}"]`)!;
    assert.ok(f);
    return new URLSearchParams({ version: f.querySelector('[name="version"]')!.getAttribute('value')!,
      token: f.querySelector('[name="token"]')!.getAttribute('value')!, confirm: 'paid' });
  };
  const run = async (userId = owner.id) => (await db.prepare('SELECT * FROM generation_runs WHERE user_id = ?').bind(userId)
    .first<{ generation_id: string; finished_at: string | null; failure_reason: string | null; deadline: string; last_success_at: string }>())!;
  const done = async (id: string) => {
    const i = await worker.introspectWorkflowInstance('GENERATION', id);
    try { await i.waitForStatus('complete'); return await i.getOutput(); } finally { await i.dispose(); }
  };
  const calls = async (id: string, kind: string) => (await db.prepare('SELECT coalesce(sum(calls),0) AS n FROM fixture_calls WHERE generation_id = ? AND kind = ?')
    .bind(id, kind).first<{ n: number }>())!.n;
  try {
    const digest = fixtureDigest('Control source');
    const batch = [{ category: 'quant-ph', date: digest.date, sourceUrl: 'recorded-only', papers: digest.papers }];
    for (const user of [owner, friend]) {
      const launch = await launchDailyGeneration(db, binding, user.id, batch, HOSTED_BGE_FINGERPRINT, { summariesRequested: true });
      assert.equal(launch.status, 'launched'); assert.ok('generationId' in launch);
      assert.equal(await done(launch.generationId!), 'published');
    }
    const friendBefore = await readReading(db, friend.id);
    const friendRun = await run(friend.id);
    const friendOutcomes = (await db.prepare('SELECT * FROM summary_outcomes WHERE generation_id = ? ORDER BY ordinal').bind(friendRun.generation_id).all()).results;
    const original = (await readReading(db, owner.id))!;
    const originalInputs = (await readGenerationInputs(db, owner.id, original.generationId))!;

    await t.test('GET/save never execute; confirmation, session, action, origin and role are checked', async () => {
      const f = await form('rebuild');
      assert.equal((await request('/admin/rebuild')).status, 404);
      const unconfirmed = new URLSearchParams(f); unconfirmed.delete('confirm');
      assert.equal((await request('/admin/rebuild', unconfirmed)).status, 400);
      assert.equal((await request('/admin/rebuild', f, regular)).status, 403);
      assert.equal((await request('/admin/summaries', f)).status, 403);
      assert.equal((await request('/admin/rebuild', f, await access.token('owner@example.test', { jti: 'other-session' }))).status, 403);
      assert.equal((await request('/admin/rebuild', f, admin, { Origin: 'https://wrong.test' })).status, 403);
      assert.equal((await request('/admin/rebuild', f, admin, { 'Content-Type': 'application/json' })).status, 415);
      const extra = new URLSearchParams(f); extra.append('user_id', friend.id);
      assert.equal((await request('/admin/rebuild', extra)).status, 400);
      const duplicate = new URLSearchParams(f); duplicate.append('confirm', 'paid');
      assert.equal((await request('/admin/rebuild', duplicate)).status, 400);
      const interests = (await readSavedInterests(db, owner.id))!;
      const config = (await readSavedConfig(db, owner.id))!;
      assert.equal((await saveInterests(db, owner.id, interests.revision, interests.text + '\n<!-- next rebuild only -->')).status, 'saved');
      assert.equal((await saveConfig(db, owner.id, config.revision, config.text.replace('semantic = 0.60', 'semantic = 0.50').replace('keywords = 0.25', 'keywords = 0.35'))).status, 'saved');
      assert.equal((await request('/admin/rebuild', f)).status, 409);
      assert.deepEqual(await readReading(db, owner.id), original);
      assert.equal((await run()).generation_id, original.generationId);
      await saveUserVote(db, owner.id, original.generationId, original.digest.papers[0].id, 1);
    });

    await t.test('bulk regeneration bypasses six cache hits without changing ranking, other users or shared content', async () => {
      const cache = (await db.prepare('SELECT * FROM summary_cache ORDER BY cache_key').all()).results;
      const profiles = (await db.prepare('SELECT profile_id,input_hash,vector_json FROM generation_profile_vectors WHERE generation_id = ? ORDER BY profile_id')
        .bind(original.generationId).all()).results;
      const f = await form('summaries');
      await db.prepare(`CREATE TRIGGER lose_control_ack AFTER INSERT ON generation_inputs WHEN NEW.action = 'summaries'
        BEGIN INSERT INTO fixture_faults (generation_id) VALUES (NEW.id); END`).run();
      const responses = await Promise.all([request('/admin/summaries', f), request('/admin/summaries', f)]);
      assert.deepEqual(responses.map(r => r.status).sort(), [303, 409]);
      await db.prepare('DROP TRIGGER lose_control_ack').run();
      const id = (await run()).generation_id;
      assert.equal(await done(id), 'published');
      assert.equal(await calls(id, 'embedding'), 0);
      assert.equal(await calls(id, 'summary'), 6);
      assert.equal((await db.prepare('SELECT consumed FROM fixture_faults WHERE generation_id = ?').bind(id).first<{ consumed: number }>())!.consumed, 1);
      assert.equal(await db.prepare("SELECT 1 FROM fixture_calls WHERE generation_id = ? AND kind != 'step' AND calls != 1").bind(id).first(), null);
      const current = (await readReading(db, owner.id))!;
      assert.deepEqual(current.digest.ranking, original.digest.ranking);
      assert.deepEqual(current.digest.semantic, original.digest.semantic);
      assert.deepEqual(current.digest.papers, original.digest.papers);
      for (const p of current.digest.ranking!.featured) {
        assert.notEqual(current.digest.summaries![p.id].summary, original.digest.summaries![p.id].summary);
      }
      const inputs = (await readGenerationInputs(db, owner.id, id))!;
      assert.deepEqual(inputs.config, originalInputs.config);
      assert.equal(inputs.summaryConfig!.revision, 2);
      assert.match(await (await request('/admin')).text(), /ranking uses revision 1; summaries use revision 2/);
      assert.deepEqual(inputs.interests, originalInputs.interests);
      assert.deepEqual((await db.prepare('SELECT profile_id,input_hash,vector_json FROM generation_profile_vectors WHERE generation_id = ? ORDER BY profile_id').bind(id).all()).results, profiles);
      assert.deepEqual(inputs.votes, originalInputs.votes);
      assert.deepEqual((await db.prepare('SELECT * FROM summary_cache ORDER BY cache_key').all()).results, cache);
      assert.deepEqual(await readReading(db, friend.id), friendBefore);
      assert.deepEqual(await run(friend.id), friendRun);
      assert.deepEqual((await db.prepare('SELECT * FROM summary_outcomes WHERE generation_id = ? ORDER BY ordinal').bind(friendRun.generation_id).all()).results, friendOutcomes);
      assert.equal((await request('/admin/summaries', f)).status, 409);
    });

    await t.test('rebuild freezes latest saved inputs and votes, with normal compatible summary reuse', async () => {
      const f = await form('rebuild');
      assert.equal((await request('/admin/rebuild', f)).status, 303);
      const id = (await run()).generation_id;
      assert.equal(await done(id), 'published');
      const inputs = (await readGenerationInputs(db, owner.id, id))!;
      assert.equal(inputs.action, 'rebuild'); assert.equal(inputs.interests.revision, 2); assert.equal(inputs.config.revision, 2);
      assert.equal(inputs.votes.length, 1);
      const current = (await readReading(db, owner.id))!;
      assert.equal(current.digest.ranking!.config.weights.semantic, 0.5);
      assert.equal(current.digest.date, original.digest.date);
      assert.ok(await calls(id, 'summary') <= 3);
      assert.equal(await calls(id, 'embedding'), 0);
      assert.equal(await db.prepare("SELECT 1 FROM fixture_calls WHERE generation_id = ? AND kind != 'step' AND calls != 1").bind(id).first(), null);
      assert.deepEqual(await readReading(db, friend.id), friendBefore);
    });

    await t.test('summary-only replacement preserves feedback provenance and cannot change ranking', async () => {
      const before = (await readReading(db, owner.id))!;
      const examples = (await db.prepare('SELECT paper_id,event_id,vector_json FROM generation_feedback_examples WHERE generation_id = ? ORDER BY paper_id')
        .bind(before.generationId).all()).results;
      assert.ok(examples.length);
      assert.equal((await request('/admin/summaries', await form('summaries'))).status, 303);
      const id = (await run()).generation_id;
      assert.equal(await done(id), 'published');
      assert.equal(await calls(id, 'summary'), 6); assert.equal(await calls(id, 'embedding'), 0);
      assert.deepEqual((await readReading(db, owner.id))!.digest.ranking, before.digest.ranking);
      assert.deepEqual((await db.prepare('SELECT paper_id,event_id,vector_json FROM generation_feedback_examples WHERE generation_id = ? ORDER BY paper_id').bind(id).all()).results, examples);
    });

    await t.test('capture failure stays pending, rejects all controls, and preserves the last publication', async () => {
      const before = await readReading(db, owner.id), f = await form('rebuild'), other = await form('summaries');
      const success = (await run()).last_success_at;
      await db.prepare(`CREATE TRIGGER reject_admin_capture BEFORE INSERT ON generation_inputs WHEN NEW.action = 'rebuild'
        BEGIN SELECT RAISE(ABORT, 'SECRET fixture capture failure'); END`).run();
      const response = await request('/admin/rebuild', f);
      assert.equal(response.status, 503); assert.doesNotMatch(await response.text(), /SECRET/);
      await db.prepare('DROP TRIGGER reject_admin_capture').run();
      const pending = await run();
      assert.equal(pending.failure_reason, 'preparation'); assert.equal(pending.finished_at, null);
      assert.equal(pending.last_success_at, success);
      assert.equal((await request('/admin/rebuild', f)).status, 409);
      assert.equal((await request('/admin/summaries', other)).status, 409);
      assert.match(await (await request('/admin')).text(), /previous work is unfinished/);
      await cleanupHostedState(db);
      assert.deepEqual(await readReading(db, owner.id), before);
      assert.equal((await run()).generation_id, pending.generation_id);
      await expireDailyRun(db, owner.id, new Date(pending.deadline));
      assert.equal((await request('/admin/rebuild', f)).status, 409); // Consumed even after failure/cleanup.
      assert.deepEqual(await readReading(db, friend.id), friendBefore);
    });

    await t.test('generation failure leaves publication intact; a fresh confirmed form can explicitly restart', async () => {
      const before = await readReading(db, owner.id), f = await form('rebuild');
      await db.prepare(`CREATE TRIGGER reject_admin_summary BEFORE INSERT ON summary_outcomes
        WHEN (SELECT action FROM generation_inputs WHERE id = NEW.generation_id) = 'rebuild'
        BEGIN SELECT RAISE(ABORT, 'fixture generation failure'); END`).run();
      assert.equal((await request('/admin/rebuild', f)).status, 303);
      const failed = (await run()).generation_id;
      assert.equal(await done(failed), 'failed');
      await db.prepare('DROP TRIGGER reject_admin_summary').run();
      assert.deepEqual(await readReading(db, owner.id), before);
      assert.equal((await request('/admin/rebuild', f)).status, 409);
      assert.equal((await request('/admin/rebuild', await form('rebuild'))).status, 303);
      assert.equal(await done((await run()).generation_id), 'published');
      assert.deepEqual(await readReading(db, friend.id), friendBefore);
    });
    await t.test('forced summaries respect another user’s active claim rather than clearing or taking it over', async () => {
      const before = (await readReading(db, owner.id))!;
      const paper = before.digest.ranking!.featured[0];
      const key = (await db.prepare("SELECT json_extract(outcome_json, '$.cacheKey') AS key FROM summary_outcomes WHERE generation_id = ? AND paper_id = ?")
        .bind(before.generationId, paper.id).first<{ key: string }>())!.key;
      const peer = await freezeFixtureInputs(db, friend.id, [{ ...batch[0], date: '2099-01-01' }], HOSTED_BGE_FINGERPRINT, true);
      const version = before.digest.papers.find(p => p.id === paper.id)!.version;
      await db.prepare(`INSERT INTO summary_outcomes (generation_id,paper_id,version,ordinal,state,cache_key,charged_input,outcome_json)
        VALUES (?,?,?,0,'claimed',?,100,'{}')`).bind(peer.id, paper.id, version, key).run();
      const claim = await db.prepare('SELECT * FROM summary_outcomes WHERE generation_id = ?').bind(peer.id).first();
      assert.equal((await request('/admin/summaries', await form('summaries'))).status, 303);
      const id = (await run()).generation_id;
      assert.equal(await done(id), 'failed');
      assert.equal((await run()).failure_reason, 'waiting'); assert.equal(await calls(id, 'summary'), 0);
      assert.deepEqual(await db.prepare('SELECT * FROM summary_outcomes WHERE generation_id = ?').bind(peer.id).first(), claim);
      assert.ok(await db.prepare('SELECT 1 FROM working_generations WHERE generation_id = ?').bind(peer.id).first());
      assert.deepEqual(await readReading(db, owner.id), before);
      await failGeneration(db, friend.id, peer.id);
    });

    await t.test('latest saved summary limits are frozen and conserved even when every cache hit is bypassed', async () => {
      const config = (await readSavedConfig(db, owner.id))!;
      assert.equal((await saveConfig(db, owner.id, config.revision, config.text.replace('run_input_tokens = 500000', 'run_input_tokens = 1'))).status, 'saved');
      const before = (await readReading(db, owner.id))!;
      assert.equal((await request('/admin/summaries', await form('summaries'))).status, 303);
      const id = (await run()).generation_id;
      // Saving after admission cannot lift the frozen ceiling.
      const limited = (await readSavedConfig(db, owner.id))!;
      await saveConfig(db, owner.id, limited.revision, config.text);
      assert.equal(await done(id), 'published');
      assert.equal(await calls(id, 'summary'), 0);
      assert.equal((await db.prepare('SELECT sum(charged_input) AS spent FROM summary_outcomes WHERE generation_id = ?').bind(id)
        .first<{ spent: number }>())!.spent, 0);
      const current = (await readReading(db, owner.id))!;
      assert.deepEqual(current.digest.ranking, before.digest.ranking);
      assert.equal(Object.values(current.digest.summaries!).filter(s => s.status === 'token_budget').length, 6);
      assert.deepEqual(await readReading(db, friend.id), friendBefore);
    });
    await t.test('summary-only updates use the latest saved model without reinterpreting ranking settings', async () => {
      const config = (await readSavedConfig(db, owner.id))!;
      assert.equal((await saveConfig(db, owner.id, config.revision, config.text.replace('openai/gpt-6-luna', 'fixture/new-model'))).status, 'saved');
      const before = (await readReading(db, owner.id))!;
      assert.equal((await request('/admin/summaries', await form('summaries'))).status, 303);
      const id = (await run()).generation_id;
      assert.equal(await done(id), 'published');
      assert.equal(await calls(id, 'summary'), 6); assert.equal(await calls(id, 'embedding'), 0);
      const current = (await readReading(db, owner.id))!;
      assert.deepEqual(current.digest.ranking, before.digest.ranking);
      assert.ok(Object.values(current.digest.summaries!).every(s => s.provenance?.model === 'fixture/new-model' && s.provenance.actualModel === 'fixture/new-model'));
      assert.deepEqual(await readReading(db, friend.id), friendBefore);
    });

    await t.test('role revocation after admission fences paid work and publication', async () => {
      const before = await readReading(db, owner.id), f = await form('summaries');
      await db.prepare(`CREATE TRIGGER revoke_admin AFTER INSERT ON generation_inputs WHEN NEW.action = 'summaries'
        BEGIN UPDATE users SET role = 'user' WHERE id = NEW.user_id; END`).run();
      assert.equal((await request('/admin/summaries', f)).status, 303);
      const id = (await run()).generation_id;
      assert.equal(await done(id), 'failed');
      assert.equal(await calls(id, 'summary'), 0); assert.equal(await calls(id, 'embedding'), 0);
      assert.deepEqual(await readReading(db, owner.id), before);
      assert.equal((await request('/admin/summaries', f)).status, 403);
      await db.prepare('DROP TRIGGER revoke_admin').run();
      await db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").bind(owner.id).run();
      await db.prepare('UPDATE users SET enabled = 0 WHERE id = ?').bind(owner.id).run();
      assert.equal((await request('/admin/summaries', f)).status, 403);
      await db.prepare('UPDATE users SET enabled = 1 WHERE id = ?').bind(owner.id).run();
    });
    await t.test('a consumed confirmation cannot revive when a later no-op clears the latest generation ID', async () => {
      const firstDate = new Date(Date.now() + 3 * 86400000), nextDate = new Date(Date.now() + 4 * 86400000);
      assert.equal((await launchDailyGeneration(db, binding, owner.id, batch, HOSTED_BGE_FINGERPRINT, { now: firstDate })).status, 'unchanged');
      const f = await form('rebuild');
      await db.prepare(`CREATE TRIGGER reject_replay_capture BEFORE INSERT ON generation_inputs WHEN NEW.action = 'rebuild'
        BEGIN SELECT RAISE(ABORT, 'fixture no-op replay'); END`).run();
      assert.equal((await request('/admin/rebuild', f)).status, 503);
      await db.prepare('DROP TRIGGER reject_replay_capture').run();
      await expireDailyRun(db, owner.id, new Date((await run()).deadline));
      assert.equal((await launchDailyGeneration(db, binding, owner.id, batch, HOSTED_BGE_FINGERPRINT, { now: nextDate })).status, 'unchanged');
      assert.equal((await request('/admin/rebuild', f)).status, 409);
    });
  } finally { await inspector.dispose(); await fixture.close(); }
});
