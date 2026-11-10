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

import type { Paper } from './arxiv.ts';
import { seededRandom, type Digest } from './digest.ts';
import type { Profile } from './profiles.ts';
import type { SemanticScores } from './scoring.ts';
import { feedbackScore, type FeedbackSnapshot } from './feedback.ts';

export interface ScoreWeights {
  semantic: number;
  keywords: number;
  feedback: number;
}

export const DEFAULT_WEIGHTS: Readonly<ScoreWeights> = { semantic: 0.60, keywords: 0.25, feedback: 0.15 };

/** Reject rather than silently normalize weights, keeping saved scores interpretable. */
export function validateWeights(weights: ScoreWeights): void {
  const values = [weights.semantic, weights.keywords, weights.feedback];
  if (values.some(v => typeof v !== 'number' || !Number.isFinite(v) || v < 0) ||
      Math.abs(values.reduce((a, b) => a + b, 0) - 1) > 1e-9) {
    throw new Error('scoring.weights must be nonnegative finite numbers summing to 1');
  }
}

export const RANKING_CONFIG = {
  version: 'explicit-feedback-mmr-v3',
  weights: DEFAULT_WEIGHTS,
  feedback: 0.5,
  keywordSaturation: 2,
  topRedundancy: 0.04,
  nearDuplicate: 0.95,
  adjacentKeywordPenalty: 0.35,
  adjacentRedundancy: 0.15,
  adjacentNewProfileBonus: 0.05,
  wildcardUniform: 0.5,
  wildcardTemperature: 0.05,
  mmrRelevance: 0.7,
  mmrJitter: 0.005,
} as const;

export interface RelevanceScore {
  semantic: number;
  keywords: number;
  feedback: number;
  total: number;
  matchedKeywords: string[];
}

export interface Ranking {
  config: typeof RANKING_CONFIG;
  scores: Record<string, RelevanceScore>;
  keywordProfiles: { id: string; keywords: string[] }[];
  featured: { id: string; role: 'relevant' | 'adjacent' | 'wildcard' }[];
  remainingIds: string[];
  mmrScores: Record<string, number>;
  feedbackSnapshot?: FeedbackSnapshot;
}

function tokens(text: string): string[] {
  return (text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().match(/[a-z0-9]+/g) ?? [])
    .map(word => word.length > 4 && word.endsWith('s') && !/(ss|us|is)$/.test(word) ? word.slice(0, -1) : word);
}

/** Match only explicitly listed phrases, counting aliases/repetitions once per group. */
export function keywordScore(paper: Paper, profiles: Profile[]): { score: number; matchedKeywords: string[] } {
  if (!profiles.length) return { score: 0.5, matchedKeywords: [] };
  const title = ` ${tokens(paper.title).join(' ')} `;
  const abstract = ` ${tokens(paper.abstract).join(' ')} `;
  let best = { score: -1, matchedKeywords: [] as string[] };
  for (const profile of profiles) {
    let evidence = 0;
    const matchedKeywords: string[] = [];
    const seen = new Set<string>();
    for (const group of profile.keywords ?? []) {
      let hit = 0;
      for (const alias of group.split(';')) {
        const phrase = tokens(alias).join(' ');
        if (!phrase || seen.has(phrase)) continue;
        seen.add(phrase);
        hit = Math.max(hit, title.includes(` ${phrase} `) ? 2 : abstract.includes(` ${phrase} `) ? 1 : 0);
      }
      evidence += hit;
      if (hit) matchedKeywords.push(group);
    }
    // An unspecified lexical preference is neutral, not evidence of a mismatch.
    const score = seen.size ? 1 - Math.exp(-evidence / RANKING_CONFIG.keywordSaturation) : 0.5;
    if (score > best.score) best = { score, matchedKeywords };
  }
  return best;
}

/** Uniform mass preserves a nonzero chance for even the least similar paper. */
export function wildcardProbabilities(semanticScores: number[], temperature: number = RANKING_CONFIG.wildcardTemperature): number[] {
  if (!semanticScores.length) return [];
  if (!(temperature > 0) || semanticScores.some(s => !Number.isFinite(s))) throw new Error('Invalid wildcard scores or temperature');
  const max = Math.max(...semanticScores);
  const weights = semanticScores.map(s => Math.exp((s - max) / temperature));
  const sum = weights.reduce((a, b) => a + b, 0);
  const uniform = RANKING_CONFIG.wildcardUniform;
  return weights.map(w => uniform / weights.length + (1 - uniform) * w / sum);
}

