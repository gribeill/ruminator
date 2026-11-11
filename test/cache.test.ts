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
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseFeed } from '../src/arxiv.ts';
import { scoreDigest } from '../src/scoring.ts';
import { downloadDay, loadDailyBatches } from '../src/load.ts';
import { prepareListing } from '../src/generate.ts';
import { readPublication, readWorkingListing } from '../src/listing-store.ts';
import { archivedBatch, cachedDownload, readDigest, openAppDatabase, openPaperDatabase, saveDownload } from '../src/store.ts';

const batch = parseFeed(readFileSync(new URL('./fixtures/quant-ph.xml', import.meta.url), 'utf8'), 'quant-ph');
const now = new Date('2026-11-10T15:00:00Z');
const log = () => {};

test('daily cache avoids repeated downloads, reuses categories, and permits explicit refresh', async () => {
  const papers = openPaperDatabase(':memory:');
  const calls: string[] = [];
  const download = async (category: string) => { calls.push(category); return { ...batch, category }; };
  try {
    const original = await loadDailyBatches(papers, ['quant-ph'], { now, download, log });
    assert.equal(calls.length, 1);
    assert.deepEqual(await loadDailyBatches(papers, ['quant-ph'], { now, download, log }), original);
    assert.equal(calls.length, 1);
    await loadDailyBatches(papers, ['quant-ph'], { now: new Date('2026-11-11T02:00:00Z'), download, log });
    assert.equal(calls.length, 1); // UTC midnight alone doesn't expire the Eastern cache.
    const tomorrow = new Date('2026-11-11T05:00:00Z');
    await loadDailyBatches(papers, ['quant-ph'], { now: tomorrow, download, log });
    assert.equal(calls.length, 2);
    const combined = await loadDailyBatches(papers, ['quant-ph', 'cs.ET'], { now: tomorrow, download, log });
    assert.deepEqual(calls, ['quant-ph', 'quant-ph', 'cs.ET']);
    assert.deepEqual(combined.map(b => b.category).sort(), ['cs.ET', 'quant-ph']);
    const refreshed = await loadDailyBatches(papers, ['quant-ph'], {
      now: tomorrow, refresh: true, log,
      download: async category => { calls.push(category); return { ...batch, papers: [] }; },
    });
    assert.equal(calls.length, 4);
    assert.deepEqual(refreshed, original);
    assert.equal(cachedDownload(papers, 'quant-ph')?.batch.papers.length, 0);
    assert.equal(archivedBatch(papers, 'quant-ph', batch.date)?.papers.length, batch.papers.length);
    assert.deepEqual(await loadDailyBatches(papers, ['quant-ph'], { now: tomorrow, download, log }), original);
    assert.equal(calls.length, 4);
  } finally { papers.close(); }
});

test('download day handles Eastern DST boundaries', () => {
  assert.equal(downloadDay(new Date('2026-07-02T03:59:00Z')), '2026-07-01');
  assert.equal(downloadDay(new Date('2026-07-02T04:00:00Z')), '2026-07-02');
  assert.equal(downloadDay(new Date('2026-12-02T04:59:00Z')), '2026-12-01');
  assert.equal(downloadDay(new Date('2026-12-02T05:00:00Z')), '2026-12-02');
});

test('failed downloads do not count as checked or publish partial digests', async () => {
  const papers = openPaperDatabase(':memory:');
  const app = openAppDatabase(':memory:');
  const calls: string[] = [];
  try {
    await assert.rejects(prepareListing(app, papers, { categories: ['quant-ph', 'cs.ET'],
      now, log, download: async category => {
        calls.push(category);
        if (category === 'cs.ET') throw new Error('Temporary outage');
        return batch;
      },
    }), /Temporary outage/);
    assert.equal(cachedDownload(papers, 'cs.ET'), undefined);
    assert.equal(readPublication(app), undefined);
    assert.equal(readWorkingListing(app), undefined);
    await prepareListing(app, papers, { categories: ['quant-ph', 'cs.ET'],
      now, log, download: async category => { calls.push(category); return { ...batch, category }; },
    });
    assert.deepEqual(calls, ['quant-ph', 'cs.ET', 'cs.ET']);
  } finally { app.close(); papers.close(); }
});

test('an empty downloaded batch is cached too', async () => {
  const papers = openPaperDatabase(':memory:');
  let calls = 0;
  const download = async () => { calls++; return { ...batch, papers: [] }; };
  try {
    await loadDailyBatches(papers, ['quant-ph'], { now, download, log });
    const batches = await loadDailyBatches(papers, ['quant-ph'], { now, download, log });
    assert.equal(calls, 1);
    assert.deepEqual(batches[0].papers, []);
  } finally { papers.close(); }
});

test('offline staging uses current feeds only, never historical common-date reconstruction', async () => {
  const papers = openPaperDatabase(':memory:');
  const app = openAppDatabase(':memory:');
  const checkedAt = now.toISOString();
  try {
    await assert.rejects(prepareListing(app, papers, { categories: ['quant-ph'], offline: true }), /No current cached feed/);
    saveDownload(papers, { batch, checkedAt });
    saveDownload(papers, { batch: { ...batch, category: 'cs.ET' }, checkedAt });
    saveDownload(papers, { batch: { ...batch, date: '2026-11-10' }, checkedAt });
    assert.equal(archivedBatch(papers, 'quant-ph', batch.date), undefined);
    await assert.rejects(prepareListing(app, papers, { categories: ['quant-ph', 'cs.ET'], offline: true }), /different announcement dates/);
    const latest = await prepareListing(app, papers, { categories: ['quant-ph'], offline: true });
    assert.equal(latest.digest.date, '2026-11-10');
  } finally { app.close(); papers.close(); }
});

test('recreating the application DB preserves source data and rebuilds a digest without downloading', async () => {
  mkdirSync('data', { recursive: true });
  const directory = mkdtempSync('data/storage-test-');
  const papersPath = join(directory, 'papers.sqlite');
  const appPath = join(directory, 'app.sqlite');
  let papers = openPaperDatabase(papersPath);
  let app = openAppDatabase(appPath);
  try {
    const original = (await prepareListing(app, papers, { categories: ['quant-ph'], now, log, download: async () => batch })).digest;
    await scoreDigest(app, original, [{ id: 'test', title: 'Test', subjects: ['Qubits'] }], async () => ({
      fingerprint: 'test', dimensions: 2, embed: async () => [1, 0],
    }), log);
    assert.ok(readDigest(app, original.date, original.categories)?.semantic);
    app.close();
    papers.close();
    const sourceBytes = readFileSync(papersPath);
    rmSync(appPath);
    papers = openPaperDatabase(papersPath);
    app = openAppDatabase(appPath);
    assert.equal(readDigest(app, original.date, original.categories), undefined);
    assert.equal(app.prepare('SELECT COUNT(*) AS n FROM embeddings').get()?.n, 0);
    assert.equal(app.prepare('SELECT COUNT(*) AS n FROM semantic_scores').get()?.n, 0);
    assert.deepEqual((await prepareListing(app, papers, { categories: ['quant-ph'], offline: true })).digest, original);
    assert.deepEqual((await prepareListing(app, papers, { categories: ['quant-ph'],
      now, log, download: async () => { throw new Error('Must reuse the independent paper cache'); },
    })).digest, original);
    assert.equal(cachedDownload(papers, 'quant-ph')?.checkedAt, now.toISOString());
    assert.deepEqual(readFileSync(papersPath), sourceBytes);
  } finally {
    app.close(); papers.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
