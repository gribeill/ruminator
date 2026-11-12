// Copyright 2026 Guilhem Ribeill
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { D1Database, D1DatabaseSession } from '@cloudflare/workers-types';
import { startHostedFixture, freezeFixtureInputs, fixtureDigest } from '../scripts/hosted-fixtures.ts';
import { runHostedGeneration } from '../src/hosted/ranking-runner.ts';
import { readGenerationInputs } from '../src/hosted/generation-inputs.ts';
import { readReading, saveUserVote } from '../src/hosted/reading-store.ts';
import { HOSTED_BGE_FINGERPRINT, EMBEDDING_REQUEST_TIMEOUT_MS } from '../src/hosted/bge.ts';
import { SUMMARY_REQUEST_TIMEOUT_MS } from '../src/cloudflare-summary.ts';
import { HTML_REQUEST_TIMEOUT_MS } from '../src/hosted/html-source.ts';
import { WORKFLOW_EMBEDDING_REQUESTS, WORKFLOW_SUMMARY_REQUESTS, WORKFLOW_STEP_MINUTES } from '../src/hosted/workflow-limits.ts';
import { launchDailyGeneration } from '../src/hosted/daily-runs.ts';
import { executeFrozenSummaries } from '../src/hosted/summary-execution.ts';
import { readExtractedText, saveSourceText } from '../src/hosted/source-store.ts';
import { frozenSummaryContext, readFrozenCachedSummary, saveCachedSummary } from '../src/hosted/inference-cache.ts';
import { extractArxivHtml } from '../src/html-extraction.ts';
import { parseConfig } from '../src/config-text.ts';
import { failGeneration } from '../src/hosted/publication.ts';

test('Workflow request allowance leaves a minute beyond worst-case transport timeouts', () => {
  const io = WORKFLOW_EMBEDDING_REQUESTS * EMBEDDING_REQUEST_TIMEOUT_MS
    + 6 * HTML_REQUEST_TIMEOUT_MS + WORKFLOW_SUMMARY_REQUESTS * SUMMARY_REQUEST_TIMEOUT_MS;
  assert.ok(io <= (WORKFLOW_STEP_MINUTES - 1) * 60_000);
});

