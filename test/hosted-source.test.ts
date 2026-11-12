// Copyright 2026 Guilhem Ribeill
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { Paper } from '../src/arxiv.ts';
import { extractArxivHtml } from '../src/html-extraction.ts';
import { HTML_EXTRACTOR, MAX_HTML_BYTES, type CachedPaperText } from '../src/fulltext-types.ts';
import { fixtureDigest, publishFixture, startHostedFixture } from '../scripts/hosted-fixtures.ts';
import { freezeFixtureInputs as freezeGenerationInputs } from '../scripts/hosted-fixtures.ts';
import { initializeSavedConfig } from '../src/hosted/saved-inputs.ts';
import { saveSourcePaper, readSourcePaper, saveSourceText, readSourceText, readSourceHtml } from '../src/hosted/source-store.ts';
import { stagePublication, publishGeneration, failGeneration } from '../src/hosted/publication.ts';
import { cleanupHostedState } from '../src/hosted/retention.ts';
import { provisionUser, saveUserVote, readReading } from '../src/hosted/reading-store.ts';

const html = readFileSync(new URL('./fixtures/paper-unsectioned.html', import.meta.url), 'utf8');
const config = readFileSync(new URL('../config.toml', import.meta.url), 'utf8');
function extracted(paper: Paper, body = html, extractor = HTML_EXTRACTOR): CachedPaperText {
  const text = extractArxivHtml(body);
  return { html: body, result: { paperId: paper.id, version: paper.version, status: 'available', extractor,
    sourceUrl: `https://arxiv.org/html/${paper.id}v${paper.version}`, checkedAt: new Date().toISOString(),
    text, contentHash: createHash('sha256').update(text).digest('hex') } };
}

