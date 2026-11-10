/**
 * Copyright 2026 Guilhem Ribeill
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { seededRandom, type Digest } from '../src/digest.ts';
import { keywordScore, rankPapers, RANKING_CONFIG, wildcardProbabilities } from '../src/ranking.ts';
import type { SemanticScores } from '../src/scoring.ts';

function fixture(n: number) {
  const digest: Digest = {
    date: '2026-11-09', categories: ['quant-ph'], featuredIds: [],
    papers: Array.from({ length: n }, (_, i) => ({
      id: `paper-${String(i).padStart(2, '0')}`, version: 1, categories: ['quant-ph'],
      title: i < 4 ? `Tunable couplers experiment ${i}` : `Other research ${i}`, abstract: 'Scientific results.',
    })),
  };
  const vectors = Object.fromEntries(digest.papers.map((p, i) => [p.id, Array.from({ length: n }, (_, j) => Number(i === j))]));
  const semantic: SemanticScores = {
    fingerprint: 'test', normalization: 'cosine-affine-v1',
    profiles: [{ id: 'hardware', title: 'Hardware', subjects: ['Tunable couplers'], keywords: ['tunable coupler'] }],
    papers: Object.fromEntries(digest.papers.map((p, i) => [p.id, {
      score: 0.9 - i * 0.01, cosine: 0.8 - i * 0.02,
      profileId: i < 4 ? 'hardware' : 'sensing', similarities: { hardware: 0.8 - i * 0.02 },
    }])),
  };
  return { digest, semantic, vectors };
}

test('explicit phrases and aliases match whole tokens, weight titles, and cap repetitions', () => {
  const paper = fixture(1).digest.papers[0];
  const profiles = [{ id: 'hardware', title: 'Hardware', subjects: ['Other interests'], keywords: ['tunable coupler; tunable coupling'] }];
  const title = keywordScore(paper, profiles).score;
  const abstract = keywordScore({ ...paper, title: 'New results', abstract: 'A tunable coupler is demonstrated.' }, profiles).score;
  assert.ok(title > abstract && abstract > 0);
  assert.equal(keywordScore({ ...paper, title: 'Tunable couplers '.repeat(20) }, profiles).score, title);
  assert.equal(keywordScore({ ...paper, title: 'Tunable coupling and tunable couplers' }, profiles).score, title);
  assert.equal(keywordScore(paper, [{ ...profiles[0], keywords: [...profiles[0].keywords, 'tunable coupler'] }]).score, title);
  assert.equal(keywordScore({ ...paper, title: 'Tunable interaction', abstract: '' }, profiles).score, 0);
  assert.equal(keywordScore({ ...paper, title: 'Other interests', abstract: '' }, profiles).score, 0);
  assert.equal(keywordScore({ ...paper, title: 'Transmonium', abstract: '' }, [{ ...profiles[0], keywords: ['transmon'] }]).score, 0);
  assert.ok(keywordScore({ ...paper, title: 'RFSoC-based control', abstract: '' }, [{ ...profiles[0], keywords: ['rfsoc'] }]).score > 0);
  assert.ok(keywordScore({ ...paper, title: 'Quantum computing', abstract: '' }, [{ ...profiles[0], keywords: ['quantum computing'] }]).score > 0);
});

test('missing or empty keyword lists are neutral; a defined list without hits scores zero', () => {
  const paper = fixture(1).digest.papers[0];
  const profile = { id: 'hardware', title: 'Hardware', subjects: ['Tunable couplers'] };
  for (const keywords of [undefined, [], ['; ;', ' ']]) {
    assert.deepEqual(keywordScore(paper, [{ ...profile, keywords }]), { score: 0.5, matchedKeywords: [] });
  }
  assert.equal(keywordScore(paper, [{ ...profile, keywords: ['fluxonium'] }]).score, 0);
  assert.equal(keywordScore(paper, []).score, 0.5);
  // Preserve strongest-profile aggregation: an unspecified profile contributes 0.5.
  assert.equal(keywordScore(paper, [profile, { ...profile, id: 'other', keywords: ['fluxonium'] }]).score, 0.5);
});

test('combined scores and featured roles: four relevant, adjacent low-keyword match, wildcard', () => {
  const { digest, semantic, vectors } = fixture(12);
  const ranking = rankPapers(digest, semantic, vectors);
  assert.deepEqual(ranking.featured.slice(0, 4).map(p => p.id), digest.papers.slice(0, 4).map(p => p.id));
  assert.deepEqual(ranking.featured.map(p => p.role), ['relevant', 'relevant', 'relevant', 'relevant', 'adjacent', 'wildcard']);
  const adjacent = ranking.featured[4].id;
  assert.equal(ranking.scores[adjacent].keywords, 0);
  assert.equal(adjacent, 'paper-04');
  for (const score of Object.values(ranking.scores)) {
    assert.equal(score.feedback, 0.5);
    assert.equal(score.total, 0.6 * score.semantic + 0.25 * score.keywords + 0.15 * score.feedback);
    assert.ok(score.total >= 0 && score.total <= 1);
  }
});

test('deterministic seeds and tie breaks are independent of input order', () => {
  const { digest, semantic, vectors } = fixture(20);
  const first = rankPapers(digest, semantic, vectors);
  assert.deepEqual(rankPapers({ ...digest, papers: [...digest.papers].reverse() }, semantic, vectors), first);
  assert.deepEqual(rankPapers(digest, semantic, vectors), first);
  const wildcards = new Set(Array.from({ length: 10 }, (_, i) =>
    rankPapers({ ...digest, date: `2026-11-${10 + i}` }, semantic, vectors).featured[5].id));
  assert.ok(wildcards.size > 1);
});

test('near-duplicates stay out of featured slots when alternatives exist, but never disappear', () => {
  const { digest, semantic, vectors } = fixture(12);
  vectors['paper-01'] = vectors['paper-00'];
  const ranked = rankPapers(digest, semantic, vectors);
  assert.ok(ranked.featured.some(p => p.id === 'paper-00'));
  assert.ok(!ranked.featured.some(p => p.id === 'paper-01'));
  assert.ok(ranked.remainingIds.includes('paper-01'));
});

test('small and highly redundant pools fill available slots without losing or repeating papers', () => {
  for (let n = 0; n <= 8; n++) {
    const { digest, semantic, vectors } = fixture(n);
    for (const id of Object.keys(vectors)) vectors[id] = vectors[digest.papers[0].id];
    const ranked = rankPapers(digest, semantic, vectors);
    assert.equal(ranked.featured.length, Math.min(6, n));
    const all = [...ranked.featured.map(p => p.id), ...ranked.remainingIds];
    assert.equal(new Set(all).size, n);
    assert.deepEqual([...all].sort(), digest.papers.map(p => p.id).sort());
  }
});

test('wildcard probabilities mix relevance with uniform exploration, never keywords', () => {
  const probabilities = wildcardProbabilities([0, 0.5, 1]);
  assert.ok(Math.abs(probabilities.reduce((a, b) => a + b, 0) - 1) < 1e-12);
  assert.ok(probabilities.every(p => p >= 0.5 / 3));
  assert.ok(probabilities[2] > probabilities[1] && probabilities[1] > probabilities[0]);
  assert.deepEqual(wildcardProbabilities([0.7, 0.7]), [0.5, 0.5]);
  assert.deepEqual(wildcardProbabilities([]), []);
  assert.throws(() => wildcardProbabilities([NaN]));
  assert.throws(() => wildcardProbabilities([0.5], 0));
});

test('MMR uses all featured papers, then grows its comparison set; noise is fixed per candidate', () => {
  const { digest, semantic, vectors } = fixture(12);
  // A low-scoring topic alternative should precede a redundant higher-score paper.
  vectors['paper-06'] = vectors['paper-00'];
  const ranked = rankPapers(digest, semantic, vectors);
  const selected = ranked.featured.map(p => p.id);
  const pending = new Set(ranked.remainingIds);
  const seed = `${digest.date}:quant-ph`;
  const redundancy = (id: string) => Math.max(0, ...selected.map(other =>
    vectors[id].reduce((sum, v, i) => sum + v * vectors[other][i], 0)));
  const objective = (id: string) => RANKING_CONFIG.mmrRelevance * ranked.scores[id].total
    - (1 - RANKING_CONFIG.mmrRelevance) * redundancy(id)
    + (2 * seededRandom(`${seed}:mmr:${id}`)() - 1) * RANKING_CONFIG.mmrJitter;
  for (const id of ranked.remainingIds) {
    assert.ok([...pending].every(other => objective(id) >= objective(other)));
    assert.equal(ranked.mmrScores[id], objective(id));
    selected.push(id);
    pending.delete(id);
  }
  assert.equal(ranked.remainingIds.at(-1), 'paper-06');
});

test('ranking rejects missing or incompatible vectors instead of silently mixing models', () => {
  const { digest, semantic, vectors } = fixture(8);
  assert.throws(() => rankPapers(digest, semantic, {}), /invalid scoring data/);
  vectors['paper-00'] = [0, 0];
  assert.throws(() => rankPapers(digest, semantic, vectors), /invalid scoring data/);
});
