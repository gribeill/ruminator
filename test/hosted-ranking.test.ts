// Copyright 2026 Guilhem Ribeill
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import { HOSTED_BGE_FINGERPRINT, TOKENIZER_HASHES, embeddingChunks, embeddingTokenCount, embeddingResponse, workersAiEmbeddings } from '../src/hosted/bge.ts';
import { embeddingRequest, EmbeddingPause } from '../src/hosted/embedding-requests.ts';
import { runHostedRanking } from '../src/hosted/ranking-runner.ts';
import { fixtureDigest, startHostedFixture } from '../scripts/hosted-fixtures.ts';
import { freezeGenerationInputs as admitGenerationInputs, readGenerationInputs } from '../src/hosted/generation-inputs.ts';
import { freezeFixtureInputs as freezeGenerationInputs } from '../scripts/hosted-fixtures.ts';
import { failGeneration } from '../src/hosted/publication.ts';
import { readReading, saveUserVote } from '../src/hosted/reading-store.ts';
import { saveConfig, saveInterests } from '../src/hosted/saved-inputs.ts';
import { BGE_FINGERPRINT } from '../src/bge.ts';
import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';

const response = (count: number) => ({ shape: [count, 384], pooling: 'cls', data: Array.from({ length: count }, () => [2, ...Array(383).fill(0)]) });

