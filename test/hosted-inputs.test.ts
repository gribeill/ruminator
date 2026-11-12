// Copyright 2026 Guilhem Ribeill
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { startHostedFixture } from '../scripts/hosted-fixtures.ts';
import { readReading, readUserVotes } from '../src/hosted/reading-store.ts';
import { initializeSavedConfig, readSavedConfig, readSavedInterests, saveConfig, saveInterests } from '../src/hosted/saved-inputs.ts';

const baseline = readFileSync(new URL('../config.toml', import.meta.url), 'utf8');

test('saved hosted inputs: real D1 revisions, authorization, validation, and reading independence', { timeout: 120000 }, async t => {
  const fixture = await startHostedFixture();
  const { db, owner, friend } = fixture;
  try {
    await initializeSavedConfig(db, baseline);
    const before = await Promise.all([readReading(db, owner.id), readReading(db, friend.id), readUserVotes(db, owner.id), readUserVotes(db, friend.id)]);
    const original = (await readSavedInterests(db, friend.id))!;
    const ownerInterests = await readSavedInterests(db, owner.id);

    await t.test('bootstrap preserves edits and concurrent saves admit exactly one revision', async () => {
      assert.deepEqual(await readSavedConfig(db, owner.id), { text: baseline, revision: 1 });
      const edits = [original.text + '\n<!-- first -->', original.text + '\n<!-- second -->'];
      const results = await Promise.all(edits.map(text => saveInterests(db, friend.id, original.revision, text)));
      assert.deepEqual(results.map(r => r.status).sort(), ['conflict', 'saved']);
      const winner = results.find(r => r.status === 'saved')!;
      assert.equal(winner.document.revision, original.revision + 1);
      assert.deepEqual(await readSavedInterests(db, friend.id), winner.document);
      const loser = results.find(r => r.status === 'conflict')!;
      assert.ok('text' in loser);
      assert.equal(loser.text, edits.find(text => text !== winner.document.text));
      const changed = baseline + '\n# Saved hosted edit\n';
      assert.deepEqual(await saveConfig(db, owner.id, 1, changed), { status: 'saved', document: { text: changed, revision: 2 } });
      await initializeSavedConfig(db, baseline);
      assert.deepEqual(await readSavedConfig(db, owner.id), { text: changed, revision: 2 });
      assert.deepEqual(await saveConfig(db, owner.id, 1, baseline), { status: 'conflict', text: baseline });
    });

    await t.test('invalid documents preserve submitted text and leave saved state unchanged', async () => {
      const interests = await readSavedInterests(db, friend.id);
      for (const text of ['unfinished draft', original.text + '\n## Duplicate {#qubit-hardware}\n', original.text + 'é'.repeat(32768)]) {
        const result = await saveInterests(db, friend.id, interests!.revision, text);
        assert.equal(result.status, 'invalid');
        assert.ok('text' in result && result.text === text);
      }
      assert.deepEqual(await readSavedInterests(db, friend.id), interests);
      const config = await readSavedConfig(db, owner.id);
      for (const text of ['invalid TOML =', baseline.replace('semantic = 0.60', 'semantic = 2.0'), baseline + '\n[credentials]\napi_token = "not-a-real-secret"']) {
        const result = await saveConfig(db, owner.id, config!.revision, text);
        assert.equal(result.status, 'invalid');
        assert.ok('text' in result && result.text === text);
      }
      assert.equal((await saveConfig(db, owner.id, NaN, baseline)).status, 'invalid');
      assert.deepEqual(await readSavedConfig(db, owner.id), config);
    });

    await t.test('ownership and current enabled/admin state govern writes, not stale User objects', async () => {
      assert.equal(await readSavedConfig(db, friend.id), undefined);
      assert.deepEqual(await saveConfig(db, friend.id, 2, baseline), { status: 'forbidden', text: baseline });
      assert.equal((await saveInterests(db, 'unknown-user', 1, original.text)).status, 'forbidden');
      await db.prepare('UPDATE users SET enabled = 0 WHERE id = ?').bind(friend.id).run();
      assert.equal(await readSavedInterests(db, friend.id), undefined);
      assert.equal((await saveInterests(db, friend.id, original.revision + 1, original.text)).status, 'forbidden');
      await db.prepare('UPDATE users SET enabled = 0 WHERE id = ?').bind(owner.id).run();
      assert.equal(await readSavedConfig(db, owner.id), undefined);
      assert.equal((await saveConfig(db, owner.id, 2, baseline)).status, 'forbidden');
      await db.prepare("UPDATE users SET enabled = 1, role = 'user' WHERE id = ?").bind(owner.id).run();
      assert.equal((await saveConfig(db, owner.id, 2, baseline)).status, 'forbidden');
      await db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").bind(owner.id).run();
      await db.prepare('UPDATE users SET enabled = 1 WHERE id = ?').bind(friend.id).run();
    });

    assert.deepEqual(await Promise.all([readReading(db, owner.id), readReading(db, friend.id), readUserVotes(db, owner.id), readUserVotes(db, friend.id)]), before);
    assert.deepEqual(await readSavedInterests(db, owner.id), ownerInterests);
    // The editor route still rejects a request without its validated form contract.
    const token = await fixture.access.token('friend@example.test');
    const response = await fixture.worker.fetch(fixture.origin + '/interests', { method: 'POST', headers: {
      Origin: fixture.origin, 'Cf-Access-Jwt-Assertion': token,
    } });
    assert.equal(response.status, 415);
  } finally { await fixture.close(); }
});
