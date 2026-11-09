import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseFeed } from '../src/arxiv.ts';
import { createBgeProvider } from '../src/bge.ts';
import { averageVectors, normalize, splitChunks, type EmbeddingProvider, type Tokenizer } from '../src/embeddings.ts';
import { cachedEmbedding, scoreDigest, visibleScore } from '../src/scoring.ts';
import { latestDigest, openAppDatabase, readSemanticScores, saveDigest, saveSemanticScores } from '../src/store.ts';
import { renderDigest } from '../src/render.ts';

const batch = parseFeed(readFileSync(new URL('./fixtures/quant-ph.xml', import.meta.url), 'utf8'), 'quant-ph');
const profiles = [
  { id: 'hardware', title: 'Hardware', subjects: ['Superconducting circuits'] },
  { id: 'sensing', title: 'Sensing', subjects: ['Spin defects'] },
];
const log = () => {};

function wordTokenizer(): Tokenizer {
  const words: string[] = [];
  return {
    encode(text) { return text.split(/\s+/).filter(Boolean).map(word => {
      let id = words.indexOf(word);
      if (id < 0) { id = words.length; words.push(word); }
      return id;
    }); },
    decode(ids) { return ids.map(id => words[id]).join(' '); },
  };
}

test('chunking preserves all content, respects special-token/title budget, and retains short sentences', () => {
  const tokenizer = wordTokenizer();
  const prefix = 'Title words\n\n';
  const text = 'One two. Three four. Five six seven eight nine ten eleven twelve.';
  const chunks = splitChunks(prefix, text, tokenizer, 8);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every(chunk => chunk.startsWith(prefix) && tokenizer.encode(chunk).length + 2 <= 8));
  assert.equal(chunks[0], prefix + 'One two. Three four.');
  assert.equal(chunks.map(chunk => chunk.slice(prefix.length)).join(' '), text);
  assert.deepEqual(splitChunks(prefix, '', tokenizer, 8), [prefix]);
  assert.throws(() => splitChunks('too many title words here ', text, tokenizer, 4), /title/);
});

test('offline model initialization fails clearly when assets are missing', async () => {
  await assert.rejects(createBgeProvider({ offline: true, cacheDir: 'test/fixtures/missing-model-cache' }), /not cached/);
});

test('vector validation, aggregation, and fixed score normalization', () => {
  assert.deepEqual(normalize([3, 4]), [0.6, 0.8]);
  assert.deepEqual(averageVectors([[1, 0], [0, 1]], 2), normalize([1, 1]));
  for (const vector of [[0, 0], [NaN, 1], [Infinity, 1], [1]]) assert.throws(() => normalize(vector, 2));
  assert.equal(visibleScore(-1), 0);
  assert.equal(visibleScore(0), 0.5);
  assert.equal(visibleScore(1), 1);
  assert.equal(visibleScore(0.6), 0.8);
  assert.throws(() => visibleScore(NaN));
});

test('SQLite vector cache isolates models, content edits, and input roles', async () => {
  const db = openAppDatabase(':memory:');
  let calls = 0;
  const provider: EmbeddingProvider = {
    fingerprint: 'model-a', dimensions: 2,
    async embed() { calls++; return [3, 4]; },
  };
  const input = { kind: 'paper' as const, title: 'Qubits', text: 'Abstract' };
  try {
    assert.deepEqual(await cachedEmbedding(db, provider, input), [0.6, 0.8]);
    await cachedEmbedding(db, provider, input);
    assert.equal(calls, 1);
    await cachedEmbedding(db, provider, { ...input, text: 'Changed abstract' });
    await cachedEmbedding(db, provider, { ...input, kind: 'profile' });
    await cachedEmbedding(db, { ...provider, fingerprint: 'model-b' }, input);
    assert.equal(calls, 4);
    await assert.rejects(cachedEmbedding(db, { ...provider, fingerprint: 'invalid', embed: async () => [NaN, 0] }, input), /Invalid/);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM embeddings WHERE fingerprint = ?').get('invalid')?.n, 0);
  } finally { db.close(); }
});

test('scores use the strongest profile, render on every entry, and remain fixed after publication', async () => {
  const db = openAppDatabase(':memory:');
  let calls = 0;
  let disposed = false;
  const provider: EmbeddingProvider = {
    fingerprint: 'test-model', dimensions: 2,
    async embed(input) {
      calls++;
      if (input.title === 'Hardware') return [1, 0];
      if (input.title === 'Sensing') return [0, 1];
      return [0.6, 0.8];
    },
    async dispose() { disposed = true; },
  };
  try {
    const digest = saveDigest(db, [batch]);
    const scored = await scoreDigest(db, digest, profiles, async () => provider, log);
    assert.ok(disposed);
    assert.equal(calls, batch.papers.length + profiles.length);
    const first = scored.semantic!.papers[batch.papers[0].id];
    assert.equal(first.score, 0.9);
    assert.equal(first.cosine, 0.8);
    assert.equal(first.profileId, 'sensing');
    assert.deepEqual(first.similarities, { hardware: 0.6, sensing: 0.8 });
    assert.deepEqual(scored.featuredIds, digest.featuredIds);
    assert.deepEqual(scored.papers, digest.papers);
    const html = renderDigest(scored);
    assert.equal((html.match(/class="score" title=/g) ?? []).length, batch.papers.length);
    for (const paper of batch.papers) {
      assert.ok(html.includes(`>${scored.ranking!.scores[paper.id].total.toFixed(3)}</small>`));
    }
    assert.equal(scored.ranking!.featured.length, 6);
    assert.match(html, /Keywords: .*Feedback: 0.500/);
    assert.match(html, /Closest profile: Sensing/);
    assert.deepEqual(latestDigest(db, ['quant-ph']), scored);
    const again = await scoreDigest(db, digest, [{ ...profiles[0], subjects: ['Changed'] }], async () => {
      throw new Error('Published scores must not initialize the model again');
    }, log);
    assert.deepEqual(again, scored);
    // Future batches reuse paper vectors but embed modified profile text.
    const tomorrow = saveDigest(db, [{ ...batch, date: '2026-11-10' }]);
    await scoreDigest(db, tomorrow, [{ ...profiles[0], subjects: ['Changed'] }], async () => provider, log);
    assert.equal(calls, batch.papers.length + profiles.length + 1);
  } finally { db.close(); }
});

test('failed scoring leaves no partial score snapshot and resumes completed vectors', async () => {
  const db = openAppDatabase(':memory:');
  let calls = 0;
  let fail = true;
  const provider: EmbeddingProvider = {
    fingerprint: 'resume', dimensions: 2,
    async embed() {
      calls++;
      if (calls === 3 && fail) throw new Error('Interrupted');
      return [1, 0];
    },
  };
  try {
    const digest = saveDigest(db, [{ ...batch, papers: batch.papers.slice(0, 2) }]);
    await assert.rejects(scoreDigest(db, digest, profiles.slice(0, 1), async () => provider, log), /Interrupted/);
    assert.equal(readSemanticScores(db, digest), undefined);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM embeddings').get()?.n, 2);
    fail = false;
    await scoreDigest(db, digest, profiles.slice(0, 1), async () => provider, log);
    assert.equal(calls, 4);
  } finally { db.close(); }
});
