// Copyright 2026 Guilhem Ribeill
// SPDX-License-Identifier: Apache-2.0

import type { D1Database } from '@cloudflare/workers-types';
import type { GenerationInputs } from './generation-inputs.ts';
import { readReading } from './reading-store.ts';
import { parseConfig } from '../config-text.ts';
import type { FeedbackSnapshot } from '../feedback.ts';

/** Reuse the immutable published ranking, never score again for summary-only work. */
export async function summaryReplacement(db: D1Database, inputs: GenerationInputs) {
  const reading = await readReading(db, inputs.userId);
  if (!reading || reading.generationId !== inputs.basePublication || !reading.digest.ranking) throw new Error('Original publication changed');
  const digest = reading.digest;
  const votes = inputs.votes.map((v, i) => ({ eventId: i + 1, paper: v.paper, value: v.value, createdAt: v.changedAt }));
  const examples: FeedbackSnapshot['examples'] = [];
  let after = '';
  for (;;) {
    const page = (await db.prepare(`SELECT paper_id,event_id,vector_json FROM generation_feedback_examples
      WHERE generation_id = ? AND paper_id > ? ORDER BY paper_id LIMIT 8`)
      .bind(inputs.basePublication, after).all<{ paper_id: string; event_id: number; vector_json: string }>()).results;
    for (const row of page) {
      const vote = votes.find(v => v.paper.id === row.paper_id);
      if (vote) examples.push({ ...vote, eventId: row.event_id, vector: JSON.parse(row.vector_json) });
    }
    if (page.length < 8) break;
    after = page[page.length - 1].paper_id;
  }
  digest.ranking!.feedbackSnapshot = { fingerprint: inputs.modelIdentity, capturedAt: inputs.startedAt,
    config: parseConfig(inputs.config.text).feedback, votes, examples };
  delete digest.summaries;
  return digest;
}