/** Pure selection/order calculation; normalized vectors must share one model. */
export function rankPapers(digest: Digest, semantic: SemanticScores, vectors: Record<string, number[]>, keywordProfiles: Profile[] = semantic.profiles, weights: ScoreWeights = DEFAULT_WEIGHTS, feedback?: FeedbackSnapshot): Ranking {
  validateWeights(weights);
  const config = { ...RANKING_CONFIG, weights: { ...weights } };
  if (feedback && feedback.fingerprint !== semantic.fingerprint) throw new Error('Incompatible feedback embedding model');
  const ids = digest.papers.map(p => p.id).sort();
  if (new Set(ids).size !== ids.length) throw new Error('Duplicate paper IDs in ranking input');
  const dimensions = ids.length ? vectors[ids[0]]?.length : 0;
  for (const id of ids) {
    if (!semantic.papers[id] || !Number.isFinite(semantic.papers[id].score) ||
        semantic.papers[id].score < 0 || semantic.papers[id].score > 1 ||
        !vectors[id]?.length || vectors[id].length !== dimensions ||
        vectors[id].some(v => !Number.isFinite(v)) || Math.abs(Math.hypot(...vectors[id]) - 1) > 1e-5) {
      throw new Error(`Missing or invalid scoring data for ${id}`);
    }
  }
  const scores: Record<string, RelevanceScore> = {};
  for (const paper of digest.papers) {
    const keywords = keywordScore(paper, keywordProfiles);
    const s = semantic.papers[paper.id].score;
    const f = feedback ? feedbackScore(vectors[paper.id], feedback.examples, feedback.config) : RANKING_CONFIG.feedback;
    scores[paper.id] = {
      semantic: s, keywords: keywords.score, feedback: f,
      total: weights.semantic * s + weights.keywords * keywords.score + weights.feedback * f,
      matchedKeywords: keywords.matchedKeywords,
    };
  }
  const similarity = (a: string, b: string) => Math.max(0, Math.min(1,
    vectors[a].reduce((sum, value, i) => sum + value * vectors[b][i], 0)));
  const redundancy = (id: string, selected: string[]) => Math.max(0, ...selected.map(other => similarity(id, other)));
  const titles = new Map(digest.papers.map(p => [p.id, tokens(p.title).join(' ')]));
  const featured: Ranking['featured'] = [];
  const selected = () => featured.map(p => p.id);
  const remaining = () => ids.filter(id => !featured.some(p => p.id === id));
  const candidates = () => {
    const available = remaining();
    const diverse = available.filter(id => selected().every(other =>
      titles.get(id) !== titles.get(other) && similarity(id, other) < RANKING_CONFIG.nearDuplicate));
    // Tiny or highly redundant batches still get up to six distinct paper IDs.
    return diverse.length ? diverse : available;
  };
  const best = (pool: string[], objective: (id: string) => number) => {
    let winner = pool[0];
    for (const id of pool.slice(1)) if (objective(id) > objective(winner)) winner = id;
    return winner; // Sorted IDs break ties independently of feed/input order.
  };
  for (let i = 0; i < Math.min(4, ids.length); i++) {
    const id = best(candidates(), id => scores[id].total - RANKING_CONFIG.topRedundancy * redundancy(id, selected()));
    featured.push({ id, role: 'relevant' });
  }
  if (remaining().length) {
    const represented = new Set(selected().map(id => semantic.papers[id].profileId));
    const id = best(candidates(), id => scores[id].semantic - RANKING_CONFIG.adjacentKeywordPenalty * scores[id].keywords
      - RANKING_CONFIG.adjacentRedundancy * redundancy(id, selected())
      + (represented.has(semantic.papers[id].profileId) ? 0 : RANKING_CONFIG.adjacentNewProfileBonus));
    featured.push({ id, role: 'adjacent' });
  }
  const seed = `${digest.date}:${[...digest.categories].sort().join(',')}`;
  if (remaining().length) {
    const pool = candidates();
    const probabilities = wildcardProbabilities(pool.map(id => scores[id].semantic));
    let draw = seededRandom(`${seed}:wildcard`)();
    let id = pool[pool.length - 1];
    for (let i = 0; i < pool.length; i++) {
      draw -= probabilities[i];
      if (draw < 0) { id = pool[i]; break; }
    }
    featured.push({ id, role: 'wildcard' });
  }
  const ordered = selected();
  const remainingIds: string[] = [];
  const pool = new Set(remaining());
  const mmrScores: Record<string, number> = {};
  // Incremental maxima avoid recomputing every previous comparison at each step.
  const maxRedundancy = Object.fromEntries([...pool].map(id => [id, redundancy(id, ordered)]));
  const noise = Object.fromEntries(ids.map(id => [id,
    (2 * seededRandom(`${seed}:mmr:${id}`)() - 1) * RANKING_CONFIG.mmrJitter]));
  while (pool.size) {
    const objective = (id: string) => RANKING_CONFIG.mmrRelevance * scores[id].total
      - (1 - RANKING_CONFIG.mmrRelevance) * maxRedundancy[id] + noise[id];
    const id = best([...pool], objective);
    mmrScores[id] = objective(id);
    remainingIds.push(id);
    ordered.push(id);
    pool.delete(id);
    for (const other of pool) maxRedundancy[other] = Math.max(maxRedundancy[other], similarity(other, id));
  }
  return { config, scores,
    keywordProfiles: keywordProfiles.map(p => ({ id: p.id, keywords: [...(p.keywords ?? [])] })),
    featured, remainingIds, mmrScores, ...(feedback ? { feedbackSnapshot: feedback } : {}) };
}
