// Copyright 2026 Guilhem Ribeill
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { Digest } from '../src/digest.ts';
import { parseProfiles } from '../src/profile-text.ts';
import { extractArxivHtml } from '../src/html-extraction.ts';
import { HTML_EXTRACTOR } from '../src/fulltext-types.ts';
import { summaryMessages } from '../src/summary-content.ts';
import { fixtureDigest, publishFixture, startHostedFixture } from '../scripts/hosted-fixtures.ts';
import { freezeFixtureInputs as freezeGenerationInputs } from '../scripts/hosted-fixtures.ts';
import { initializeSavedConfig, saveConfig, readSavedInterests, saveInterests } from '../src/hosted/saved-inputs.ts';
import { provisionUser, readReading, saveUserVote } from '../src/hosted/reading-store.ts';
import { saveSourceText } from '../src/hosted/source-store.ts';
import { readPaperVector, savePaperVector, readProfileVector, saveProfileVector,
  readCachedSummary, saveCachedSummary, type CachedSummary } from '../src/hosted/inference-cache.ts';
import { failGeneration, stagePublication, publishGeneration } from '../src/hosted/publication.ts';
import { cleanupHostedState } from '../src/hosted/retention.ts';

const config = readFileSync(new URL('../config.toml', import.meta.url), 'utf8');
const html = readFileSync(new URL('./fixtures/paper.html', import.meta.url), 'utf8');
const text = extractArxivHtml(html);
const batches = (d: Digest) => [{ category: 'quant-ph', date: d.date, sourceUrl: 'fixture', papers: d.papers }];
const vector = (index = 0) => Array.from({ length: 384 }, (_, i) => i === index ? 1 : 0);

