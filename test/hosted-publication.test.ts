// Copyright 2026 Guilhem Ribeill
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseHTML } from 'linkedom';
import type { Digest } from '../src/digest.ts';
import { fixtureDigest, startHostedFixture } from '../scripts/hosted-fixtures.ts';
import { freezeGenerationInputs as admitGenerationInputs, readGenerationInputs } from '../src/hosted/generation-inputs.ts';
import { freezeFixtureInputs as freezeGenerationInputs } from '../scripts/hosted-fixtures.ts';
import { initializeSavedConfig, readSavedInterests, saveConfig, saveInterests } from '../src/hosted/saved-inputs.ts';
import { provisionUser, readPublicReading, readReading, saveUserVote } from '../src/hosted/reading-store.ts';
import { failGeneration, publishGeneration, stagePublication } from '../src/hosted/publication.ts';

const config = readFileSync(new URL('../config.toml', import.meta.url), 'utf8');
const batches = (digest: Digest) => [{ category: 'quant-ph', date: digest.date, sourceUrl: 'https://rss.arxiv.org/rss/quant-ph', papers: digest.papers }];
function completeSummaries(digest: Digest): Digest {
  for (const { id } of digest.ranking!.featured) digest.summaries![id] ??= {
    paperId: id, version: digest.papers.find(p => p.id === id)!.version, status: 'html_unavailable', createdAt: new Date().toISOString(),
  };
  return digest;
}

