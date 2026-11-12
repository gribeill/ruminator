// Copyright 2026 Guilhem Ribeill
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { D1Database, D1DatabaseSession, D1PreparedStatement } from '@cloudflare/workers-types';
import { fixtureDigest, publishFixture, startHostedFixture } from '../scripts/hosted-fixtures.ts';
import { createHostedApp } from '../src/hosted/app.ts';
import { readGenerationInputs, type GenerationInputs } from '../src/hosted/generation-inputs.ts';
import { freezeFixtureInputs as freezeGenerationInputs } from '../scripts/hosted-fixtures.ts';
import { cleanupHostedState, voteCutoff } from '../src/hosted/retention.ts';
import { stagePublication, publishGeneration, failGeneration } from '../src/hosted/publication.ts';
import { initializeSavedConfig } from '../src/hosted/saved-inputs.ts';
import { provisionUser, readReading, readUserVotes, ReadingUnavailableError } from '../src/hosted/reading-store.ts';
import { parseConfig } from '../src/config-text.ts';
import type { Digest } from '../src/digest.ts';
import { rankPapers } from '../src/ranking.ts';
import { renderDigest } from '../src/render.ts';

const config = readFileSync(new URL('../config.toml', import.meta.url), 'utf8');
const batches = (d: Digest) => [{ category: 'quant-ph', date: d.date, sourceUrl: 'fixture', papers: d.papers }];
function rankWithFeedback(digest: Digest, inputs: GenerationInputs): void {
  const votes = inputs.votes.map((v, i) => ({ eventId: i + 1, paper: v.paper, value: v.value, createdAt: v.changedAt }));
  const settings = parseConfig(inputs.config.text);
  digest.ranking = rankPapers(digest, digest.semantic!, Object.fromEntries(digest.papers.map(p => [p.id, [1, 0]])),
    digest.semantic!.profiles, settings.scoring.weights, { capturedAt: inputs.startedAt, config: settings.feedback,
      fingerprint: inputs.modelIdentity, votes, examples: votes.map(v => ({ ...v, vector: [1, 0] })) });
  digest.summaries = {};
}

/** Interleave real D1 operations at a query boundary; no SQL results are mocked. */
function afterFirst(db: D1Database, matches: RegExp, action: (row: { id: string }) => Promise<void>): D1Database {
  function statement(target: D1PreparedStatement, sql: string): D1PreparedStatement {
    return new Proxy(target, { get(query, key) {
      if (key === 'bind') return (...args: unknown[]) => statement(query.bind(...args), sql);
      if (key === 'first') return async (column?: string) => {
        const result = column === undefined ? await query.first() : await query.first(column);
        if (result && matches.test(sql)) await action(result as { id: string });
        return result;
      };
      const value = Reflect.get(query, key);
      return typeof value === 'function' ? value.bind(query) : value;
    } });
  }
  function client<T extends D1Database | D1DatabaseSession>(target: T): T {
    return new Proxy(target, { get(connection, key) {
      if (key === 'prepare') return (sql: string) => statement(connection.prepare(sql), sql);
      if (key === 'withSession') return (bookmark?: string) => client(db.withSession(bookmark));
      const value = Reflect.get(connection, key);
      return typeof value === 'function' ? value.bind(connection) : value;
    } });
  }
  return client(db);
}

