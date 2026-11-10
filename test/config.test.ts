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
import { readFileSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig, parseConfig } from '../src/config.ts';
import { DEFAULT_WEIGHTS } from '../src/ranking.ts';
import { BGE_FINGERPRINT } from '../src/bge.ts';
import { scoreDigest } from '../src/scoring.ts';
import { openAppDatabase, saveDigest } from '../src/store.ts';

const text = readFileSync(new URL('../config.toml', import.meta.url), 'utf8');

test('documented TOML loads with existing defaults and custom file paths', () => {
  const config = parseConfig(text);
  assert.deepEqual(config.scoring.weights, DEFAULT_WEIGHTS);
  assert.ok(config.llm.model.trim()); // The checked-in model is intentionally editable.
  const fingerprint = JSON.parse(BGE_FINGERPRINT);
  for (const [key, value] of Object.entries(config.embedding)) assert.equal(fingerprint[key], value);
  mkdirSync('data', { recursive: true });
  const dir = mkdtempSync('data/config-test-');
  try {
    const path = join(dir, 'custom.toml');
    writeFileSync(path, text.replace(/^model = .*$/m, 'model = "openai/another-model"'));
    assert.equal(loadConfig(path).llm.model, 'openai/another-model');
  } finally { rmSync(dir, { recursive: true }); }
});

test('configuration rejects typos, unsupported backends, and invalid numeric settings', () => {
  for (const [from, to, error] of [
    ['provider = "cloudflare"', 'provider = "openai"', /provider/],
    ['dtype = "q8"', 'dtype = "fp32"', /embedding/],
    ['semantic = 0.60', 'semantic = -0.60', /weights/],
    ['semantic = 0.60', 'semantic = 0.90', /weights/],
    ['semantic = 0.60', 'semantic = nan', /weights/],
    ['semantic = 0.60', 'semantic = "0.60"', /weights/],
    ['safety_multiplier = 1.20', 'safety_multiplier = 0.9', /multiplier/],
    ['message_overhead = 32', 'message_overhead = 0.5', /overheads/],
    ['request_overhead = 64', 'request_overhead = -1', /overheads/],
    ['encoding = "o200k_base"', 'encoding = "cl100k_base"', /o200k_base/],
    [/^model = .*$/m, 'model = ""', /model/],
    ['semantic = 0.60', 'semantics = 0.60', /Unknown configuration/],
    ['semantic = 0.60', '', /Missing configuration/],
    [/^run_input_tokens = .*$/m, 'run_input_tokens = 0', /Summary limits/],
    [/^paper_input_tokens = .*$/m, 'paper_input_tokens = 1.5', /Summary limits/],
    [/^max_completion_tokens = .*$/m, 'max_completion_tokens = -1', /Summary limits/],
    [/^context_tokens = .*$/m, 'context_tokens = 0', /Summary limits/],
    ['min_similarity = 0.90', 'min_similarity = 1.0', /feedback thresholds/],
    ['min_similarity = 0.90', 'min_similarity = -0.1', /feedback thresholds/],
    ['near_duplicate_similarity = 0.95', 'near_duplicate_similarity = 0.8', /feedback thresholds/],
    ['near_duplicate_similarity = 0.95', 'near_duplicate_similarity = nan', /feedback thresholds/],
  ] as const) assert.throws(() => parseConfig(text.replace(from, to)), error);
  assert.throws(() => parseConfig('broken = ['));
});

test('configured weights affect future rankings, reuse vectors, and preserve published snapshots', async () => {
  const config = parseConfig(text.replace('semantic = 0.60', 'semantic = 0.25').replace('keywords = 0.25', 'keywords = 0.60'));
  const db = openAppDatabase(':memory:');
  let calls = 0;
  const provider = { fingerprint: 'config-test', dimensions: 2, async embed() { calls++; return [1, 0]; } };
  const profiles = [{ id: 'hardware', title: 'Hardware', subjects: ['Couplers'], keywords: ['coupler'] }];
  const batch = { category: 'quant-ph', date: '2026-11-09', sourceUrl: 'fixture', papers: [
    { id: '2611.00001', version: 1, title: 'Couplers', abstract: 'An experiment.', categories: ['quant-ph'] },
  ] };
  try {
    const digest = saveDigest(db, [batch]);
    const first = await scoreDigest(db, digest, profiles, async () => provider, () => {});
    const again = await scoreDigest(db, digest, profiles, async () => { throw new Error('Must not load model'); }, () => {}, config.scoring.weights);
    assert.deepEqual(again, first);
    const future = saveDigest(db, [{ ...batch, date: '2026-11-10' }]);
    const next = await scoreDigest(db, future, profiles, async () => provider, () => {}, config.scoring.weights);
    assert.equal(calls, 2);
    assert.deepEqual(next.semantic?.papers, first.semantic?.papers);
    const score = next.ranking!.scores['2611.00001'];
    assert.equal(score.total, 0.25 * score.semantic + 0.60 * score.keywords + 0.15 * score.feedback);
    assert.notEqual(score.total, first.ranking!.scores['2611.00001'].total);
    assert.deepEqual(next.ranking!.config.weights, config.scoring.weights);
    config.scoring.weights.semantic = 0;
    assert.equal(next.ranking!.config.weights.semantic, 0.25); // Saved config owns its values.
  } finally { db.close(); }
});