test('packaged tokenizer hashes, token bounds, CLS validation, and a single-attempt HTTP adapter', async () => {
  for (const [name, hash] of Object.entries(TOKENIZER_HASHES)) {
    assert.equal(createHash('sha256').update(readFileSync(new URL(`../src/hosted/assets/bge/${name}`, import.meta.url))).digest('hex'), hash);
  }
  assert.notEqual(HOSTED_BGE_FINGERPRINT, BGE_FINGERPRINT);
  assert.equal(embeddingTokenCount('Hello world'), 4);
  const chunks = embeddingChunks({ kind: 'paper', title: 'Quantum experiment', text: 'The experiment measured correlations. '.repeat(600) });
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every(t => embeddingTokenCount(t) <= 512 && t.startsWith('Quantum experiment\n\n')));
  assert.equal(chunks.join(' ').match(/measured correlations/g)!.length, 600);
  assert.match(embeddingChunks({ kind: 'profile', title: 'Hardware', text: 'quantum gates' })[0], /^Represent this sentence for searching relevant passages:/);
  assert.throws(() => embeddingChunks({ kind: 'paper', title: 'experiment '.repeat(600), text: 'body' }), /token budget/);
  for (const bad of [{ ...response(1), pooling: 'mean' }, response(2), { shape: [1, 384], data: [[NaN, ...Array(383).fill(0)]] },
    { shape: [1, 384], data: [Array(384).fill(0)] }]) assert.throws(() => embeddingResponse(bad, 1));
  assert.equal(embeddingResponse(response(1), 1)[0][0], 1);

  let calls = 0, mode = 'success';
  const server = createServer(async (req, res) => {
    calls++;
    let raw = ''; for await (const part of req) raw += part;
    assert.deepEqual(JSON.parse(raw), { text: ['Hello world'], pooling: 'cls' });
    assert.equal(req.headers.authorization, 'Bearer fixture-token');
    if (mode === 'http') { res.writeHead(503).end('provider-secret-must-not-escape'); return; }
    res.setHeader('Content-Type', 'application/json');
    res.end(mode === 'large' ? 'x'.repeat(1024 * 1024 + 1) : JSON.stringify({ success: true, result: response(1) }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const transport = workersAiEmbeddings('a'.repeat(32), 'fixture-token', async (url, init) => {
      assert.match(String(url), /\/ai\/run\/@cf\/baai\/bge-small-en-v1\.5$/);
      assert.equal(init!.redirect, 'error'); assert.ok(init!.signal);
      return fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, init);
    });
    assert.deepEqual(await transport(['Hello world']), response(1));
    for (mode of ['http', 'large']) await assert.rejects(transport(['Hello world']), /^Error: Workers AI embedding request failed; do not retry this attempt$/);
    assert.equal(calls, 3);
    await assert.rejects(transport(Array(9).fill('Hello world')), /batch\/token/);
    await assert.rejects(transport(['x'.repeat(1024 * 1024)]), /byte limits/);
    assert.equal(calls, 3);
  } finally { server.close(); await once(server, 'close'); }
});

test('hosted ranking in workerd: frozen inputs, resumable effects, sharing, failure fencing, and publication', { timeout: 180000 }, async t => {
  const fixture = await startHostedFixture('scripts/hosted-ranking-fixture.ts');
  const { db, worker, origin, owner, friend } = fixture;
  const digest = fixtureDigest('Hosted ranking');
  const batch = { category: 'quant-ph', date: digest.date, sourceUrl: 'fixture', papers: digest.papers };
  const invoke = async (userId: string, generationId: string, maxRequests = 8, fail = false) => {
    const r = await worker.fetch(origin + '/__fixture/rank', { method: 'POST', body: JSON.stringify({ userId, generationId, maxRequests, fail }) });
    assert.equal(r.status, 200, await r.clone().text());
    return await r.json() as { status: string; calls: number; tokenizerCheck: number[] };
  };
  const finish = async (userId: string, generationId: string) => {
    let calls = 0;
    for (let i = 0; i < 30; i++) {
      const result = await invoke(userId, generationId, 2); calls += result.calls;
      assert.ok(result.calls <= 2);
      if (result.status === 'published') return calls;
      assert.equal(result.status, 'paused');
    }
    throw new Error('Fixture generation did not finish');
  };
  try {
    const original = (await readReading(db, friend.id))!;
    await saveUserVote(db, friend.id, original.generationId, digest.papers[0].id, 1);
    const a = (await freezeGenerationInputs(db, friend.id, [batch], HOSTED_BGE_FINGERPRINT))!;
    await t.test('bounded invocations preserve old reading and resume from completed vectors/requests', async () => {
      const first = await invoke(friend.id, a.id, 2);
      assert.equal(first.status, 'paused'); assert.equal(first.calls, 2);
      assert.ok(first.tokenizerCheck.length > 1 && first.tokenizerCheck.every(n => n <= 512));
      assert.deepEqual(await readReading(db, friend.id), original);
      await saveInterests(db, friend.id, a.interests.revision, a.interests.text + '\n<!-- next run only -->');
      await saveConfig(db, owner.id, a.config.revision, a.config.text + '\n# next run only\n');
      const rest = await finish(friend.id, a.id);
      assert.equal(rest + 2, digest.papers.length + 6 + 1); // Nine paper inputs, six private profiles, one frozen vote.
      assert.deepEqual(await readGenerationInputs(db, friend.id, a.id), a);
      const reading = (await readReading(db, friend.id))!;
      assert.equal(reading.generationId, a.id);
      assert.equal(reading.digest.semantic!.fingerprint, HOSTED_BGE_FINGERPRINT);
      const example = await db.prepare('SELECT vector_json FROM generation_feedback_examples WHERE generation_id = ? LIMIT 1')
        .bind(a.id).first<{ vector_json: string }>();
      assert.equal(JSON.parse(example!.vector_json).length, 384);
      assert.equal(reading.digest.ranking!.feedbackSnapshot, undefined);
      assert.equal(reading.digest.papers.length, digest.papers.length);
      assert.equal(Object.keys(reading.digest.summaries ?? {}).length, 0);
      assert.ok(Object.values(reading.digest.ranking!.scores).every(s => s.feedback > 0.5));
      assert.equal((await invoke(friend.id, a.id)).calls, 0);
      assert.deepEqual(await admitGenerationInputs(db, friend.id, [batch], HOSTED_BGE_FINGERPRINT), { status: 'unchanged' });
      assert.equal((await db.prepare('SELECT count(*) AS n FROM source_texts').first<{ n: number }>())!.n, 0);
    });

    await t.test('another user reuses paper vectors but never private profile vectors or feedback', async () => {
      const b = (await freezeGenerationInputs(db, owner.id, [batch], HOSTED_BGE_FINGERPRINT))!;
      assert.equal(await finish(owner.id, b.id), 6);
      const reading = (await readReading(db, owner.id))!;
      assert.ok(Object.values(reading.digest.ranking!.scores).every(s => s.feedback === 0.5));
      assert.match(await (await worker.fetch(origin + '/')).text(), /Hosted ranking/);
      assert.equal((await readReading(db, friend.id))!.generationId, a.id);
    });

    await t.test('an unavailable response/persistence failure fails once, and a later generation may try again', async () => {
      const before = await readReading(db, owner.id);
      const next = { ...batch, date: '2030-01-01', papers: batch.papers.map(p => ({ ...p, title: p.title + ' new input' })) };
      const run = (await freezeGenerationInputs(db, owner.id, [next], HOSTED_BGE_FINGERPRINT))!;
      await db.prepare(`CREATE TRIGGER reject_embedding_result BEFORE UPDATE OF vectors_json ON embedding_requests
        BEGIN SELECT RAISE(ABORT, 'persistence unavailable'); END`).run();
      const result = await invoke(owner.id, run.id);
      assert.equal(result.status, 'failed'); assert.equal(result.calls, 1);
      await db.prepare('DROP TRIGGER reject_embedding_result').run();
      assert.deepEqual(await readReading(db, owner.id), before);
      assert.equal((await invoke(owner.id, run.id)).calls, 0);
      const later = (await freezeGenerationInputs(db, owner.id, [next], HOSTED_BGE_FINGERPRINT))!;
      assert.notEqual(later.id, run.id);
      const failed = await invoke(owner.id, later.id, 8, true);
      assert.equal(failed.status, 'failed'); assert.equal(failed.calls, 1);
      assert.deepEqual(await readReading(db, owner.id), before);
      const fresh = (await freezeGenerationInputs(db, owner.id, [next], HOSTED_BGE_FINGERPRINT))!;
      assert.equal(await finish(owner.id, fresh.id), next.papers.length);
    });

    await t.test('a lost-process claim is never resent, even when caches could now satisfy the ranking', async () => {
      const next = { ...batch, date: '2030-02-01' };
      const run = (await freezeGenerationInputs(db, friend.id, [next], HOSTED_BGE_FINGERPRINT))!;
      const before = await readReading(db, friend.id);
      await db.prepare("INSERT INTO embedding_requests (generation_id, request_key, state) VALUES (?, ?, 'claimed')")
        .bind(run.id, 'lost-process-after-admission').run();
      const result = await invoke(friend.id, run.id);
      assert.equal(result.status, 'failed'); assert.equal(result.calls, 0);
      assert.deepEqual(await readReading(db, friend.id), before);
      assert.equal((await invoke(friend.id, run.id)).status, 'stale');
    });

    await t.test('shared in-flight work waits without finalizing its owner; completed results are reused', async () => {
      const next = { ...batch, date: '2030-03-01' };
      const left = (await freezeGenerationInputs(db, owner.id, [next], HOSTED_BGE_FINGERPRINT))!;
      const right = (await freezeGenerationInputs(db, friend.id, [next], HOSTED_BGE_FINGERPRINT))!;
      let release!: (value: unknown) => void, entered!: () => void;
      const ready = new Promise<void>(r => { entered = r; });
      let calls = 0;
      const texts = ['A different scientific input for request sharing'];
      const pending = embeddingRequest(db, owner.id, left.id, texts, false, async () => {
        calls++; entered(); return new Promise(r => { release = r; });
      }, { remaining: 1 });
      await ready;
      await assert.rejects(embeddingRequest(db, friend.id, right.id, texts, false, async () => { calls++; return response(1); }, { remaining: 1 }),
        e => e instanceof EmbeddingPause && e.reason === 'waiting');
      assert.ok(await readGenerationInputs(db, owner.id, left.id));
      release(response(1)); const completed = await pending;
      assert.deepEqual(await embeddingRequest(db, friend.id, right.id, texts, false, async () => { calls++; return response(1); }, { remaining: 1 }), completed);
      assert.equal(calls, 1);
      await db.prepare('UPDATE users SET enabled = 0 WHERE id = ?').bind(owner.id).run();
      await assert.rejects(embeddingRequest(db, owner.id, left.id, ['disabled'], true, async () => { calls++; return response(1); }, { remaining: 1 }), /no longer active/);
      assert.equal(calls, 1);
      await db.prepare('UPDATE users SET enabled = 1 WHERE id = ?').bind(owner.id).run();
      await failGeneration(db, owner.id, left.id); await failGeneration(db, friend.id, right.id);
    });

    await t.test('long inputs resume between chunk batches without storing a partial paper vector', async () => {
      const paper = { ...batch.papers[0], title: 'A long new scientific input', abstract: 'experiment '.repeat(6000) };
      assert.ok(embeddingChunks({ kind: 'paper', title: paper.title, text: paper.abstract }).length > 8);
      const next = { ...batch, date: '2030-03-02', papers: [paper] };
      const run = (await freezeGenerationInputs(db, owner.id, [next], HOSTED_BGE_FINGERPRINT))!;
      const before = await readReading(db, owner.id);
      const first = await invoke(owner.id, run.id, 1);
      assert.equal(first.status, 'paused'); assert.equal(first.calls, 1);
      const inputHash = createHash('sha256').update(JSON.stringify({ kind: 'paper', title: paper.title, text: paper.abstract })).digest('hex');
      assert.equal((await db.prepare('SELECT count(*) AS n FROM paper_vectors WHERE input_hash = ?')
        .bind(inputHash).first<{ n: number }>())!.n, 0);
      assert.deepEqual(await readReading(db, owner.id), before);
      const second = await invoke(owner.id, run.id, 1);
      assert.equal(second.status, 'published'); assert.equal(second.calls, 1);
      assert.equal((await readReading(db, owner.id))!.digest.papers[0].abstract, paper.abstract);
      assert.equal((await db.prepare('SELECT count(*) AS n FROM embedding_requests WHERE generation_id = ?')
        .bind(run.id).first<{ n: number }>())!.n, 2);
    });

    await t.test('a transient D1 failure retries only persistence while the response is in memory', async () => {
      const run = (await freezeGenerationInputs(db, owner.id, [{ ...batch, date: '2030-03-03' }], HOSTED_BGE_FINGERPRINT))!;
      await db.prepare(`CREATE TRIGGER transient_embedding_result BEFORE UPDATE OF vectors_json ON embedding_requests
        BEGIN SELECT RAISE(ABORT, 'transient persistence failure'); END`).run();
      // Forward real D1 operations. Remove the fault after the first failed SQL
      // operation; no result or provider success is mocked by this wrapper.
      const wrap = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, { get(target, key) {
        if (key === 'bind') return (...args: unknown[]) => wrap(target.bind(...args));
        if (key === 'run') return async () => {
          try { return await target.run(); } catch (error) {
            await db.prepare('DROP TRIGGER IF EXISTS transient_embedding_result').run(); throw error;
          }
        };
        const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
      } });
      const forwarded = new Proxy(db, { get(target, key) {
        if (key === 'prepare') return (sql: string) => sql.startsWith('UPDATE embedding_requests') ? wrap(target.prepare(sql)) : target.prepare(sql);
        const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
      } }) as D1Database;
      let calls = 0;
      const vectors = await embeddingRequest(forwarded, owner.id, run.id, ['result persistence recovery'], false,
        async () => { calls++; return response(1); }, { remaining: 1 });
      assert.equal(calls, 1); assert.equal(vectors[0][0], 1);
      assert.deepEqual(await embeddingRequest(db, owner.id, run.id, ['result persistence recovery'], false,
        async () => { calls++; return response(1); }, { remaining: 1 }), vectors);
      assert.equal(calls, 1);
      await failGeneration(db, owner.id, run.id);
    });

    await t.test('wrong model/summary intent is rejected before effects; a stale callback cannot persist or publish', async () => {
      const next = { ...batch, date: '2030-04-01' };
      let calls = 0;
      const incompatible = (await freezeGenerationInputs(db, owner.id, [next], 'local-onnx-space'))!;
      await assert.rejects(runHostedRanking(db, owner.id, incompatible.id, async () => { calls++; return response(1); }), /hosted fingerprint/);
      await failGeneration(db, owner.id, incompatible.id);
      const summaries = (await freezeGenerationInputs(db, owner.id, [next], HOSTED_BGE_FINGERPRINT, true))!;
      await assert.rejects(runHostedRanking(db, owner.id, summaries.id, async () => { calls++; return response(1); }), /no requested summaries/);
      await failGeneration(db, owner.id, summaries.id);
      const run = (await freezeGenerationInputs(db, owner.id, [next], HOSTED_BGE_FINGERPRINT))!;
      await assert.rejects(embeddingRequest(db, owner.id, run.id, ['late response'], false, async () => {
        calls++; await failGeneration(db, owner.id, run.id); return response(1);
      }, { remaining: 1 }), /no longer active/);
      assert.equal(calls, 1);
      assert.equal((await invoke(owner.id, run.id)).status, 'stale');
    });
  } finally { await fixture.close(); }
});
