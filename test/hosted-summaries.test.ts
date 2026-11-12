// Copyright 2026 Guilhem Ribeill
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { D1Database } from '@cloudflare/workers-types';
import type { Paper } from '../src/arxiv.ts';
import { extractArxivHtml } from '../src/html-extraction.ts';
import { parseConfig } from '../src/config-text.ts';
import { estimatePromptTokens } from '../src/tokenizer.ts';
import { summaryMessages, SummaryError } from '../src/summary-content.ts';
import { fixtureDigest, startHostedFixture } from '../scripts/hosted-fixtures.ts';
import { HOSTED_BGE_FINGERPRINT } from '../src/hosted/bge.ts';
import { freezeFixtureInputs as freezeGenerationInputs } from '../scripts/hosted-fixtures.ts';
import { executeHostedSummaries, type SummaryExecution } from '../src/hosted/summary-execution.ts';
import { readSavedConfig, saveConfig } from '../src/hosted/saved-inputs.ts';
import { readReading } from '../src/hosted/reading-store.ts';
import { failGeneration, stagePublication } from '../src/hosted/publication.ts';
import { readSourceText, saveSourceText } from '../src/hosted/source-store.ts';
import { readCachedSummary, saveCachedSummary } from '../src/hosted/inference-cache.ts';
import { cleanupHostedState } from '../src/hosted/retention.ts';

const baseline = readFileSync(new URL('../config.toml', import.meta.url), 'utf8');
const html = readFileSync(new URL('fixtures/paper-unsectioned.html', import.meta.url), 'utf8');
const extracted = extractArxivHtml(html);
const response = { summary: 'Recorded measurements resolved the device response. The analysis quantified the observed correlations.',
  model: 'fixture-response', usage: { inputTokens: 42, outputTokens: 20 } };
const source = (paper: Paper, extractor: string, text = extracted) => ({ html, result: {
  paperId: paper.id, version: paper.version, status: 'available' as const, sourceUrl: `https://arxiv.org/html/${paper.id}v${paper.version}`,
  checkedAt: '2030-01-01T00:00:00Z', extractor, text, contentHash: createHash('sha256').update(text).digest('hex'),
} });