test('hosted retention: reference-aware bounded cleanup, provenance expiry, and one reading retry', { timeout: 120000 }, async t => {
  const fixture = await startHostedFixture();
  const { db, owner, friend } = fixture;
  const scalar = async (sql: string, ...args: string[]) => (await db.prepare(sql).bind(...args).raw<[number]>())[0][0];
  try {
    await initializeSavedConfig(db, config);
    const oldOwner = (await readReading(db, owner.id))!;
    const oldFriend = (await readReading(db, friend.id))!;
    const currentDigest = fixtureDigest('Current owner');
    const current = (await freezeGenerationInputs(db, owner.id, batches(currentDigest), 'fixture-only'))!;
    await stagePublication(db, owner.id, current.id, currentDigest);
    await publishGeneration(db, owner.id, current.id);
    const currentReading = await readReading(db, owner.id);
    const now = new Date().toISOString();
    const expired = new Date(new Date(voteCutoff()).getTime() - 1000).toISOString();
    const privatePaper = { ...currentDigest.papers[0], id: '2501.99999', title: 'PRIVATE_VOTED_METADATA' };
    for (const [user, paperId, value, date] of [
      [owner.id, privatePaper.id, 1, now], [owner.id, 'expired', -1, expired],
      [owner.id, 'cleared', 0, now], [friend.id, 'expired', 1, now],
    ] as const) await db.prepare('INSERT INTO user_votes VALUES (?, ?, ?, ?, ?)')
      .bind(user, paperId, value, JSON.stringify({ ...privatePaper, id: paperId }), date).run();
    const workingDigest = fixtureDigest('Working friend');
    const working = (await freezeGenerationInputs(db, friend.id, batches(workingDigest), 'fixture-only'))!;
    rankWithFeedback(workingDigest, working);

    await t.test('keeps every user publication/working artifact and active vote while pruning failed and superseded work', async () => {
      await db.prepare(`CREATE TRIGGER partial_staging BEFORE INSERT ON reading_papers
        WHEN NEW.listing_id = '${working.id}' AND NEW.ordinal = 8
        BEGIN SELECT RAISE(ABORT, 'partial staging'); END`).run();
      await assert.rejects(stagePublication(db, friend.id, working.id, workingDigest), /partial staging/);
      await db.prepare('DROP TRIGGER partial_staging').run();
      const newUser = (await provisionUser(db, fixture.access.identity('new@example.test')))!;
      const failedDigest = fixtureDigest('Failed');
      const failed = (await freezeGenerationInputs(db, newUser.id, batches(failedDigest), 'fixture-only'))!;
      await stagePublication(db, newUser.id, failed.id, failedDigest);
      await failGeneration(db, newUser.id, failed.id);
      const result = await cleanupHostedState(db);
      assert.equal(result.complete, true);
      assert.ok(result.rowsDeleted > 0);
      assert.equal(await scalar('SELECT count(*) FROM reading_listings WHERE id = ?', oldOwner.generationId), 0);
      for (const table of ['generation_inputs', 'generation_batch_chunks', 'generation_input_votes', 'generation_feedback_examples', 'generation_paper_refs', 'generation_text_refs']) {
        const column = table === 'generation_inputs' ? 'id' : 'generation_id';
        assert.equal(await scalar(`SELECT count(*) FROM ${table} WHERE ${column} = ?`, failed.id), 0);
      }
      assert.equal(await scalar('SELECT count(*) FROM reading_listings WHERE id = ?', failed.id), 0);
      assert.equal(await scalar('SELECT count(*) FROM reading_papers WHERE listing_id = ?', working.id), 8);
      assert.deepEqual(await readGenerationInputs(db, friend.id), working);
      assert.deepEqual(await readReading(db, owner.id), currentReading);
      assert.deepEqual(await readReading(db, friend.id), oldFriend);
      assert.deepEqual(await readUserVotes(db, owner.id), { [privatePaper.id]: 1 });
      assert.deepEqual(await readUserVotes(db, friend.id), { expired: 1 });
      assert.equal((await db.prepare('SELECT changed_at FROM user_votes WHERE user_id = ? AND paper_id = ?')
        .bind(owner.id, privatePaper.id).first<{ changed_at: string }>())!.changed_at, now);
      assert.equal(await stagePublication(db, friend.id, working.id, workingDigest), 'ready');
      assert.equal((await cleanupHostedState(db)).rowsDeleted, 0);
    });

    await t.test('expired private metadata/vectors disappear without changing display or resurrecting through replay', async t => {
      const digest = fixtureDigest('With private feedback'); digest.date = '2030-02-01';
      const run = (await freezeGenerationInputs(db, owner.id, batches(digest), 'fixture-only'))!;
      rankWithFeedback(digest, run);
      await stagePublication(db, owner.id, run.id, digest);
      await publishGeneration(db, owner.id, run.id);
      const before = (await readReading(db, owner.id))!;
      const html = renderDigest(before.digest);
      assert.equal(before.digest.ranking!.feedbackSnapshot, undefined);
      const metadata = (await db.prepare('SELECT metadata_json FROM reading_listings WHERE id = ?').bind(run.id).first<{ metadata_json: string }>())!;
      assert.doesNotMatch(metadata.metadata_json, /PRIVATE_VOTED_METADATA|feedbackSnapshot/);
      assert.equal(await scalar('SELECT count(*) FROM generation_feedback_examples WHERE generation_id = ?', run.id), 1);
      assert.equal(await scalar('SELECT count(*) FROM generation_feedback_examples WHERE generation_id = ?', working.id), 1);
      t.mock.timers.enable({ apis: ['Date'], now: new Date(Date.now() + 366 * 86400000) });
      assert.equal((await cleanupHostedState(db)).complete, true);
      for (const id of [run.id, working.id]) {
        assert.equal(await scalar('SELECT count(*) FROM generation_input_votes WHERE generation_id = ?', id), 0);
        assert.equal(await scalar('SELECT count(*) FROM generation_feedback_examples WHERE generation_id = ?', id), 0);
      }
      assert.deepEqual(await readUserVotes(db, owner.id), {});
      assert.equal(renderDigest((await readReading(db, owner.id))!.digest).replace(/Guilhem Ribeill \d{4}/, 'Guilhem Ribeill YEAR'), html.replace(/Guilhem Ribeill \d{4}/, 'Guilhem Ribeill YEAR'));
      assert.deepEqual(await readReading(db, owner.id), before);
      assert.equal(await stagePublication(db, owner.id, run.id, digest), 'published');
      assert.equal(await stagePublication(db, friend.id, working.id, workingDigest), 'ready');
      assert.equal(await scalar('SELECT count(*) FROM generation_feedback_examples WHERE generation_id = ?', run.id), 0);
      assert.equal(await scalar('SELECT count(*) FROM generation_feedback_examples WHERE generation_id = ?', working.id), 0);
    });

    await t.test('cleanup failure is resumable and a large artifact respects the fixed work budget', async () => {
      const id = '!large-unreferenced';
      await db.prepare('INSERT INTO reading_listings VALUES (?, ?, ?)').bind(id, owner.id, '{}').run();
      await db.prepare(`WITH RECURSIVE ordinals(n) AS (SELECT 0 UNION ALL SELECT n + 1 FROM ordinals WHERE n < 2199)
        INSERT INTO reading_papers (listing_id, ordinal, paper_id, paper_json)
        SELECT ?, n, 'paper-' || n, '{}' FROM ordinals`).bind(id).run();
      await db.prepare(`CREATE TRIGGER interrupt_cleanup BEFORE DELETE ON reading_papers
        WHEN OLD.listing_id = '${id}' AND OLD.ordinal = 64
        BEGIN SELECT RAISE(ABORT, 'cleanup interrupted'); END`).run();
      await assert.rejects(cleanupHostedState(db), /cleanup interrupted/);
      await db.prepare('DROP TRIGGER interrupt_cleanup').run();
      assert.equal(await scalar('SELECT count(*) FROM reading_papers WHERE listing_id = ?', id), 2200 - 64);
      assert.equal((await cleanupHostedState(db)).complete, false);
      assert.ok(await scalar('SELECT count(*) FROM reading_papers WHERE listing_id = ?', id) > 0);
      assert.equal((await cleanupHostedState(db)).complete, true);
      assert.equal(await scalar('SELECT count(*) FROM reading_listings WHERE id = ?', id), 0);
      assert.equal((await readGenerationInputs(db, friend.id))!.id, working.id);
    });

    await t.test('each delete rechecks references acquired after candidate selection', async () => {
      const id = '!newly-referenced';
      const meta = { date: '2030-01-01', categories: ['quant-ph'], featuredIds: [], paperCount: 1 };
      await db.prepare('INSERT INTO reading_listings VALUES (?, ?, ?)').bind(id, owner.id, JSON.stringify(meta)).run();
      await db.prepare('INSERT INTO reading_papers (listing_id, ordinal, paper_id, paper_json) VALUES (?, 0, ?, ?)')
        .bind(id, currentDigest.papers[0].id, JSON.stringify(currentDigest.papers[0])).run();
      let guarded = false;
      const interleaved = afterFirst(db, /SELECT r\.id FROM reading_listings/, async row => {
        if (row.id === id && !guarded) {
          guarded = true;
          await db.prepare('UPDATE current_readings SET listing_id = ? WHERE user_id = ?').bind(id, owner.id).run();
        }
      });
      assert.equal((await cleanupHostedState(interleaved)).complete, true);
      assert.ok(guarded);
      assert.equal(await scalar('SELECT count(*) FROM reading_papers WHERE listing_id = ?', id), 1);
      assert.equal((await readReading(db, owner.id))!.generationId, id);
    });

    await t.test('a reader overtaken by replacement/cleanup retries once and returns a complete new listing', async () => {
      const before = await publishFixture(db, owner.id, fixtureDigest('Before race'));
      let reads = 0;
      const interleaved = afterFirst(db, /SELECT r\.id, r\.metadata_json/, async row => {
        reads++;
        if (reads === 1) {
          assert.equal(row.id, before);
          await publishFixture(db, owner.id, fixtureDigest('After race'));
          await cleanupHostedState(db);
        }
      });
      const result = (await readReading(interleaved, owner.id))!;
      assert.equal(reads, 2);
      assert.equal(result.digest.papers.length, 9);
      assert.ok(result.digest.papers.every(p => p.title.startsWith('After race')));
      assert.equal(await scalar('SELECT count(*) FROM reading_listings WHERE id = ?', before), 0);
    });

    await t.test('repeated read races yield an uncached temporary error, not partial HTML or an unbounded loop', async () => {
      let reads = 0;
      const interleaved = afterFirst(db, /SELECT r\.id, r\.metadata_json/, async () => {
        reads++;
        await publishFixture(db, owner.id, fixtureDigest('Replacement ' + reads));
        await cleanupHostedState(db);
      });
      await assert.rejects(readReading(interleaved, owner.id), ReadingUnavailableError);
      assert.equal(reads, 2);
      reads = 0;
      const app = createHostedApp({ ...await fixture.worker.getEnv(), DB: interleaved });
      const response = await app(new Request(fixture.origin + '/'));
      assert.equal(response.status, 503);
      assert.match(response.headers.get('cache-control')!, /no-store/);
      assert.equal(response.headers.get('retry-after'), '1');
      assert.doesNotMatch(await response.text(), /Replacement|<article/);
      assert.equal(reads, 2);
    });
  } finally { await fixture.close(); }
});
