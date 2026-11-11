// Copyright 2026 Guilhem Ribeill
// SPDX-License-Identifier: Apache-2.0

import type { Profile } from './profile-text.ts';

export interface PaperScore {
  score: number;
  cosine: number;
  profileId: string;
  similarities: Record<string, number>;
}

export interface SemanticScores {
  fingerprint: string;
  normalization: 'cosine-affine-v1';
  profiles: Profile[];
  papers: Record<string, PaperScore>;
}