test('review regressions: cold empty batches, bounded Workflow steps, and single-read summary context', { timeout: 180000 }, async t => {
  const f = await startHostedFixture('scripts/hosted-workflow-fixture.ts', 'FixtureGenerationWorkflow');
  const { db, worker, owner } = f;
  const inspector = await worker.introspectWorkflow('GENERATION');
  await inspector.modifyAll(async c => { await c.disableSleeps(); await c.disableRetryDelays(); });
  try {
    await t.test('cold empty batch keeps active vote metadata without embedding profiles or feedback', async () => {
      const prior = (await readReading(db, owner.id))!;
      await saveUserVote(db, owner.id, prior.generationId, prior.digest.papers[0].id, 1);
      const inputs = await freezeFixtureInputs(db, owner.id,
        [{ category: 'quant-ph', date: '2030-01-08', sourceUrl: 'recorded', papers: [] }], HOSTED_BGE_FINGERPRINT, true);
      assert.equal(inputs.votes.length, 1);
      assert.equal(await db.prepare('SELECT 1 FROM generation_profile_vectors').first(), null);
      let calls = 0;
      const unexpected = () => { calls++; throw new Error('Empty batch must not request inference or sources'); };
      assert.equal(await runHostedGeneration(db, owner.id, inputs.id, {
        embedding: unexpected, summaries: { createProvider: unexpected, loadSource: unexpected },
      }), 'published');
      assert.equal(calls, 0);
      const reading = (await readReading(db, owner.id))!;
      assert.equal(reading.digest.papers.length, 0);
      assert.equal(reading.digest.ranking!.featured.length, 0);
      assert.deepEqual((await readGenerationInputs(db, owner.id, inputs.id))!.votes, inputs.votes);
      assert.equal(await db.prepare('SELECT 1 FROM generation_feedback_examples WHERE generation_id = ?').bind(inputs.id).first(), null);
      assert.equal(await db.prepare('SELECT 1 FROM embedding_requests WHERE generation_id = ?').bind(inputs.id).first(), null);
      assert.equal(await db.prepare('SELECT 1 FROM summary_outcomes WHERE generation_id = ?').bind(inputs.id).first(), null);
    });

    await t.test('real Workflow continuations enforce the reduced request counts', async () => {
      await db.batch([
        db.prepare('CREATE TABLE fixture_calls (generation_id TEXT, kind TEXT, request_key TEXT, calls INTEGER, PRIMARY KEY(generation_id,kind,request_key))'),
        db.prepare('CREATE TABLE fixture_faults (generation_id TEXT PRIMARY KEY, consumed INTEGER DEFAULT 0, after_publish INTEGER DEFAULT 0)'),
        db.prepare('CREATE TABLE fixture_step_usage (generation_id TEXT, step INTEGER, kind TEXT, calls INTEGER, PRIMARY KEY(generation_id,step,kind))'),
      ]);
      await db.prepare(`CREATE TRIGGER record_step_usage AFTER INSERT ON fixture_calls WHEN NEW.kind IN ('embedding','summary')
        BEGIN INSERT INTO fixture_step_usage VALUES (NEW.generation_id,
          (SELECT calls FROM fixture_calls WHERE generation_id = NEW.generation_id AND kind = 'step'), NEW.kind, 1)
          ON CONFLICT(generation_id,step,kind) DO UPDATE SET calls = calls + 1; END`).run();
      const digest = fixtureDigest('Bounded Workflow');
      const result = await launchDailyGeneration(db, (await worker.getEnv()).GENERATION, owner.id,
        [{ category: 'quant-ph', date: '2030-01-09', sourceUrl: 'recorded', papers: digest.papers }],
        HOSTED_BGE_FINGERPRINT, { summariesRequested: true });
      assert.equal(result.status, 'launched'); assert.ok('generationId' in result);
      const instance = await worker.introspectWorkflowInstance('GENERATION', result.generationId!);
      try { await instance.waitForStatus('complete'); assert.equal(await instance.getOutput(), 'published'); }
      finally { await instance.dispose(); }
      const rows = (await db.prepare('SELECT kind,calls FROM fixture_step_usage').all<{ kind: string; calls: number }>()).results;
      assert.ok(rows.some(r => r.kind === 'embedding' && r.calls === WORKFLOW_EMBEDDING_REQUESTS));
      assert.ok(rows.every(r => r.calls <= (r.kind === 'embedding' ? WORKFLOW_EMBEDDING_REQUESTS : WORKFLOW_SUMMARY_REQUESTS)));
      assert.equal(rows.filter(r => r.kind === 'summary').reduce((sum, r) => sum + r.calls, 0), 6);
      assert.equal(await db.prepare("SELECT 1 FROM fixture_calls WHERE kind != 'step' AND calls != 1").first(), null);
    });

    await t.test('cached summaries read each verified text once, no raw HTML or duplicate snapshots, with fresh access checks', async () => {
      const digest = fixtureDigest('Single context'); digest.date = '2030-01-10';
      const inputs = await freezeFixtureInputs(db, owner.id,
        [{ category: 'quant-ph', date: digest.date, sourceUrl: 'recorded', papers: digest.papers }], 'fixture-only', true);
      const html = readFileSync('test/fixtures/paper-unsectioned.html', 'utf8'), text = extractArxivHtml(html);
      const sha = (s: string) => createHash('sha256').update(s).digest('hex');
      const extractor = 'single-context-v1';
      for (const { id } of digest.ranking!.featured) {
        const paper = digest.papers.find(p => p.id === id)!;
        await saveSourceText(db, owner.id, inputs.id, paper, { html, result: { paperId: paper.id, version: paper.version,
          extractor, status: 'available', text, sourceUrl: `https://arxiv.org/html/${paper.id}v${paper.version}`, checkedAt: new Date().toISOString() } });
        await saveCachedSummary(db, owner.id, inputs.id, paper, extractor,
          { summary: 'Recorded measurements resolved the device response. Analysis quantified the correlations.' });
      }
      let textReads = 0;
      // Observe actual D1 calls, never substitute results. A repeated snapshot or
      // raw-HTML read fails immediately, even though the fixture is small.
      function observe<T extends D1Database | D1DatabaseSession>(target: T): T {
        return new Proxy(target, { get(target, key) {
          if (key === 'withSession') return (constraint: Parameters<D1Database['withSession']>[0]) => observe((target as D1Database).withSession(constraint));
          if (key === 'prepare') return (sql: string) => {
            assert.doesNotMatch(sql, /SELECT g\.\* FROM generation_inputs/);
            const statement = target.prepare(sql);
            if (!sql.includes('FROM source_blobs WHERE hash = ?')) return statement;
            return new Proxy(statement, { get(statement, key) {
              if (key === 'bind') return (...values: unknown[]) => {
                assert.notEqual(values[0], sha(html), 'Summary path loaded raw HTML');
                assert.equal(values[0], sha(text)); textReads++;
                return statement.bind(...values);
              };
              const value = Reflect.get(statement, key); return typeof value === 'function' ? value.bind(statement) : value;
            } });
          };
          const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
        } });
      }
      assert.equal(await executeFrozenSummaries(observe(db), inputs, digest, { extractor,
        createProvider: () => { throw new Error('Cache hit must not call provider'); },
        loadSource: async () => { throw new Error('Source already cached'); },
      }), 'complete');
      assert.equal(textReads, 6);
      assert.ok(Object.values(digest.summaries!).every(s => s.status === 'available' && !s.usage));
      const paper = digest.papers.find(p => p.id === digest.ranking!.featured[0].id)!;
      const source = (await readExtractedText(db, owner.id, inputs.id, paper, extractor))!;
      const context = await frozenSummaryContext(paper, source, parseConfig(inputs.config.text));
      await db.prepare('UPDATE users SET enabled = 0 WHERE id = ?').bind(owner.id).run();
      assert.equal(await readFrozenCachedSummary(db, owner.id, inputs.id, context), undefined);
      await db.prepare('UPDATE users SET enabled = 1 WHERE id = ?').bind(owner.id).run();
      assert.ok(await readFrozenCachedSummary(db, owner.id, inputs.id, context));
      await db.prepare('DELETE FROM generation_text_refs WHERE generation_id = ? AND text_id = ?').bind(inputs.id, context.sourceId).run();
      assert.equal(await readFrozenCachedSummary(db, owner.id, inputs.id, context), undefined);
      await failGeneration(db, owner.id, inputs.id);
    });
  } finally { await inspector.dispose(); await f.close(); }
});
