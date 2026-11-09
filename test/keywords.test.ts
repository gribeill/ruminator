import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Batch } from '../src/arxiv.ts';
import type { EmbeddingProvider } from '../src/embeddings.ts';
import { scoreDigest } from '../src/scoring.ts';
import { openAppDatabase, saveDigest, saveSemanticScores } from '../src/store.ts';

const batch: Batch = {
  category: 'quant-ph', date: '2026-11-09', sourceUrl: 'https://rss.arxiv.org/rss/quant-ph',
  papers: [{ id: '2611.00001', version: 1, title: 'Tunable couplers', abstract: 'An experimental demonstration.', categories: ['quant-ph'] }],
};
const log = () => {};

test('keyword edits change future rankings without changing semantic embeddings or published rankings', async () => {
  const db = openAppDatabase(':memory:');
  let calls = 0;
  const provider: EmbeddingProvider = {
    fingerprint: 'keyword-isolation', dimensions: 2,
    async embed() { calls++; return [1, 0]; },
  };
  const initial = [{ id: 'hardware', title: 'Hardware', subjects: ['Tunable couplers'], keywords: ['fluxonium'] }];
  const edited = [{ ...initial[0], keywords: ['tunable coupler; tunable coupling'] }];
  try {
    const digest = saveDigest(db, [batch]);
    const first = await scoreDigest(db, digest, initial, async () => provider, log);
    const id = batch.papers[0].id;
    assert.equal(first.ranking!.scores[id].keywords, 0); // Subjects are never used as keywords.
    assert.equal(calls, 2);
    const again = await scoreDigest(db, digest, edited, async () => { throw new Error('Already published'); }, log);
    assert.deepEqual(again, first);
    const future = saveDigest(db, [{ ...batch, date: '2026-11-10' }]);
    const second = await scoreDigest(db, future, edited, async () => provider, log);
    assert.equal(calls, 2); // Both query and paper vectors reused after keyword-only edit.
    assert.ok(second.ranking!.scores[id].keywords > 0.5);
    assert.equal(second.semantic!.papers[id].score, first.semantic!.papers[id].score);
    assert.deepEqual(second.ranking!.keywordProfiles, [{ id: 'hardware', keywords: edited[0].keywords }]);

    // Resume a semantic-only stage: lexical inputs must not come from the old semantic snapshot.
    const pending = saveDigest(db, [{ ...batch, date: '2026-11-11' }]);
    saveSemanticScores(db, pending, first.semantic!);
    const resumed = await scoreDigest(db, pending, edited, async () => provider, log);
    assert.equal(calls, 2);
    assert.ok(resumed.ranking!.scores[id].keywords > 0.5);
    assert.deepEqual(resumed.ranking!.keywordProfiles, second.ranking!.keywordProfiles);
  } finally { db.close(); }
});
