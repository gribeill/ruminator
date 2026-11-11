// Copyright 2026 Guilhem Ribeill
// SPDX-License-Identifier: Apache-2.0

import type { D1Database } from '@cloudflare/workers-types';
import type { Digest } from '../digest.ts';
import type { Ranking } from '../ranking.ts';
import type { SemanticScores } from '../semantic-types.ts';
import type { Votes, VoteValue } from '../feedback.ts';
import type { Identity } from './auth.ts';
import { DEFAULT_INTERESTS } from './default-interests.ts';

export interface User {
  id: string; access_issuer: string; access_subject: string; email: string;
  role: 'admin' | 'user'; enabled: 0 | 1; interests: string; interests_revision: number; csrf_secret: string;
}
export interface ReadingPublication { generationId: string; digest: Digest }
export type ReadingMetadata = Omit<Digest, 'papers' | 'semantic' | 'ranking' | 'summaries'> & {
  semantic?: Omit<SemanticScores, 'papers'>;
  ranking?: Omit<Ranking, 'scores' | 'remainingIds'>;
};

/** Access is the invitation authority. Re-login never resets role, enabled state,
 * or interests. Email collisions/identity changes require explicit operator review.
 */
export async function provisionUser(db: D1Database, identity: Identity): Promise<User | undefined> {
  const results = await db.batch<User>([
    db.prepare(`INSERT INTO users (id, access_issuer, access_subject, email, interests, csrf_secret, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`)
      .bind(crypto.randomUUID(), identity.issuer, identity.subject, identity.email, DEFAULT_INTERESTS,
        Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join(''), new Date().toISOString()),
    db.prepare('SELECT * FROM users WHERE access_issuer = ? AND access_subject = ? AND email = ? AND enabled = 1')
      .bind(identity.issuer, identity.subject, identity.email),
  ]);
  return results[1].results[0];
}

/** Pin one immutable projection ID; future cleanup must preserve in-flight readers.
 * Per-paper UI data is normalized, not stored in a potentially oversized digest JSON row.
 */
export async function readReading(db: D1Database, userId: string): Promise<ReadingPublication | undefined> {
  const session = db.withSession('first-primary');
  const listing = await session.prepare(`SELECT r.id, r.metadata_json FROM current_readings c
    JOIN reading_listings r ON r.id = c.listing_id AND r.user_id = c.user_id WHERE c.user_id = ?`)
    .bind(userId).first<{ id: string; metadata_json: string }>();
  if (!listing) return undefined;
  const rows = (await session.prepare('SELECT * FROM reading_papers WHERE listing_id = ? ORDER BY ordinal')
    .bind(listing.id).all<{ paper_id: string; paper_json: string; semantic_json: string | null; relevance_json: string | null; summary_json: string | null }>()).results;
  const meta = JSON.parse(listing.metadata_json) as ReadingMetadata;
  const values = (field: 'semantic_json' | 'relevance_json' | 'summary_json') => Object.fromEntries(
    rows.filter(row => row[field] !== null).map(row => [row.paper_id, JSON.parse(row[field]!) ]));
  return {
    generationId: listing.id,
    digest: {
      date: meta.date, categories: meta.categories, featuredIds: meta.featuredIds,
      papers: rows.map(row => JSON.parse(row.paper_json)), summaries: values('summary_json'),
      ...(meta.semantic ? { semantic: { ...meta.semantic, papers: values('semantic_json') } } : {}),
      ...(meta.ranking ? { ranking: { ...meta.ranking, scores: values('relevance_json'),
        remainingIds: rows.filter(row => !meta.ranking!.featured.some(p => p.id === row.paper_id)).map(row => row.paper_id) } } : {}),
    },
  };
}

export async function readPublicReading(db: D1Database): Promise<ReadingPublication | undefined> {
  const admin = await db.prepare("SELECT id FROM users WHERE role = 'admin'").first<{ id: string }>();
  return admin ? readReading(db, admin.id) : undefined;
}

export async function readUserVotes(db: D1Database, userId: string): Promise<Votes> {
  const rows = (await db.prepare('SELECT paper_id, value FROM user_votes WHERE user_id = ? AND value != 0')
    .bind(userId).all<{ paper_id: string; value: -1 | 1 }>()).results;
  return Object.fromEntries(rows.map(row => [row.paper_id, row.value]));
}

/** Recheck enabled state AND publication ownership in the write transaction, so
 * disable/replacement while a form is in flight cannot turn it into a valid vote.
 * Same-state resubmissions do not renew retention timestamps.
 */
export async function saveUserVote(db: D1Database, userId: string, listingId: string, paperId: string, value: VoteValue): Promise<boolean> {
  const eligibility = `FROM users u JOIN current_readings c ON c.user_id = u.id
    JOIN reading_papers p ON p.listing_id = c.listing_id
    WHERE u.id = ? AND u.enabled = 1 AND c.listing_id = ? AND p.paper_id = ?`;
  const results = await db.batch([
    db.prepare(`INSERT INTO user_votes (user_id, paper_id, value, paper_json, changed_at)
      SELECT u.id, p.paper_id, ?, p.paper_json, ? ${eligibility}
      ON CONFLICT (user_id, paper_id) DO UPDATE SET value = excluded.value,
        paper_json = excluded.paper_json, changed_at = excluded.changed_at
      WHERE user_votes.value != excluded.value`).bind(value, new Date().toISOString(), userId, listingId, paperId),
    db.prepare(`SELECT 1 ${eligibility}`).bind(userId, listingId, paperId),
  ]);
  return results[1].results.length === 1;
}