test('hosted inference caches: atomic results, private profiles, precise identities, and bounded retention', { timeout: 180000 }, async t => {
  const fixture = await startHostedFixture();
  const { db, owner, friend } = fixture;
  const count = async (table: string) => (await db.prepare(`SELECT count(*) AS n FROM ${table}`).first<{ n: number }>())!.n;
  try {
    await initializeSavedConfig(db, config);
    const digest = fixtureDigest('Shared cache'); digest.summaries = {};
    const paper = digest.papers.find(p => p.id === digest.ranking!.featured[0].id)!;
    const a = (await freezeGenerationInputs(db, owner.id, batches(digest), 'fixture-only'))!;
    const b = (await freezeGenerationInputs(db, friend.id, batches(digest), 'fixture-only'))!;
    const profile = parseProfiles(a.interests.text)[0].id;
    const source = (extractor = HTML_EXTRACTOR, body = html, extracted = text) => ({ html: body, result: {
      paperId: paper.id, version: paper.version, status: 'available' as const, extractor,
      sourceUrl: `https://arxiv.org/html/${paper.id}v${paper.version}`, checkedAt: new Date().toISOString(), text: extracted,
    } });
    let cached: CachedSummary;

    await t.test('paper vectors share exact compatible inputs; profile vectors never cross users', async () => {
      assert.equal(await readPaperVector(db, owner.id, a.id, paper), undefined);
      const [left, right] = await Promise.all([
        savePaperVector(db, owner.id, a.id, paper, vector()), savePaperVector(db, friend.id, b.id, paper, vector(1)),
      ]);
      assert.deepEqual(left, right);
      assert.equal(await count('paper_vectors'), 1);
      assert.deepEqual(await saveProfileVector(db, owner.id, a.id, profile, vector()), vector());
      assert.equal(await readProfileVector(db, friend.id, b.id, profile), undefined);
      assert.equal(await readProfileVector(db, friend.id, a.id, profile), undefined);
      assert.equal(await savePaperVector(db, friend.id, a.id, paper, vector()), undefined);
      assert.equal(await savePaperVector(db, owner.id, a.id, { ...paper, version: 99 }, vector()), undefined);
      for (const invalid of [[1, 0], Array(384), Array(384).fill(0), Array(384).fill(1), [NaN, ...vector().slice(1)], [Infinity, ...vector().slice(1)]]) {
        await assert.rejects(savePaperVector(db, owner.id, a.id, paper, invalid), /normalized 384/);
        await assert.rejects(saveProfileVector(db, owner.id, a.id, profile, invalid), /normalized 384/);
      }
      await db.prepare('UPDATE users SET enabled = 0 WHERE id = ?').bind(friend.id).run();
      assert.equal(await readPaperVector(db, friend.id, b.id, paper), undefined);
      assert.equal(await saveProfileVector(db, friend.id, b.id, profile, vector()), undefined);
      await db.prepare('UPDATE users SET enabled = 1 WHERE id = ?').bind(friend.id).run();
    });

    await t.test('successful summaries are shared atomically, bounded, and isolated by extractor/text', async () => {
      assert.equal(await readCachedSummary(db, owner.id, a.id, paper, HTML_EXTRACTOR), undefined);
      assert.equal(await saveCachedSummary(db, owner.id, a.id, paper, HTML_EXTRACTOR, { summary: 'No source exists yet.' }), undefined);
      await saveSourceText(db, owner.id, a.id, paper, source());
      const [left, right] = await Promise.all([
        saveCachedSummary(db, owner.id, a.id, paper, HTML_EXTRACTOR, { summary: 'Recorded scientific summary. No model was called.', actualModel: 'fixture-model' }),
        saveCachedSummary(db, friend.id, b.id, paper, HTML_EXTRACTOR, { summary: 'Another completed scientific result. No provider was invoked.' }),
      ]);
      assert.deepEqual(left, right); cached = left!;
      const identity = JSON.parse((await db.prepare('SELECT identity_json FROM summary_cache WHERE cache_key = ?')
        .bind(cached.cacheKey).first<{ identity_json: string }>())!.identity_json);
      assert.equal(identity.promptHash, createHash('sha256').update(JSON.stringify(summaryMessages(paper, text))).digest('hex'));
      assert.equal(identity.textHash, createHash('sha256').update(text).digest('hex'));
      assert.equal(await count('summary_cache'), 1);
      assert.equal(await readCachedSummary(db, friend.id, a.id, paper, HTML_EXTRACTOR), undefined);
      assert.deepEqual(await saveCachedSummary(db, owner.id, a.id, paper, HTML_EXTRACTOR, { summary: 'A late result cannot replace cached content.' }), cached);
      for (const invalid of ['', '```json\n{}\n```', '漢'.repeat(3000)]) {
        await assert.rejects(saveCachedSummary(db, owner.id, a.id, paper, HTML_EXTRACTOR, { summary: invalid }), /summary|Summary/);
      }
      assert.equal(await count('summary_cache'), 1);
      await saveSourceText(db, friend.id, b.id, paper, source('next-extractor', html + '\n', text + '\nAdditional extracted qualification.'));
      assert.equal(await readCachedSummary(db, friend.id, b.id, paper, 'next-extractor'), undefined);
      assert.deepEqual(await readCachedSummary(db, friend.id, b.id, paper, HTML_EXTRACTOR), cached);
    });

    await t.test('model fingerprints, changed input text, prompt identity, and saved configuration cannot mix', async () => {
      const user = (await provisionUser(db, fixture.access.identity('new@example.test')))!;
      let run = (await freezeGenerationInputs(db, user.id, batches(digest), 'different-pooling-or-epoch'))!;
      assert.equal(await readPaperVector(db, user.id, run.id, paper), undefined);
      await savePaperVector(db, user.id, run.id, paper, vector(2));
      await failGeneration(db, user.id, run.id);
      const changed = structuredClone(digest);
      changed.papers.find(p => p.id === paper.id)!.title += ' changed scientific title';
      run = (await freezeGenerationInputs(db, user.id, batches(changed), 'fixture-only'))!;
      assert.equal(await readPaperVector(db, user.id, run.id, paper), undefined);
      await savePaperVector(db, user.id, run.id, paper, vector(3));
      // Same text/extractor/provider, but the actual prompt includes the changed title.
      assert.equal(await readCachedSummary(db, user.id, run.id, paper, HTML_EXTRACTOR), undefined);
      await failGeneration(db, user.id, run.id);
      await saveConfig(db, owner.id, 1, config.replace('model = "openai/gpt-6-luna"', 'model = "fixture-next-model"'));
      assert.deepEqual(await readCachedSummary(db, owner.id, a.id, paper, HTML_EXTRACTOR), cached);
      run = (await freezeGenerationInputs(db, user.id, batches(digest), 'fixture-only'))!;
      assert.equal(await readCachedSummary(db, user.id, run.id, paper, HTML_EXTRACTOR), undefined);
      await failGeneration(db, user.id, run.id);
      assert.equal(await savePaperVector(db, user.id, run.id, paper, vector()), undefined);
      assert.equal(await saveCachedSummary(db, user.id, run.id, paper, HTML_EXTRACTOR, { summary: 'Stale work cannot create content.' }), undefined);
      await saveConfig(db, owner.id, 2, config.replace('run_input_tokens = 500000', 'run_input_tokens = 600000'));
      run = (await freezeGenerationInputs(db, user.id, batches(digest), 'fixture-only'))!;
      assert.deepEqual(await readCachedSummary(db, user.id, run.id, paper, HTML_EXTRACTOR), cached); // Budgets do not change content identity.
      await failGeneration(db, user.id, run.id);
      await saveConfig(db, owner.id, 3, config.replace('max_completion_tokens = 2048', 'max_completion_tokens = 1024'));
      run = (await freezeGenerationInputs(db, user.id, batches(digest), 'fixture-only'))!;
      assert.equal(await readCachedSummary(db, user.id, run.id, paper, HTML_EXTRACTOR), undefined);
      await failGeneration(db, user.id, run.id);
    });

    await t.test('publication copies summary text; private profile reuse survives replacement and honors frozen subjects', async () => {
      digest.summaries = { [paper.id]: { paperId: paper.id, version: paper.version, status: 'available',
        summary: cached.summary, cacheKey: cached.cacheKey, createdAt: cached.createdAt } };
      await stagePublication(db, owner.id, a.id, digest); await publishGeneration(db, owner.id, a.id);
      const before = await readReading(db, owner.id);
      await db.prepare('DELETE FROM summary_cache WHERE cache_key = ?').bind(cached.cacheKey).run();
      assert.deepEqual(await readReading(db, owner.id), before);
      assert.equal(await saveUserVote(db, owner.id, a.id, paper.id, 1), true);
      const next = structuredClone(digest); next.date = '2030-01-01';
      next.papers.find(p => p.id === paper.id)!.version = 2;
      const run = (await freezeGenerationInputs(db, owner.id, batches(next), 'fixture-only'))!;
      assert.deepEqual(await readProfileVector(db, owner.id, run.id, profile), vector());
      assert.ok(await readPaperVector(db, owner.id, run.id, paper, true)); // Frozen voted version 1.
      assert.equal(await readPaperVector(db, owner.id, run.id, { ...paper, version: 2 }), undefined);
      await savePaperVector(db, owner.id, run.id, { ...paper, version: 2 }, vector(4));
      const interests = (await readSavedInterests(db, owner.id))!;
      await saveInterests(db, owner.id, interests.revision, interests.text.replaceAll('### Subjects', '### Subjects\n- New scientific subject for the next run'));
      assert.deepEqual(await readProfileVector(db, owner.id, run.id, profile), vector());
      await failGeneration(db, owner.id, run.id);
      const changed = (await freezeGenerationInputs(db, owner.id, batches(next), 'fixture-only'))!;
      assert.equal(await readProfileVector(db, owner.id, changed.id, profile), undefined);
      await failGeneration(db, owner.id, changed.id);
      assert.equal((await cleanupHostedState(db)).complete, true);
      assert.deepEqual(await readProfileVector(db, owner.id, a.id, profile), vector());
      assert.ok(await readPaperVector(db, friend.id, b.id, paper));
      assert.deepEqual(await readReading(db, owner.id), before);
    });

    await t.test('SQL interruption cannot expose a partial cache record; cache reads reject corrupt vectors', async () => {
      const target = digest.papers.find(p => p.id !== paper.id)!;
      await db.prepare(`CREATE TRIGGER interrupt_vector BEFORE INSERT ON paper_vectors
        BEGIN SELECT RAISE(ABORT, 'cache insertion interrupted'); END`).run();
      await assert.rejects(savePaperVector(db, friend.id, b.id, target, vector()), /cache insertion interrupted/);
      await db.prepare('DROP TRIGGER interrupt_vector').run();
      assert.equal(await readPaperVector(db, friend.id, b.id, target), undefined);
      assert.deepEqual(await savePaperVector(db, friend.id, b.id, target, vector()), vector());
      await db.prepare('UPDATE paper_vectors SET vector_json = ? WHERE paper_id = ?').bind('[1,0]', target.id).run();
      await assert.rejects(readPaperVector(db, friend.id, b.id, target), /normalized 384/);
      await db.prepare('UPDATE paper_vectors SET vector_json = ? WHERE paper_id = ?').bind(JSON.stringify(vector()), target.id).run();
      await db.prepare(`CREATE TRIGGER interrupt_summary BEFORE INSERT ON summary_cache
        BEGIN SELECT RAISE(ABORT, 'summary insertion interrupted'); END`).run();
      await assert.rejects(saveCachedSummary(db, friend.id, b.id, paper, HTML_EXTRACTOR, { summary: 'A completed scientific result.' }), /summary insertion interrupted/);
      await db.prepare('DROP TRIGGER interrupt_summary').run();
      assert.equal(await readCachedSummary(db, friend.id, b.id, paper, HTML_EXTRACTOR), undefined);
      assert.ok(await saveCachedSummary(db, friend.id, b.id, paper, HTML_EXTRACTOR, { summary: 'A completed scientific result.' }));
    });

    await t.test('cleanup preserves all live users and active voted vectors, then expires unneeded caches', async () => {
      await saveCachedSummary(db, friend.id, b.id, paper, HTML_EXTRACTOR, { summary: 'A completed cache entry for retention testing.' });
      await cleanupHostedState(db);
      assert.ok(await readCachedSummary(db, friend.id, b.id, paper, HTML_EXTRACTOR));
      await failGeneration(db, friend.id, b.id);
      await cleanupHostedState(db);
      assert.equal(await count('summary_cache'), 1); // Owner still has the current paper.
      const empty = { date: '2030-03-01', categories: ['quant-ph'], papers: [], featuredIds: [] };
      await publishFixture(db, owner.id, empty); await publishFixture(db, friend.id, empty);
      assert.equal((await cleanupHostedState(db)).complete, true);
      assert.equal(await count('summary_cache'), 0);
      assert.equal(await count('generation_profile_vectors'), 0);
      const kept = (await db.prepare('SELECT paper_id, version FROM paper_vectors').all<{ paper_id: string; version: number }>()).results;
      assert.ok(kept.length > 0);
      assert.ok(kept.every(v => v.paper_id === paper.id && v.version === 1));
      assert.equal((await cleanupHostedState(db, new Date(Date.now() + 366 * 86400000))).complete, true);
      assert.equal(await count('paper_vectors'), 0);
    });
  } finally { await fixture.close(); }
});
