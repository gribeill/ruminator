// Copyright 2026 Guilhem Ribeill
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { Batch } from '../src/arxiv.ts';
import { fixtureDigest, startHostedFixture } from '../scripts/hosted-fixtures.ts';
import { freezeGenerationInputs as admitGenerationInputs, readGenerationInputs } from '../src/hosted/generation-inputs.ts';
import { freezeFixtureInputs as freezeGenerationInputs } from '../scripts/hosted-fixtures.ts';
import { initializeSavedConfig, readSavedInterests, saveConfig, saveInterests } from '../src/hosted/saved-inputs.ts';
import { provisionUser, readReading, saveUserVote } from '../src/hosted/reading-store.ts';

const config = readFileSync(new URL('../config.toml', import.meta.url), 'utf8');
function batch(): Batch[] {
  const digest = fixtureDigest('Frozen source');
  return [{ category: 'quant-ph', date: digest.date, sourceUrl: 'https://rss.arxiv.org/rss/quant-ph', papers: digest.papers }];
}

test('hosted generation inputs freeze atomically and resume without adopting later edits', { timeout: 120000 }, async t => {
  const fixture = await startHostedFixture();
  const { db, owner, friend } = fixture;
  try {
    await initializeSavedConfig(db, config);
    const ownerReading = (await readReading(db, owner.id))!;
    const friendReading = (await readReading(db, friend.id))!;
    const source = batch();
    const scalar = async (sql: string, ...params: string[]) => (await db.prepare(sql).bind(...params).raw<[number]>())[0][0];

    await t.test('profiles/config/votes and model/batch identity stay fixed through edits and concurrent resumption', async () => {
      const paper = ownerReading.digest.papers[0];
      await saveUserVote(db, owner.id, ownerReading.generationId, paper.id, 1);
      const expired = new Date(Date.now() - 366 * 86400000).toISOString();
      await db.prepare('INSERT INTO user_votes VALUES (?, ?, ?, ?, ?)').bind(owner.id, 'expired-paper', -1, JSON.stringify(paper), expired).run();
      const interests = (await readSavedInterests(db, owner.id))!;
      const [first, other] = await Promise.all([
        freezeGenerationInputs(db, owner.id, source, 'hosted-model-A/cls/tokenizer-A/epoch-1'),
        freezeGenerationInputs(db, owner.id, source, 'hosted-model-A/cls/tokenizer-A/epoch-1'),
      ]);
      assert.ok(first?.batches);
      assert.deepEqual(first, other);
      assert.deepEqual(first.batches, source);
      assert.deepEqual(first.interests, interests);
      assert.deepEqual(first.config, { text: config, revision: 1 });
      assert.equal(first.votes.length, 1);
      assert.equal(first.votes[0].paperId, paper.id);
      assert.deepEqual(first.votes[0].paper, paper);
      assert.equal(first.votes[0].value, 1);
      assert.equal(await scalar('SELECT count(*) FROM generation_inputs WHERE user_id = ?', owner.id), 1);
      assert.equal((await saveInterests(db, owner.id, interests.revision, interests.text + '\n<!-- later edit -->')).status, 'saved');
      assert.equal((await saveConfig(db, owner.id, 1, config + '\n# later config\n')).status, 'saved');
      await saveUserVote(db, owner.id, ownerReading.generationId, paper.id, -1);
      const newer = structuredClone(source);
      newer[0].papers[0].title = 'Different source now available';
      assert.deepEqual(await freezeGenerationInputs(db, owner.id, newer, 'different-provider/epoch-2'), first);
      assert.deepEqual(await readGenerationInputs(db, owner.id), first);
      assert.equal(await scalar('SELECT count(*) FROM user_votes WHERE paper_id = ? AND changed_at = ?', 'expired-paper', expired), 1);
      // Snapshot capture filters expiry but never renews/clears explicit vote history.
    });

    await t.test('snapshot failure rolls back the pointer, documents, and votes together', async () => {
      const user = (await provisionUser(db, fixture.access.identity('new@example.test')))!;
      await db.prepare('INSERT INTO user_votes VALUES (?, ?, ?, ?, ?)')
        .bind(user.id, 'invalid-paper', 1, 'not JSON', new Date().toISOString()).run();
      await assert.rejects(freezeGenerationInputs(db, user.id, source, 'model-A'), /CHECK constraint/);
      assert.equal(await scalar('SELECT count(*) FROM generation_inputs WHERE user_id = ?', user.id), 0);
      assert.equal(await scalar('SELECT count(*) FROM working_generations WHERE user_id = ?', user.id), 0);
      await db.prepare('DELETE FROM user_votes WHERE user_id = ?').bind(user.id).run();
      const empty = [{ ...source[0], papers: [] }];
      const recovered = await freezeGenerationInputs(db, user.id, empty, 'model-A');
      assert.deepEqual(recovered?.batches, empty);
      assert.deepEqual(recovered?.votes, []);
      assert.equal(recovered?.config.revision, 2);
    });

    await t.test('interrupted multi-page Unicode batches resume only matching bytes and keep original inputs', async () => {
      const large = structuredClone(source);
      large[0].papers[0].abstract = 'é漢🔬 '.repeat(240000);
      const changedAt = new Date().toISOString();
      const voteIds = Array.from({ length: 10 }, (_, i) => `2601.${String(i).padStart(5, '0')}`);
      await db.batch(voteIds.map(id => db.prepare('INSERT INTO user_votes VALUES (?, ?, ?, ?, ?)')
        .bind(friend.id, id, -1, JSON.stringify({ ...source[0].papers[0], id }), changedAt)));
      // An actual SQLite failure after the first eight-chunk page simulates a lost worker.
      await db.prepare(`CREATE TRIGGER interrupt_batch BEFORE INSERT ON generation_batch_chunks
        WHEN NEW.ordinal = 8 BEGIN SELECT RAISE(ABORT, 'fixture interrupted chunk write'); END`).run();
      await assert.rejects(freezeGenerationInputs(db, friend.id, large, 'model-B'), /fixture interrupted/);
      await db.prepare('DROP TRIGGER interrupt_batch').run();
      const partial = (await readGenerationInputs(db, friend.id))!;
      assert.equal(partial.batches, undefined);
      assert.deepEqual(partial.votes.map(v => v.paperId), voteIds);
      assert.equal(await scalar('SELECT count(*) FROM generation_batch_chunks WHERE generation_id = ?', partial.id), 8);
      const interests = (await readSavedInterests(db, friend.id))!;
      await saveInterests(db, friend.id, interests.revision, interests.text + '\n<!-- edit during interruption -->');
      assert.deepEqual(await freezeGenerationInputs(db, friend.id, source, 'new-model'), partial);
      const resumed = (await freezeGenerationInputs(db, friend.id, large, 'new-model'))!;
      assert.deepEqual(resumed.batches, large);
      assert.deepEqual({ ...resumed, batches: undefined }, partial);
      assert.notEqual(resumed.id, (await readGenerationInputs(db, owner.id))!.id);
      assert.equal(await scalar('SELECT max(length(bytes)) FROM generation_batch_chunks WHERE generation_id = ?', partial.id), 262144);
      // Corruption is not silently decoded into scientific input.
      const original = await db.prepare('SELECT bytes FROM generation_batch_chunks WHERE generation_id = ? AND ordinal = 0')
        .bind(resumed.id).first<{ bytes: number[] }>();
      const corrupted = new Uint8Array(original!.bytes); corrupted[10] ^= 1;
      await db.prepare('UPDATE generation_batch_chunks SET bytes = ? WHERE generation_id = ? AND ordinal = 0')
        .bind(corrupted.buffer, resumed.id).run();
      await assert.rejects(readGenerationInputs(db, friend.id), /checksum mismatch/);
      await db.prepare('UPDATE generation_batch_chunks SET bytes = ? WHERE generation_id = ? AND ordinal = 0')
        .bind(new Uint8Array(original!.bytes).buffer, resumed.id).run();
    });

    await t.test('disabled/unknown users cannot read or admit work; invalid mixed-date batches do not alter state', async () => {
      await db.prepare('UPDATE users SET enabled = 0 WHERE id = ?').bind(owner.id).run();
      assert.equal(await readGenerationInputs(db, owner.id), undefined);
      assert.deepEqual(await admitGenerationInputs(db, owner.id, source, 'model'), { status: 'blocked' });
      assert.deepEqual(await admitGenerationInputs(db, 'missing-user', source, 'model'), { status: 'blocked' });
      await db.prepare('UPDATE users SET enabled = 1 WHERE id = ?').bind(owner.id).run();
      const before = await readGenerationInputs(db, owner.id);
      await assert.rejects(freezeGenerationInputs(db, owner.id, [source[0], { ...source[0], category: 'cs.ET', date: '2000-01-01' }], 'model'), /different announcement dates/);
      assert.deepEqual(await readGenerationInputs(db, owner.id), before);
    });

    assert.deepEqual(await readReading(db, owner.id), ownerReading);
    assert.deepEqual(await readReading(db, friend.id), friendReading);
  } finally { await fixture.close(); }
});
