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

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../src/config.ts';
import { prepareListing } from '../src/generate.ts';
import { freezeGenerationInputs, readWorkingListing } from '../src/listing-store.ts';
import { captureFeedback, openAppDatabase, openPaperDatabase, saveVote } from '../src/store.ts';

const config = loadConfig();
const profiles = [{ id: 'physics', title: 'Original interests', subjects: ['Physics'] }];
const source = { category: 'quant-ph', date: '2026-11-11', sourceUrl: 'fixture', papers: [
  { id: '2611.00001', version: 1, title: 'Paper', abstract: 'Scientific abstract', categories: ['quant-ph'] },
] };

test('feedback persistence errors roll back inputs and leave standalone feedback capture usable', async () => {
  const app = openAppDatabase(':memory:'), papers = openPaperDatabase(':memory:');
  try {
    const { digest } = await prepareListing(app, papers, { categories: ['quant-ph'], download: async () => source, log: () => {} });
    saveVote(app, source.papers[0], 1);
    app.exec("CREATE TRIGGER fail_feedback AFTER INSERT ON feedback_snapshots BEGIN SELECT RAISE(ABORT, 'fixture feedback failure'); END");
    assert.throws(() => freezeGenerationInputs(app, { config, profiles }), /fixture feedback failure/);
    assert.equal(readWorkingListing(app)!.inputs, undefined);
    assert.equal(app.prepare('SELECT COUNT(*) AS n FROM feedback_snapshots').get()!.n, 0);
    assert.equal(app.isTransaction, false);
    app.exec('DROP TRIGGER fail_feedback');
    const snapshot = captureFeedback(app, digest, config.feedback);
    assert.equal(snapshot.votes[0].value, 1);
    assert.equal(app.isTransaction, false);
    freezeGenerationInputs(app, { config, profiles });
    assert.deepEqual(captureFeedback(app, digest, config.feedback), snapshot);
  } finally { app.close(); papers.close(); }
});
