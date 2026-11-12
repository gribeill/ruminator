// Copyright 2026 Guilhem Ribeill
// SPDX-License-Identifier: Apache-2.0

import type { Profile } from './profile-text.ts';
import type { PaperScore } from './semantic-types.ts';

/** Fixed scale, not daily min-max scaling or a calibrated probability. */
export function visibleScore(cosine: number): number {
  if (!Number.isFinite(cosine)) throw new Error('Non-finite cosine similarity');
  return (Math.max(-1, Math.min(1, cosine)) + 1) / 2;
}
export function scorePaper(profiles: Profile[], queries: number[][], vector: number[]): PaperScore {
  if (!profiles.length || profiles.length !== queries.length || queries.some(q => q.length !== vector.length)) throw new Error('Incompatible semantic vectors');
  const similarities = queries.map(query => Math.max(-1, Math.min(1, query.reduce((sum, v, i) => sum + v * vector[i], 0))));
  const best = similarities.indexOf(Math.max(...similarities));
  return { score: visibleScore(similarities[best]), cosine: similarities[best], profileId: profiles[best].id,
    similarities: Object.fromEntries(profiles.map((profile, i) => [profile.id, similarities[i]])) };
}