test('hosted shared source storage: versioned metadata, bounded text, cached failures, and cross-user retention', { timeout: 180000 }, async t => {
  const fixture = await startHostedFixture();
  const { db, owner, friend } = fixture;
  const scalar = async (sql: string, ...args: (string | number)[]) => (await db.prepare(sql).bind(...args).raw<[number]>())[0][0];
  try {
    await initializeSavedConfig(db, config);
    const digest = fixtureDigest('Shared scientific input'); digest.summaries = {};
    const paper = digest.papers[0]; paper.version = 2;
    const batch = [{ category: 'quant-ph', date: digest.date, sourceUrl: 'fixture', papers: digest.papers }];
    const a = (await freezeGenerationInputs(db, owner.id, batch, 'fixture-only'))!;
    const b = (await freezeGenerationInputs(db, friend.id, batch, 'fixture-only'))!;
    const failure: CachedPaperText = { html, result: { paperId: paper.id, version: paper.version, status: 'unavailable',
      sourceUrl: `https://arxiv.org/html/${paper.id}v${paper.version}`, checkedAt: '2026-01-01T00:00:00Z',
      extractor: 'old-extractor', reason: 'Old extractor cannot handle an unsectioned article' } };
    let failureId = '', successId = '';

    await t.test('frozen membership is indexed across bounded identity pages', async () => {
      const user = (await provisionUser(db, fixture.access.identity('new@example.test')))!;
      const papers = Array.from({ length: 33 }, (_, i) => ({ ...paper, id: `2601.${String(i).padStart(5, '0')}` }));
      const run = (await freezeGenerationInputs(db, user.id, [{ ...batch[0], papers }], 'fixture-only'))!;
      assert.equal(await scalar('SELECT count(*) FROM generation_paper_refs WHERE generation_id = ?', run.id), 33);
      assert.deepEqual(run.batches![0].papers, papers);
      await failGeneration(db, user.id, run.id);
    });

    await t.test('shared metadata and failure hits are versioned and do not silently retry', async () => {
      assert.equal(await saveSourcePaper(db, owner.id, a.id, paper), true);
      assert.deepEqual(await readSourcePaper(db, paper), paper);
      assert.equal(await readSourcePaper(db, { id: paper.id, version: 1 }), undefined);
      assert.equal(await saveSourcePaper(db, owner.id, a.id, { ...paper, version: 99 }), false);
      const saved = (await saveSourceText(db, owner.id, a.id, paper, failure))!;
      failureId = saved.id;
      assert.equal(saved.result.status, 'unavailable');
      assert.equal(saved.html, html);
      assert.deepEqual(await readSourceText(db, friend.id, b.id, paper, 'old-extractor'), saved);
      const repaired = extracted(paper, html, 'old-extractor');
      assert.deepEqual(await saveSourceText(db, owner.id, a.id, paper, repaired), saved);
      assert.equal(await readSourceText(db, owner.id, a.id, { id: paper.id, version: 1 }, 'old-extractor'), undefined);
      assert.equal(await scalar('SELECT count(*) FROM source_blobs'), 1);
    });

    await t.test('explicit retry retains raw HTML on another failure and preserves other users pins', async () => {
      const again: CachedPaperText = { html: null, result: { ...failure.result,
        checkedAt: '2026-01-02T00:00:00Z', reason: 'Explicit download retry failed' } };
      const retained = (await saveSourceText(db, owner.id, a.id, paper, again, { retryUnavailable: true }))!;
      assert.equal(retained.html, html);
      assert.equal(retained.result.reason, again.result.reason);
      assert.equal((await readSourceText(db, friend.id, b.id, paper, 'old-extractor'))!.id, failureId);
      const success = (await saveSourceText(db, owner.id, a.id, paper, extracted(paper, html, 'old-extractor'), { retryUnavailable: true }))!;
      successId = success.id;
      assert.equal(success.result.text, extractArxivHtml(html));
      assert.equal(success.result.contentHash, createHash('sha256').update(success.result.text!).digest('hex'));
      // Failure retries cannot downgrade a successful immutable association.
      assert.deepEqual(await saveSourceText(db, owner.id, a.id, paper, again, { retryUnavailable: true }), success);
      const raw = (await readSourceHtml(db, friend.id, b.id, paper))!;
      assert.equal(raw.id, failureId);
      assert.equal(raw.html, html);
      const reextracted = (await saveSourceText(db, friend.id, b.id, paper, extracted(paper, raw.html!)))!;
      assert.equal(reextracted.result.extractor, HTML_EXTRACTOR);
      assert.equal(reextracted.result.contentHash, success.result.contentHash);
      // Different extractor outcomes share identical raw/extracted byte objects.
      assert.equal(await scalar('SELECT count(*) FROM source_blobs'), 2);
    });

    await t.test('concurrent compatible writes share immutable content without mixing users', async () => {
      const input = extracted(paper, html, 'concurrent-extractor');
      const [left, right] = await Promise.all([
        saveSourceText(db, owner.id, a.id, paper, input), saveSourceText(db, friend.id, b.id, paper, input),
      ]);
      assert.deepEqual(left, right);
      assert.equal(await scalar('SELECT count(*) FROM source_blobs'), 2);
      assert.equal(await readSourceText(db, friend.id, a.id, paper, 'concurrent-extractor'), undefined);
      assert.equal(await saveSourcePaper(db, friend.id, a.id, paper), false);
      await db.prepare('UPDATE users SET enabled = 0 WHERE id = ?').bind(friend.id).run();
      assert.equal(await readSourceText(db, friend.id, b.id, paper, 'concurrent-extractor'), undefined);
      assert.equal(await saveSourcePaper(db, friend.id, b.id, paper), false);
      await db.prepare('UPDATE users SET enabled = 1 WHERE id = ?').bind(friend.id).run();
    });

    await t.test('multi-page Unicode content resumes after interruption, verifies hashes, and rejects truncation', async () => {
      const target = digest.papers[1];
      const large = html.replace('</article>', `<div class="ltx_para"><p>${'é漢🔬 quantum '.repeat(160000)}</p></div></article>`);
      const input = extracted(target, large);
      await db.prepare(`CREATE TRIGGER interrupt_source BEFORE INSERT ON source_blob_chunks
        WHEN NEW.ordinal = 8 BEGIN SELECT RAISE(ABORT, 'interrupted source write'); END`).run();
      await assert.rejects(saveSourceText(db, owner.id, a.id, target, input), /interrupted source write/);
      await db.prepare('DROP TRIGGER interrupt_source').run();
      assert.equal(await readSourceText(db, owner.id, a.id, target, HTML_EXTRACTOR), undefined);
      assert.equal(await scalar('SELECT count(*) FROM source_text_cache WHERE paper_id = ?', target.id), 0);
      const rawHash = createHash('sha256').update(large).digest('hex');
      assert.equal(await scalar('SELECT count(*) FROM source_blob_chunks WHERE hash = ?', rawHash), 8);
      await cleanupHostedState(db);
      assert.equal(await scalar('SELECT count(*) FROM source_blob_chunks WHERE hash = ?', rawHash), 8);
      await assert.rejects(saveSourceText(db, owner.id, a.id, target, extracted(target, large + '\n')), /original content/);
      const later = structuredClone(input); later.result.checkedAt = '2030-01-01T00:00:00Z';
      const resumed = (await saveSourceText(db, owner.id, a.id, target, later))!;
      assert.equal(resumed.html, large);
      assert.equal(resumed.result.text, input.result.text);
      assert.equal(resumed.result.checkedAt, input.result.checkedAt);
      assert.equal(await scalar('SELECT max(length(bytes)) FROM source_blob_chunks WHERE hash = ?', rawHash), 262144);
      const original = (await db.prepare('SELECT bytes FROM source_blob_chunks WHERE hash = ? AND ordinal = 0')
        .bind(rawHash).first<{ bytes: number[] }>())!;
      const corrupt = new Uint8Array(original.bytes); corrupt[10] ^= 1;
      await db.prepare('UPDATE source_blob_chunks SET bytes = ? WHERE hash = ? AND ordinal = 0').bind(corrupt.buffer, rawHash).run();
      await assert.rejects(readSourceText(db, owner.id, a.id, target, HTML_EXTRACTOR), /checksum mismatch/);
      await db.prepare('UPDATE source_blob_chunks SET bytes = ? WHERE hash = ? AND ordinal = 0')
        .bind(new Uint8Array(original.bytes).buffer, rawHash).run();
      const oversized = extracted(target, html, 'oversized'); oversized.html = 'x'.repeat(MAX_HTML_BYTES + 1);
      await assert.rejects(saveSourceText(db, owner.id, a.id, target, oversized), /16 MiB/);
      const wrongHash = extracted(target, html, 'wrong-hash'); wrongHash.result.contentHash = 'not-the-hash';
      await assert.rejects(saveSourceText(db, owner.id, a.id, target, wrongHash), /hash mismatch/);
    });

    await t.test('verified raw HTML remains recoverable if extracted-text persistence is interrupted', async () => {
      const target = digest.papers[2];
      const body = html.replace('</article>', '<div class="ltx_para"><p>Additional experimental qualifications require a separate extraction record.</p></div></article>');
      const input = extracted(target, body);
      await db.prepare(`CREATE TRIGGER interrupt_extracted_text BEFORE INSERT ON source_blob_chunks
        WHEN NEW.hash = '${input.result.contentHash}' BEGIN SELECT RAISE(ABORT, 'text persistence interrupted'); END`).run();
      await assert.rejects(saveSourceText(db, owner.id, a.id, target, input), /text persistence interrupted/);
      await db.prepare('DROP TRIGGER interrupt_extracted_text').run();
      assert.equal(await readSourceText(db, owner.id, a.id, target, HTML_EXTRACTOR), undefined);
      await cleanupHostedState(db);
      const raw = (await readSourceHtml(db, owner.id, a.id, target))!;
      assert.equal(raw.html, body);
      assert.equal(raw.contentHash, createHash('sha256').update(body).digest('hex'));
      const restored = (await saveSourceText(db, owner.id, a.id, target, extracted(target, raw.html)))!;
      assert.equal(restored.result.text, input.result.text);
      assert.equal(restored.result.checkedAt, input.result.checkedAt);
    });

    await t.test('publication preserves its source pins; new paper versions cannot reuse wrong-version outcomes', async () => {
      await stagePublication(db, owner.id, a.id, digest);
      await publishGeneration(db, owner.id, a.id);
      assert.equal((await readSourceText(db, owner.id, a.id, paper, 'old-extractor'))!.id, successId);
      assert.equal((await readSourceHtml(db, owner.id, a.id, paper))!.html, html);
      assert.equal(await saveSourceText(db, owner.id, a.id, paper, extracted(paper, html, 'new-after-publication')), undefined);
      const user = (await provisionUser(db, fixture.access.identity('new@example.test')))!;
      const version3 = structuredClone(digest); version3.papers[0].version = 3;
      const c = (await freezeGenerationInputs(db, user.id, [{ ...batch[0], papers: version3.papers }], 'fixture-only'))!;
      assert.equal(await readSourceText(db, user.id, c.id, version3.papers[0], 'old-extractor'), undefined);
      const saved = (await saveSourceText(db, user.id, c.id, version3.papers[0], extracted(version3.papers[0], html, 'old-extractor')))!;
      assert.equal(saved.result.version, 3);
      assert.equal((await readSourcePaper(db, paper))!.version, 2);
      assert.equal((await readSourcePaper(db, version3.papers[0]))!.version, 3);
      await failGeneration(db, user.id, c.id);
    });

    await t.test('cleanup shares live content across users, keeps only voted metadata afterward, then expires it', async () => {
      await failGeneration(db, friend.id, b.id);
      assert.equal((await cleanupHostedState(db)).complete, true);
      assert.equal((await readSourceText(db, owner.id, a.id, paper, 'old-extractor'))!.id, successId);
      assert.equal(await scalar('SELECT count(*) FROM source_texts WHERE id = ?', failureId), 0);
      assert.equal(await readSourcePaper(db, { id: paper.id, version: 3 }), undefined);
      const current = (await readReading(db, owner.id))!;
      assert.equal(await saveUserVote(db, owner.id, current.generationId, paper.id, 1), true);
      // Move both readers to an empty listing: no scientific full text is needed.
      const empty = { date: '2030-03-01', categories: ['quant-ph'], papers: [], featuredIds: [] };
      await publishFixture(db, owner.id, empty); await publishFixture(db, friend.id, empty);
      assert.equal((await cleanupHostedState(db)).complete, true);
      assert.equal(await scalar('SELECT count(*) FROM source_texts'), 0);
      assert.equal(await scalar('SELECT count(*) FROM source_blobs'), 0);
      assert.equal(await scalar('SELECT count(*) FROM source_blob_chunks'), 0);
      assert.equal(await scalar('SELECT count(*) FROM source_papers'), 1);
      assert.deepEqual(await readSourcePaper(db, paper), paper);
      const changed = (await db.prepare('SELECT changed_at FROM user_votes WHERE user_id = ? AND paper_id = ?')
        .bind(owner.id, paper.id).first<{ changed_at: string }>())!.changed_at;
      await cleanupHostedState(db);
      assert.equal((await db.prepare('SELECT changed_at FROM user_votes WHERE user_id = ? AND paper_id = ?')
        .bind(owner.id, paper.id).first<{ changed_at: string }>())!.changed_at, changed);
      assert.equal((await cleanupHostedState(db, new Date(Date.now() + 366 * 86400000))).complete, true);
      assert.equal(await readSourcePaper(db, paper), undefined);
    });
  } finally { await fixture.close(); }
});