test('hosted summary execution: local workerd/D1, frozen budgets, durable effects, and publication', { timeout: 180000 }, async t => {
  const fixture = await startHostedFixture('scripts/hosted-summary-fixture.ts');
  const { db, owner, friend, worker, origin } = fixture;
  let day = 0;
  const batch = (digest: ReturnType<typeof fixtureDigest>) => [{ category: 'quant-ph', date: digest.date, sourceUrl: 'fixture', papers: digest.papers }];
  const configure = async (text = baseline) => {
    const saved = (await readSavedConfig(db, owner.id))!;
    assert.equal((await saveConfig(db, owner.id, saved.revision, text)).status, 'saved');
  };
  const admit = async (label: string, userId = owner.id, model = 'fixture-only') => {
    const digest = fixtureDigest(label); digest.date = `2031-01-${String(++day).padStart(2, '0')}`;
    const inputs = (await freezeGenerationInputs(db, userId, batch(digest), model, true))!;
    assert.ok(inputs);
    return { digest, inputs };
  };
  const ledger = async (id: string) => (await db.prepare(`SELECT paper_id, state, charged_input, budget_stopped, outcome_json
    FROM summary_outcomes WHERE generation_id = ? ORDER BY ordinal`).bind(id)
    .all<{ paper_id: string; state: string; charged_input: number; budget_stopped: number; outcome_json: string | null }>()).results;
  const invoke = async (userId: string, generationId: string, invalid = false, extractor = 'summary-workerd-v1') => {
    const r = await worker.fetch(origin + '/__fixture/summaries', { method: 'POST',
      body: JSON.stringify({ userId, generationId, html, invalid, extractor }) });
    assert.equal(r.status, 200, await r.clone().text());
    return await r.json() as { status: string; embeddings: number; summaries: number; sources: number; models: string[] };
  };
  try {
    await t.test('rank then summarize sequentially, keeping old publication and frozen settings until complete', async () => {
      const { digest, inputs } = await admit('Hosted summaries', owner.id, HOSTED_BGE_FINGERPRINT);
      const old = await readReading(db, owner.id);
      const originalModel = parseConfig(inputs.config.text).llm.model;
      let r = await invoke(owner.id, inputs.id), calls = r.summaries, sources = r.sources;
      assert.equal(r.status, 'paused'); assert.equal(r.summaries, 1); assert.ok(r.embeddings > 0);
      assert.deepEqual(await readReading(db, owner.id), old);
      await configure(baseline.replace(originalModel, 'fixture-next-model'));
      for (let n = 0; r.status !== 'published' && n < 8; n++) {
        r = await invoke(owner.id, inputs.id); calls += r.summaries; sources += r.sources;
        assert.equal(r.embeddings, 0); assert.ok(r.summaries <= 1);
        assert.ok(r.models.every(model => model === originalModel));
      }
      assert.equal(r.status, 'published'); assert.equal(calls, 6); assert.equal(sources, 6);
      const reading = (await readReading(db, owner.id))!;
      assert.equal(reading.generationId, inputs.id);
      assert.equal(Object.keys(reading.digest.summaries!).length, 6);
      assert.ok(Object.values(reading.digest.summaries!).every(s => s.status === 'available' && s.usage?.inputTokens === 42));
      const records = await ledger(inputs.id);
      assert.ok(records.every(r => r.state === 'complete' && r.charged_input > 42));
      assert.ok(records.every(r => reading.digest.ranking!.featured.some(p => p.id === r.paper_id)));
      assert.equal((await invoke(owner.id, inputs.id)).summaries, 0);

      // Same scientific request, another user: no charge and no copied usage.
      await configure();
      const other = (await freezeGenerationInputs(db, friend.id, batch(digest), HOSTED_BGE_FINGERPRINT, true))!;
      const shared = await invoke(friend.id, other.id);
      assert.equal(shared.status, 'published'); assert.equal(shared.summaries, 0); assert.equal(shared.sources, 0);
      assert.ok((await ledger(other.id)).every(r => r.charged_input === 0));
      assert.ok(Object.values((await readReading(db, friend.id))!.digest.summaries!).every(s => s.usage === undefined));
    });

    await t.test('oversized provider output is terminal, charged, not shared, and does not prevent completed ranking publication', async () => {
      const { inputs } = await admit('Invalid hosted output', owner.id, HOSTED_BGE_FINGERPRINT);
      let calls = 0, status = '';
      for (let n = 0; n < 8 && status !== 'published'; n++) {
        const r = await invoke(owner.id, inputs.id, true, 'invalid-output-v1'); calls += r.summaries; status = r.status;
      }
      assert.equal(status, 'published'); assert.equal(calls, 6);
      const reading = (await readReading(db, owner.id))!;
      assert.ok(Object.values(reading.digest.summaries!).every(s => s.status === 'summarization_error' && s.usage?.inputTokens === 42));
      assert.ok((await ledger(inputs.id)).every(r => r.charged_input > 0 && !r.outcome_json!.includes('界')));
      assert.equal((await invoke(owner.id, inputs.id, true, 'invalid-output-v1')).summaries, 0);
    });

    await t.test('run budget stops smaller later misses, while a successful cache hit remains free', async () => {
      const sample = fixtureDigest('Budget test');
      const first = sample.papers.find(p => p.id === sample.ranking!.featured[0].id)!;
      const third = sample.papers.find(p => p.id === sample.ranking!.featured[2].id)!;
      const short = extracted, medium = extracted + ' experiment'.repeat(400), long = extracted + ' experiment'.repeat(3000);
      const config = parseConfig(baseline);
      const estimate = (p: Paper, text: string) => estimatePromptTokens(summaryMessages(p, text), config.tokenizer).estimatedInputTokens;
      const limit = estimate(first, medium) + estimate(third, short) + 10;
      await configure(baseline.replace('run_input_tokens = 500000', `run_input_tokens = ${limit}`));
      const { digest, inputs } = await admit('Budget test');
      const featured = digest.ranking!.featured.map(p => digest.papers.find(q => q.id === p.id)!);
      const extractor = 'budget-v1';
      await saveSourceText(db, owner.id, inputs.id, featured[3], source(featured[3], extractor, short));
      await saveCachedSummary(db, owner.id, inputs.id, featured[3], extractor, { summary: response.summary });
      let calls = 0;
      const progress = await executeHostedSummaries(db, owner.id, inputs.id, digest, { extractor, maxRequests: 6,
        loadSource: async p => source(p, extractor, p.id === featured[0].id ? medium : p.id === featured[1].id ? long : short),
        createProvider: () => ({ summarize: async () => { calls++; return response; } }),
      });
      assert.equal(progress, 'complete'); assert.equal(calls, 1);
      const rows = await ledger(inputs.id);
      assert.ok(rows[0].charged_input + estimate(third, short) <= limit);
      assert.equal(rows[1].budget_stopped, 1); assert.equal(rows[2].budget_stopped, 1);
      assert.equal(digest.summaries![featured[3].id].status, 'available'); assert.equal(rows[3].charged_input, 0);
      assert.ok(rows.slice(1).every(r => r.charged_input === 0));
      await configure(); // A larger saved budget cannot rewrite this run's skips or frozen limits.
      await executeHostedSummaries(db, owner.id, inputs.id, digest, { createProvider: () => { throw new Error('Must not retry'); } });
      assert.deepEqual(await ledger(inputs.id), rows);
      await failGeneration(db, owner.id, inputs.id);
    });

    await t.test('paper/context bounds and missing HTML cause no paid reservation', async () => {
      for (const limits of [baseline.replace('paper_input_tokens = 150000', 'paper_input_tokens = 1'),
        baseline.replace('context_tokens = 152048', 'context_tokens = 2049')]) {
        await configure(limits);
        const { digest, inputs } = await admit('Preconditions');
        const absent = digest.ranking!.featured[0].id;
        let factories = 0;
        assert.equal(await executeHostedSummaries(db, owner.id, inputs.id, digest, {
          extractor: 'preconditions-v1', loadSource: async p => { if (p.id === absent) throw new Error('private source diagnostics'); return source(p, 'preconditions-v1'); },
          createProvider: () => { factories++; throw new Error('Not eligible'); },
        }), 'complete');
        assert.equal(factories, 0); assert.equal(digest.summaries![absent].status, 'html_unavailable');
        assert.ok(Object.values(digest.summaries!).filter(s => s.paperId !== absent).every(s => s.status === 'token_budget'));
        assert.ok((await ledger(inputs.id)).every(r => r.charged_input === 0 && r.budget_stopped === 0 && !r.outcome_json!.includes('private source')));
        await failGeneration(db, owner.id, inputs.id);
      }
      await configure();
    });

    await t.test('explicit source refresh repairs only pending unavailable input; missing credentials acquire no claim', async () => {
      const { digest, inputs } = await admit('Source refresh');
      const paper = digest.papers.find(p => p.id === digest.ranking!.featured[0].id)!;
      const extractor = 'refresh-v1';
      await saveSourceText(db, owner.id, inputs.id, paper, { html: null, result: {
        paperId: paper.id, version: paper.version, status: 'unavailable', extractor,
        sourceUrl: 'https://arxiv.org/html/fixture', checkedAt: '2030-01-01T00:00:00Z', reason: 'Recorded unavailable response',
      } });
      const options: SummaryExecution = { extractor, retryUnavailableSource: true, loadSource: async p => source(p, extractor),
        createProvider: () => { throw new SummaryError('api_unavailable', 'Missing credentials'); },
      };
      await assert.rejects(executeHostedSummaries(db, owner.id, inputs.id, digest, options), /Missing credentials/);
      assert.equal((await readSourceText(db, owner.id, inputs.id, paper, extractor))!.result.status, 'available');
      assert.ok((await ledger(inputs.id)).every(r => r.state === 'pending' && r.charged_input === 0));
      let calls = 0;
      assert.equal(await executeHostedSummaries(db, owner.id, inputs.id, digest, { ...options,
        createProvider: () => ({ summarize: async () => { calls++; return response; } }),
      }), 'paused');
      assert.equal(calls, 1);
      await failGeneration(db, owner.id, inputs.id);
    });

    await t.test('shared contention waits; neither another user’s claim nor budget is taken over', async () => {
      const { digest, inputs } = await admit('Concurrent summaries');
      const other = (await freezeGenerationInputs(db, friend.id, batch(digest), 'fixture-only', true))!;
      const otherDigest = structuredClone(digest);
      const extractor = 'contended-v1';
      let entered!: () => void, release!: () => void, calls = 0;
      const ready = new Promise<void>(r => { entered = r; });
      const held = new Promise<void>(r => { release = r; });
      const options: SummaryExecution = { extractor, maxRequests: 1, loadSource: async p => source(p, extractor),
        createProvider: () => ({ summarize: async () => { calls++; if (calls === 1) { entered(); await held; } return response; } }),
      };
      const first = executeHostedSummaries(db, owner.id, inputs.id, digest, options);
      await ready;
      assert.equal(await executeHostedSummaries(db, friend.id, other.id, otherDigest, options), 'waiting');
      assert.equal(calls, 1); assert.equal((await ledger(inputs.id))[0].state, 'claimed');
      assert.ok((await ledger(other.id)).every(r => r.charged_input === 0));
      release(); assert.equal(await first, 'paused');
      assert.equal(await executeHostedSummaries(db, friend.id, other.id, otherDigest, options), 'paused');
      assert.equal(calls, 2);
      assert.equal(otherDigest.summaries![digest.ranking!.featured[0].id].usage, undefined);
      assert.ok((await ledger(other.id))[1].charged_input > 0); // Friend owns its own reservation.
      assert.equal(await executeHostedSummaries(db, owner.id, inputs.id, digest, { ...options, maxRequests: 6 }), 'complete');
      assert.equal(await executeHostedSummaries(db, friend.id, other.id, otherDigest, { ...options, maxRequests: 6 }), 'complete');
      assert.equal(calls, 6);
      await failGeneration(db, owner.id, inputs.id); await failGeneration(db, friend.id, other.id);
    });

    await t.test('lost response persistence leaves a charged claim; replay finalizes unavailable without resend', async () => {
      const { digest, inputs } = await admit('Lost response');
      const before = await readReading(db, owner.id), extractor = 'lost-response-v1';
      const calls: string[] = [];
      const options: SummaryExecution = { extractor, maxRequests: 1, loadSource: async p => source(p, extractor),
        createProvider: () => ({ summarize: async messages => { calls.push(messages[1].content.split('\n')[0]); return response; } }),
      };
      await db.prepare(`CREATE TRIGGER reject_summary BEFORE UPDATE ON summary_outcomes
        WHEN OLD.state = 'claimed' AND NEW.state = 'complete' BEGIN SELECT RAISE(ABORT, 'fixture persistence outage'); END`).run();
      await assert.rejects(executeHostedSummaries(db, owner.id, inputs.id, digest, options), /could not be persisted/);
      await db.prepare('DROP TRIGGER reject_summary').run();
      const first = (await ledger(inputs.id))[0];
      assert.equal(first.state, 'claimed'); assert.ok(first.charged_input > 0); assert.equal(calls.length, 1);
      const paper = digest.papers.find(p => p.id === first.paper_id)!;
      assert.equal(await readCachedSummary(db, owner.id, inputs.id, paper, extractor), undefined); // Atomic rollback.
      await assert.rejects(stagePublication(db, owner.id, inputs.id, digest));
      assert.equal(await executeHostedSummaries(db, owner.id, inputs.id, digest, options), 'paused');
      assert.equal(calls.length, 2); assert.notEqual(calls[0], calls[1]);
      assert.equal(digest.summaries![paper.id].status, 'summarization_error');
      assert.equal((await ledger(inputs.id))[0].charged_input, first.charged_input);
      assert.deepEqual(await readReading(db, owner.id), before);
      await executeHostedSummaries(db, owner.id, inputs.id, digest, { ...options, maxRequests: 6 });
      assert.equal(new Set(calls).size, 6); assert.equal(calls.length, 6);
      await failGeneration(db, owner.id, inputs.id);
    });

    await t.test('transient SQL failures and lost acknowledgements retry persistence only', async () => {
      for (const fault of ['rollback', 'acknowledgement']) {
        const { digest, inputs } = await admit(`Persistence ${fault}`);
        const extractor = `persistence-${fault}-v1`;
        if (fault === 'rollback') await db.prepare(`CREATE TRIGGER transient_summary BEFORE UPDATE ON summary_outcomes
          WHEN OLD.state = 'claimed' AND NEW.state = 'complete' BEGIN SELECT RAISE(ABORT, 'temporary outage'); END`).run();
        let afterResponse = false, injected = false, calls = 0;
        // Forward actual D1 transactions. Inject one outage/ack loss, never fake a result.
        const forwarded = new Proxy(db, { get(target, key) {
          if (key === 'batch') return async (statements: Parameters<D1Database['batch']>[0]) => {
            try {
              const result = await target.batch(statements);
              if (afterResponse && !injected && fault === 'acknowledgement') { injected = true; throw new Error('Lost acknowledgement'); }
              return result;
            } catch (error) {
              if (fault === 'rollback') { injected = true; await db.prepare('DROP TRIGGER IF EXISTS transient_summary').run(); }
              throw error;
            }
          };
          const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
        } }) as D1Database;
        assert.equal(await executeHostedSummaries(forwarded, owner.id, inputs.id, digest, {
          extractor, maxRequests: 1, loadSource: async p => source(p, extractor),
          createProvider: () => ({ summarize: async () => { calls++; afterResponse = true; return response; } }),
        }), 'paused');
        assert.equal(calls, 1); assert.equal(injected, true); assert.equal((await ledger(inputs.id))[0].state, 'complete');
        await failGeneration(db, owner.id, inputs.id);
      }
    });

    await t.test('provider failures remain terminal without leaking diagnostics, and stale results cannot persist', async () => {
      const { digest, inputs } = await admit('Provider unavailable');
      let calls = 0;
      const options: SummaryExecution = { extractor: 'unavailable-v1', maxRequests: 6,
        loadSource: async p => source(p, 'unavailable-v1'), createProvider: () => ({ summarize: async () => {
          calls++; throw new SummaryError('api_unavailable', 'SECRET provider diagnostics', { inputTokens: 7, outputTokens: 0 });
        } }),
      };
      assert.equal(await executeHostedSummaries(db, owner.id, inputs.id, digest, options), 'complete');
      assert.equal(calls, 6);
      await executeHostedSummaries(db, owner.id, inputs.id, digest, options); assert.equal(calls, 6);
      assert.ok((await ledger(inputs.id)).every(r => r.charged_input > 0 && !r.outcome_json!.includes('SECRET')));
      await failGeneration(db, owner.id, inputs.id);
      const stale = await admit('Stale summary');
      const old = await readReading(db, owner.id);
      await assert.rejects(executeHostedSummaries(db, friend.id, stale.inputs.id, stale.digest, options), /owned/);
      await db.prepare('UPDATE users SET enabled = 0 WHERE id = ?').bind(owner.id).run();
      await assert.rejects(executeHostedSummaries(db, owner.id, stale.inputs.id, stale.digest, options), /owned/);
      await db.prepare('UPDATE users SET enabled = 1 WHERE id = ?').bind(owner.id).run();
      await assert.rejects(executeHostedSummaries(db, owner.id, stale.inputs.id, stale.digest, { ...options, extractor: 'stale-v1',
        loadSource: async p => source(p, 'stale-v1'), createProvider: () => ({ summarize: async () => {
          calls++; await failGeneration(db, owner.id, stale.inputs.id); return response;
        } }),
      }), /could not be persisted/);
      assert.equal(calls, 7); assert.deepEqual(await readReading(db, owner.id), old);
      const row = (await ledger(stale.inputs.id))[0];
      assert.equal(row.state, 'claimed');
      // Failed snapshots are no longer readable through cache APIs, inspect the durable key instead.
      const key = JSON.parse(row.outcome_json!).cacheKey;
      assert.equal(await db.prepare('SELECT 1 FROM summary_cache WHERE cache_key = ?').bind(key).first(), null);
      await cleanupHostedState(db);
      assert.equal((await ledger(stale.inputs.id)).length, 0);
    });
  } finally { await fixture.close(); }
});
