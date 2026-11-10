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

export type VoteValue = -1 | 0 | 1;
export type Votes = Record<string, -1 | 1>;

export interface FeedbackConfig {
  min_similarity: number;
  near_duplicate_similarity: number;
}

export const DEFAULT_FEEDBACK_CONFIG: Readonly<FeedbackConfig> = {
  min_similarity: 0.90,
  near_duplicate_similarity: 0.95,
};

export function validateFeedbackConfig(config: FeedbackConfig): void {
  if (!Number.isFinite(config.min_similarity) || config.min_similarity < 0 || config.min_similarity >= 1 ||
      !Number.isFinite(config.near_duplicate_similarity) || config.near_duplicate_similarity < config.min_similarity ||
      config.near_duplicate_similarity > 1) {
    throw new Error('feedback thresholds must satisfy 0 <= min_similarity < 1 and min_similarity <= near_duplicate_similarity <= 1');
  }
}

export interface VotedPaper {
  eventId: number;
  paper: Paper;
  value: -1 | 1;
  createdAt: string;
}

export interface FeedbackInput {
  capturedAt: string;
  config: FeedbackConfig;
  votes: VotedPaper[];
}

export interface FeedbackExample extends VotedPaper {
  vector: number[];
}

export interface FeedbackSnapshot extends FeedbackInput {
  fingerprint: string;
  examples: FeedbackExample[];
}

function cosine(a: number[], b: number[]): number {
  if (!a.length || a.length !== b.length || [...a, ...b].some(v => !Number.isFinite(v)) ||
      Math.abs(Math.hypot(...a) - 1) > 1e-5 || Math.abs(Math.hypot(...b) - 1) > 1e-5) {
    throw new Error('Feedback requires compatible normalized vectors');
  }
  return Math.max(-1, Math.min(1, a.reduce((sum, v, i) => sum + v * b[i], 0)));
}

/** Shrink weak/sparse evidence toward neutral, rather than treating one vote as certainty.
 * Similarity evidence grows linearly above the cutoff. A neutral pseudocount of 1
 * bounds one perfectly matching vote to 0.25/0.75. Latest examples win duplicate
 * conflicts; repeated versions or near-duplicate papers cannot multiply evidence.
 */
export function feedbackScore(vector: number[], examples: FeedbackExample[], config: FeedbackConfig): number {
  validateFeedbackConfig(config);
  const retained: FeedbackExample[] = [];
  const ordered = [...examples].sort((a, b) => b.eventId - a.eventId || a.paper.id.localeCompare(b.paper.id));
  let signedEvidence = 0, evidence = 0;
  for (const example of ordered) {
    const similarity = cosine(vector, example.vector);
    if (similarity < config.min_similarity) continue;
    if (retained.some(other => other.paper.id === example.paper.id ||
        cosine(other.vector, example.vector) >= config.near_duplicate_similarity)) continue;
    retained.push(example);
    const weight = (similarity - config.min_similarity) / (1 - config.min_similarity);
    evidence += weight;
    signedEvidence += weight * example.value;
  }
  return 0.5 + 0.5 * signedEvidence / (1 + evidence);
}

/** Safe HTML fragment shared by forms and redirect targets, including old-style IDs. */
export function paperAnchor(id: string): string {
  return `paper-${id.replaceAll('/', '-')}`;
}