test('hosted atomic publication: staged completeness, replay, fencing, and real reading/voting', { timeout: 120000 }, async t => {
  const fixture = await startHostedFixture();
  const { db, owner, friend, worker, origin, access } = fixture;
  try {
    await initializeSavedConfig(db, config);
    const oldOwner = (await readReading(db, owner.id))!;
    const oldFriend = (await readReading(db, friend.id))!;
    const digest = fixtureDigest('New owner publication');
    const otherDigest = fixtureDigest('New friend publication');
    const inputs = (await freezeGenerationInputs(db, owner.id, batches(digest), 'fixture-only', true))!;
    const other = (await freezeGenerationInputs(db, friend.id, batches(otherDigest), 'fixture-only'))!;
    const ownerToken = await access.token('owner@example.test');
    const readPage = async () => parseHTML(await (await worker.fetch(origin + '/reader', { headers: { 'Cf-Access-Jwt-Assertion': ownerToken } })).text()).document;
    const form = (await readPage()).querySelector('form.vote-controls')!;
    const staleVote = new URLSearchParams({ paper: form.querySelector('input[name="paper"]')!.getAttribute('value')!,
      token: form.querySelector('input[name="token"]')!.getAttribute('value')!, value: '1' });
    const count = async (sql: string, id: string) => (await db.prepare(sql).bind(id).raw<[number]>())[0][0];

    await t.test('only complete rankings and requested terminal summary outcomes can stage', async () => {
      assert.equal(await publishGeneration(db, owner.id, inputs.id), 'not-ready');
      await assert.rejects(stagePublication(db, owner.id, inputs.id, digest), /summary outcomes are incomplete/);
      assert.equal((await freezeGenerationInputs(db, owner.id, batches(digest), 'fixture-only', false))!.summariesRequested, true);
      completeSummaries(digest);
      for (const corrupt of [
        (d: Digest) => { delete d.ranking; },
        (d: Digest) => { d.ranking!.remainingIds.pop(); },
        (d: Digest) => { d.papers[0].abstract += 'changed source'; },
        (d: Digest) => { d.semantic!.fingerprint = 'different-model'; },
        (d: Digest) => { delete d.ranking!.scores[d.papers[0].id]; },
        (d: Digest) => { d.summaries![d.ranking!.featured[0].id].version += 1; },
      ]) {
        const broken = structuredClone(digest); corrupt(broken);
        await assert.rejects(stagePublication(db, owner.id, inputs.id, broken));
      }
      await assert.rejects(stagePublication(db, owner.id, inputs.id, digest), /not durably complete/);
      // Fixture outcomes stand in for execution, but publication now requires
      // their durable terminal records rather than trusting an in-memory digest.
      await db.batch(digest.ranking!.featured.map((p, ordinal) => db.prepare(`INSERT INTO summary_outcomes
        (generation_id, paper_id, version, ordinal, state, outcome_json) VALUES (?, ?, ?, ?, 'complete', ?)`)
        .bind(inputs.id, p.id, digest.papers.find(paper => paper.id === p.id)!.version, ordinal, JSON.stringify(digest.summaries![p.id]))));
      assert.equal(await count('SELECT count(*) FROM reading_listings WHERE id = ?', inputs.id), 0);
      assert.deepEqual(await readReading(db, owner.id), oldOwner);
      // Publication must use the snapshot, not documents saved during generation.
      const interests = (await readSavedInterests(db, owner.id))!;
      await saveInterests(db, owner.id, interests.revision, interests.text + '\n<!-- pending edit -->');
      await saveConfig(db, owner.id, 1, config + '\n# pending config\n');
    });

    await t.test('interrupted staging retains the old publication and conflicting replays cannot mix rows', async () => {
      await db.prepare(`CREATE TRIGGER interrupt_publication BEFORE INSERT ON reading_papers
        WHEN NEW.listing_id = '${inputs.id}' AND NEW.ordinal = 8
        BEGIN SELECT RAISE(ABORT, 'fixture staging interruption'); END`).run();
      await assert.rejects(stagePublication(db, owner.id, inputs.id, digest), /fixture staging interruption/);
      await db.prepare('DROP TRIGGER interrupt_publication').run();
      assert.equal(await count('SELECT count(*) FROM reading_papers WHERE listing_id = ?', inputs.id), 8);
      assert.equal(await publishGeneration(db, owner.id, inputs.id), 'not-ready');
      assert.deepEqual(await readReading(db, owner.id), oldOwner);
      const competing = structuredClone(digest);
      competing.summaries![digest.ranking!.featured[0].id].summary += ' conflicting result';
      assert.equal(await stagePublication(db, owner.id, inputs.id, competing), 'conflict');
      assert.deepEqual(await Promise.all([
        stagePublication(db, owner.id, inputs.id, digest), stagePublication(db, owner.id, inputs.id, digest),
      ]), ['ready', 'ready']);
      assert.equal(await stagePublication(db, owner.id, inputs.id, competing), 'conflict');
      assert.deepEqual(await readReading(db, owner.id), oldOwner);
      assert.deepEqual(await readReading(db, friend.id), oldFriend);
    });

    await t.test('pointer/state/work release roll back together; successful publication is replay-safe', async () => {
      // Fail after the pointer update, proving rollback includes the visible pointer.
      await db.prepare(`CREATE TRIGGER interrupt_commit BEFORE UPDATE OF state ON generation_inputs
        WHEN NEW.id = '${inputs.id}' AND NEW.state = 'published'
        BEGIN SELECT RAISE(ABORT, 'fixture commit interruption'); END`).run();
      await assert.rejects(publishGeneration(db, owner.id, inputs.id), /fixture commit interruption/);
      await db.prepare('DROP TRIGGER interrupt_commit').run();
      assert.deepEqual(await readReading(db, owner.id), oldOwner);
      assert.deepEqual(await readGenerationInputs(db, owner.id), inputs);
      assert.equal((await db.prepare('SELECT state FROM generation_inputs WHERE id = ?')
        .bind(inputs.id).first<{ state: string }>())!.state, 'ready');
      assert.deepEqual(await Promise.all([
        publishGeneration(db, owner.id, inputs.id), publishGeneration(db, owner.id, inputs.id),
      ]), ['published', 'published']);
      assert.equal(await readGenerationInputs(db, owner.id), undefined);
      assert.deepEqual(await readGenerationInputs(db, owner.id, inputs.id), inputs);
      const published = (await readReading(db, owner.id))!;
      assert.equal(published.generationId, inputs.id);
      assert.deepEqual(published.digest.papers.map(p => p.id), [...digest.ranking!.featured.map(p => p.id), ...digest.ranking!.remainingIds]);
      assert.deepEqual(published.digest.summaries, digest.summaries);
      assert.deepEqual(published.digest.ranking, digest.ranking);
      assert.deepEqual(await readPublicReading(db), published);
      assert.equal(await stagePublication(db, owner.id, inputs.id, digest), 'published');
      // Already pinned readers retain their old immutable rows after the swap.
      assert.equal(await count('SELECT count(*) FROM reading_papers WHERE listing_id = ?', oldOwner.generationId), oldOwner.digest.papers.length);
      assert.equal(await failGeneration(db, owner.id, inputs.id), false);
    });

    await t.test('HTTP reading follows replacements, rejects stale forms, and repeated batches do not rerank', async () => {
      const page = await readPage();
      assert.match(page.querySelector('main')!.textContent!, /New owner publication/);
      const rejected = await worker.fetch(origin + '/reader/vote', { method: 'POST', redirect: 'manual', headers: {
        Origin: origin, 'Cf-Access-Jwt-Assertion': ownerToken, 'Content-Type': 'application/x-www-form-urlencoded',
      }, body: staleVote.toString() });
      assert.equal(rejected.status, 403);
      assert.equal(await saveUserVote(db, owner.id, oldOwner.generationId, digest.papers[0].id, 1), false);
      assert.equal(await saveUserVote(db, owner.id, inputs.id, digest.papers[0].id, 1), true);
      assert.deepEqual((await readGenerationInputs(db, owner.id, inputs.id))!.votes, []);
      assert.equal(await saveUserVote(db, owner.id, inputs.id, digest.papers[0].id, 0), true);
      const changed = structuredClone(digest); changed.papers[0].title = 'Changed feed metadata, same announcement';
      assert.deepEqual(await admitGenerationInputs(db, owner.id, batches(changed), 'different-model', false), { status: 'unchanged' });
      assert.equal((await readReading(db, owner.id))!.generationId, inputs.id);
      assert.equal((await readGenerationInputs(db, friend.id))!.id, other.id);
    });

    await t.test('ownership/disabled state and failed-generation fences are checked at publication time', async () => {
      assert.equal(await stagePublication(db, owner.id, other.id, otherDigest), 'stale');
      assert.equal(await publishGeneration(db, owner.id, other.id), 'stale');
      assert.equal(await failGeneration(db, owner.id, other.id), false);
      assert.equal(await stagePublication(db, friend.id, other.id, otherDigest), 'ready');
      await db.prepare('UPDATE users SET enabled = 0 WHERE id = ?').bind(friend.id).run();
      assert.equal(await publishGeneration(db, friend.id, other.id), 'stale');
      assert.equal(await stagePublication(db, friend.id, other.id, otherDigest), 'stale');
      assert.deepEqual(await readReading(db, friend.id), oldFriend);
      await db.prepare('UPDATE users SET enabled = 1 WHERE id = ?').bind(friend.id).run();
      assert.equal(await publishGeneration(db, friend.id, other.id), 'published');
      const laterDigest = fixtureDigest('Failed later run'); laterDigest.date = '2030-01-01';
      const later = (await freezeGenerationInputs(db, owner.id, batches(laterDigest), 'fixture-only'))!;
      assert.equal(await stagePublication(db, owner.id, later.id, laterDigest), 'ready');
      assert.equal(await failGeneration(db, owner.id, later.id), true);
      assert.equal((await readReading(db, owner.id))!.generationId, inputs.id);
      const replacement = (await freezeGenerationInputs(db, owner.id, batches(laterDigest), 'fixture-only'))!;
      assert.notEqual(replacement.id, later.id);
      assert.equal(await publishGeneration(db, owner.id, later.id), 'stale');
      assert.equal(await stagePublication(db, owner.id, later.id, laterDigest), 'stale');
      assert.equal(await failGeneration(db, owner.id, later.id), false);
      assert.equal((await readGenerationInputs(db, owner.id))!.id, replacement.id);
      assert.equal(await stagePublication(db, owner.id, replacement.id, laterDigest), 'ready');
      assert.equal(await publishGeneration(db, owner.id, replacement.id), 'published');
      assert.equal(await publishGeneration(db, owner.id, inputs.id), 'stale');
      assert.equal(await readGenerationInputs(db, owner.id, inputs.id), undefined);
      assert.equal((await readReading(db, friend.id))!.generationId, other.id);
    });

    await t.test('an empty completed batch publishes, but first-login waiting stays until then', async () => {
      const user = (await provisionUser(db, access.identity('new@example.test')))!;
      const empty = fixtureDigest('Empty');
      empty.papers = []; empty.featuredIds = []; empty.summaries = {};
      empty.semantic!.papers = {};
      empty.ranking!.featured = []; empty.ranking!.remainingIds = []; empty.ranking!.scores = {}; empty.ranking!.mmrScores = {};
      const run = (await freezeGenerationInputs(db, user.id, batches(empty), 'fixture-only', true))!;
      assert.equal(await readReading(db, user.id), undefined);
      assert.equal(await stagePublication(db, user.id, run.id, empty), 'ready');
      assert.equal(await readReading(db, user.id), undefined);
      assert.equal(await publishGeneration(db, user.id, run.id), 'published');
      assert.deepEqual((await readReading(db, user.id))!.digest.papers, []);
    });
  } finally { await fixture.close(); }
});
