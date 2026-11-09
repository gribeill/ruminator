import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { parseFeed } from '../src/arxiv.ts';
import { downloadDay, loadDailyDigest } from '../src/load.ts';
import { cachedDownload, latestDigest, openDatabase, saveDigest } from '../src/store.ts';

const batch = parseFeed(readFileSync(new URL('./fixtures/quant-ph.xml', import.meta.url), 'utf8'), 'quant-ph');
const now = new Date('2026-11-10T15:00:00Z');
const log = () => {};

test('daily cache avoids repeated downloads, reuses categories, and permits explicit refresh', async () => {
  const db = openDatabase(':memory:');
  const calls: string[] = [];
  const download = async (category: string) => { calls.push(category); return { ...batch, category }; };
  try {
    const original = await loadDailyDigest(db, ['quant-ph'], { now, download, log });
    assert.equal(calls.length, 1);
    assert.deepEqual(await loadDailyDigest(db, ['quant-ph'], { now, download, log }), original);
    assert.equal(calls.length, 1);
    // UTC midnight alone doesn't invalidate a US Eastern daily cache.
    await loadDailyDigest(db, ['quant-ph'], { now: new Date('2026-11-11T02:00:00Z'), download, log });
    assert.equal(calls.length, 1);
    const tomorrow = new Date('2026-11-11T05:00:00Z');
    await loadDailyDigest(db, ['quant-ph'], { now: tomorrow, download, log });
    assert.equal(calls.length, 2); // Same announcement date, but a new download day.
    const combined = await loadDailyDigest(db, ['quant-ph', 'cs.ET'], { now: tomorrow, download, log });
    assert.deepEqual(calls, ['quant-ph', 'quant-ph', 'cs.ET']);
    assert.deepEqual(combined.categories, ['cs.ET', 'quant-ph']);
    const refreshed = await loadDailyDigest(db, ['quant-ph'], {
      now: tomorrow, refresh: true, log,
      download: async category => { calls.push(category); return { ...batch, papers: [] }; },
    });
    assert.equal(calls.length, 4);
    assert.deepEqual(refreshed, original); // Refresh never rewrites an existing digest.
    assert.equal(cachedDownload(db, 'quant-ph')?.batch.papers.length, 0);
    assert.deepEqual(await loadDailyDigest(db, ['quant-ph'], { now: tomorrow, download, log }), original);
    assert.equal(calls.length, 4);
  } finally { db.close(); }
});

test('download day handles Eastern DST boundaries', () => {
  assert.equal(downloadDay(new Date('2026-07-02T03:59:00Z')), '2026-07-01');
  assert.equal(downloadDay(new Date('2026-07-02T04:00:00Z')), '2026-07-02');
  assert.equal(downloadDay(new Date('2026-12-02T04:59:00Z')), '2026-12-01');
  assert.equal(downloadDay(new Date('2026-12-02T05:00:00Z')), '2026-12-02');
});

test('failed downloads do not count as checked or publish partial digests', async () => {
  const db = openDatabase(':memory:');
  const calls: string[] = [];
  try {
    await assert.rejects(loadDailyDigest(db, ['quant-ph', 'cs.ET'], {
      now, log, download: async category => {
        calls.push(category);
        if (category === 'cs.ET') throw new Error('Temporary outage');
        return batch;
      },
    }), /Temporary outage/);
    assert.equal(cachedDownload(db, 'cs.ET'), undefined);
    assert.equal(latestDigest(db, ['quant-ph', 'cs.ET']), undefined);
    await loadDailyDigest(db, ['quant-ph', 'cs.ET'], {
      now, log, download: async category => { calls.push(category); return { ...batch, category }; },
    });
    assert.deepEqual(calls, ['quant-ph', 'cs.ET', 'cs.ET']);
  } finally { db.close(); }
});

test('an empty downloaded batch is cached too', async () => {
  const db = openDatabase(':memory:');
  let calls = 0;
  const download = async () => { calls++; return { ...batch, papers: [] }; };
  try {
    await loadDailyDigest(db, ['quant-ph'], { now, download, log });
    const digest = await loadDailyDigest(db, ['quant-ph'], { now, download, log });
    assert.equal(calls, 1);
    assert.deepEqual(digest.papers, []);
  } finally { db.close(); }
});

test('existing schema upgrades and today\'s previously saved batch needs no new download', async () => {
  // Keep temporary files within the repository, not the operating system's /tmp.
  mkdirSync('data', { recursive: true });
  const directory = mkdtempSync('data/cache-test-');
  const filename = join(directory, 'digest.sqlite');
  const old = new DatabaseSync(filename);
  old.exec(readFileSync(new URL('../migrations/001_initial.sql', import.meta.url), 'utf8'));
  const original = saveDigest(old, [batch]);
  old.prepare('UPDATE batches SET fetched_at = ?').run('2026-11-10 15:00:00');
  old.close();
  const db = openDatabase(filename);
  try {
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 2);
    const digest = await loadDailyDigest(db, ['quant-ph'], {
      now, log, download: async () => { throw new Error('Must use saved batch'); },
    });
    assert.deepEqual(digest, original);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
