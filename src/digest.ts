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

import type { Batch, Paper } from './arxiv.ts';
import type { SemanticScores } from './semantic-types.ts';
import type { Ranking } from './ranking.ts';
import type { PaperSummary } from './summary-content.ts';

export interface Digest {
  date: string;
  categories: string[];
  papers: Paper[];
  featuredIds: string[];
  semantic?: SemanticScores;
  ranking?: Ranking;
  summaries?: Record<string, PaperSummary>;
}

/** Resolve the saved ranked selection for text retrieval and summarization. */
export function featuredPapers(digest: Digest): Paper[] {
  if (!digest.ranking) throw new Error('Save a ranking with npm run score before using featured papers');
  const selected = digest.ranking.featured;
  if (selected.length > 6 || new Set(selected.map(p => p.id)).size !== selected.length) throw new Error('Invalid featured selection');
  return selected.map(({ id }) => {
    const paper = digest.papers.find(p => p.id === id);
    if (!paper) throw new Error(`Missing featured paper: ${id}`);
    return paper;
  });
}

/** Separate named seeds keep daily discovery stable across page refreshes. */
export function seededRandom(seed: string): () => number {
  let state = 2166136261;
  for (const char of seed) state = Math.imul(state ^ char.charCodeAt(0), 16777619);
  return () => {
    state = (state + 0x6D2B79F5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** Merge cross-listings by identity; avoid presenting a mixed-date daily batch. */
export function createDigest(batches: Batch[]): Digest {
  if (!batches.length) throw new Error('At least one category is required');
  if (new Set(batches.map(b => b.date)).size !== 1) {
    throw new Error('Category feeds have different announcement dates; try again after the feeds update');
  }
  const categories = [...new Set(batches.map(b => b.category))].sort();
  const byId = new Map<string, Paper>();
  for (const batch of [...batches].sort((a, b) => a.category.localeCompare(b.category))) {
    for (const paper of batch.papers) {
      const existing = byId.get(paper.id);
      const newest = existing && existing.version > paper.version ? existing : paper;
      byId.set(paper.id, {
        ...newest,
        categories: [...new Set([...(existing?.categories ?? []), ...paper.categories])].sort(),
      });
    }
  }
  const papers = [...byId.values()];
  const shuffled = [...byId.keys()].sort();
  const random = seededRandom(`${batches[0].date}:${categories.join(',')}`);
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return { date: batches[0].date, categories, papers, featuredIds: shuffled.slice(0, 6) };
}
