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
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Batch, Paper } from '../src/arxiv.ts';
import { loadConfig } from '../src/config.ts';
import { generateListing, prepareListing, type GenerateOptions } from '../src/generate.ts';
import { readPublication, readWorkingListing } from '../src/listing-store.ts';
import { archivedBatch, cachedDownload, openAppDatabase, openPaperDatabase, readPaperText, readVotes, savePaperText, saveVote } from '../src/store.ts';

const now = new Date('2026-11-20T12:00:00Z');
const config = loadConfig();
const html = readFileSync('test/fixtures/paper.html', 'utf8');
function batch(day = 10, category = 'quant-ph'): Batch {
  return { category, date: `2026-11-${day}`, sourceUrl: 'fixture', papers: [0, 1].map(i => ({
    id: `2611.${String(day * 10 + i).padStart(5, '0')}`, version: 1,
    title: `Paper ${day}-${i}`, abstract: `Scientific abstract ${day}-${i}`, categories: [category], authors: ['A. Researcher'],
  })) };
}
function options(source = batch()): GenerateOptions {
  return { categories: [source.category], config, now, refresh: true, log: () => {}, download: async () => source,
    profiles: [{ id: 'physics', title: 'Physics', subjects: ['Physics'] }],
    createEmbeddingProvider: async () => ({ fingerprint: 'fixture', dimensions: 2, embed: async () => [1, 0] }),
    textOptions: { minIntervalMs: 0, fetcher: async () => new Response(html, { headers: { 'Content-Type': 'text/html' } }) },
  };
}
const paperHash = (paper: Paper) => createHash('sha256').update(JSON.stringify({ kind: 'paper', title: paper.title, text: paper.abstract })).digest('hex');

/** A separate process can release its lock while DatabaseSync blocks this process. */
async function holdWriteLock(path: string, milliseconds: number) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(${JSON.stringify(path)});
    db.exec('PRAGMA busy_timeout = 1000; BEGIN IMMEDIATE');
    process.send('locked');
    setTimeout(() => { db.exec('COMMIT'); db.close(); process.disconnect(); }, ${milliseconds});
  `], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
  let stderr = '';
  child.stderr!.on('data', chunk => { stderr += chunk; });
  const exited = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Lock holder failed (${code}): ${stderr}`)));
  });
  await Promise.race([once(child, 'message'), exited.then(() => { throw new Error('Lock holder exited before readiness'); })]);
  return { exited };
}

test('summary results survive real SQLite contention without repeating provider requests', async () => {
  const dir = mkdtempSync('data/contention-test-');
  const appPath = join(dir, 'app.sqlite');
  const app = openAppDatabase(appPath), papers = openPaperDatabase(':memory:');
  const writers: Promise<void>[] = [];
  try {
    // A short local wait lets result persistence encounter the held write lock.
    app.exec('PRAGMA busy_timeout = 10');
    let calls = 0;
    const result = await generateListing(app, papers, { ...options(), summarize: true,
      createSummaryProvider: () => ({ async summarize() {
        calls++;
        writers.push((await holdWriteLock(appPath, 250)).exited);
        return { summary: 'A successfully generated scientific description.' };
      } }),
    });
    assert.equal(calls, 2);
    assert.ok(Object.values(result.summaries!).every(summary => summary.status === 'available'));
    assert.equal(app.prepare('SELECT COUNT(*) AS n FROM summary_cache').get()!.n, 2);
    assert.deepEqual(readPublication(app)!.digest, result);
  } finally { await Promise.all(writers); app.close(); papers.close(); rmSync(dir, { recursive: true }); }
});

test('summary persistence failures roll back without publishing or retrying the provider', async () => {
  const app = openAppDatabase(':memory:'), papers = openPaperDatabase(':memory:');
  let calls = 0;
  try {
    app.exec("CREATE TRIGGER reject_summary BEFORE UPDATE ON digest_summaries BEGIN SELECT RAISE(ABORT, 'fixture write failure'); END");
    await assert.rejects(generateListing(app, papers, { ...options(), summarize: true,
      createSummaryProvider: () => ({ async summarize() { calls++; return { summary: 'Successful response.' }; } }),
    }), /fixture write failure/);
    assert.equal(calls, 1);
    assert.equal(readPublication(app), undefined);
    assert.equal(app.prepare('SELECT COUNT(*) AS n FROM summary_cache').get()!.n, 0);
    const pending = JSON.parse(app.prepare('SELECT result_json FROM digest_summaries').get()!.result_json as string);
    assert.equal(pending.status, 'summarization_error');
    app.exec('BEGIN IMMEDIATE; ROLLBACK'); // Failed persistence left no transaction open.
  } finally { app.close(); papers.close(); }
});

test('fetch rejects a published batch when another batch is staged instead of reporting a false selection', async () => {
  const dir = mkdtempSync('data/staging-test-');
  const appPath = join(dir, 'app.sqlite'), papersPath = join(dir, 'papers.sqlite');
  const app = openAppDatabase(appPath), papers = openPaperDatabase(papersPath);
  try {
    await generateListing(app, papers, options());
    await prepareListing(app, papers, options(batch(10, 'cs.ET')));
    const publication = readPublication(app), working = readWorkingListing(app);
    const args = ['--offline', '--app-db', appPath, '--papers-db', papersPath];
    const rejected = spawnSync(process.execPath, ['src/cli.ts', 'fetch', ...args, '--categories', 'quant-ph'], { encoding: 'utf8' });
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /Requested batch.*quant-ph.*working batch.*cs\.ET/);
    assert.deepEqual(readPublication(app), publication);
    assert.deepEqual(readWorkingListing(app), working);
  } finally { app.close(); papers.close(); rmSync(dir, { recursive: true }); }
});

test('rejected older feeds preserve freshness, source data and the ability to rebuild offline', async () => {
  const app = openAppDatabase(':memory:'), papers = openPaperDatabase(':memory:');
  try {
    await generateListing(app, papers, options(batch(12)));
    const publication = readPublication(app), source = cachedDownload(papers, 'quant-ph');
    const archived = archivedBatch(papers, 'quant-ph', '2026-11-12');
    const authors = papers.prepare('SELECT * FROM paper_authors ORDER BY arxiv_id').all();
    await assert.rejects(generateListing(app, papers, { ...options(batch(11)), clear: true,
      now: new Date(now.getTime() + 86400_000),
    }), /older batch.*refusing to go back in time/);
    assert.deepEqual(cachedDownload(papers, 'quant-ph'), source);
    assert.deepEqual(archivedBatch(papers, 'quant-ph', '2026-11-12'), archived);
    assert.equal(archivedBatch(papers, 'quant-ph', '2026-11-11'), undefined);
    assert.deepEqual(papers.prepare('SELECT * FROM paper_authors ORDER BY arxiv_id').all(), authors);
    assert.deepEqual(readPublication(app), publication);
    const rebuilt = await generateListing(app, papers, { ...options(batch(12)), offline: true, refresh: false, clear: true,
      download: async () => { throw new Error('Offline rebuild must use preserved sources'); },
    });
    assert.equal(rebuilt.date, '2026-11-12');
    assert.notEqual(readPublication(app)!.generationId, publication!.generationId);
  } finally { app.close(); papers.close(); }
});

test('CLI rejects identical and symlink-aliased database paths before initializing schemas', () => {
  const dir = mkdtempSync('data/path-test-');
  const real = join(dir, 'real'), alias = join(dir, 'alias');
  mkdirSync(real); symlinkSync('real', alias, 'dir');
  try {
    const rejectPaths = (app: string, papers: string) => {
      const result = spawnSync(process.execPath, ['src/cli.ts', 'generate', '--offline', '--app-db', app, '--papers-db', papers], { encoding: 'utf8' });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /databases must be separate files/);
    };
    rejectPaths(join(real, 'new.sqlite'), join(real, 'new.sqlite'));
    rejectPaths(join(real, 'new.sqlite'), join(alias, 'new.sqlite'));
    assert.equal(existsSync(join(real, 'new.sqlite')), false);
  } finally { rmSync(dir, { recursive: true }); }
});

test('repeated partial feed failures retain useful downloads but not author history, even without a publication', async () => {
  const app = openAppDatabase(':memory:'), papers = openPaperDatabase(':memory:');
  try {
    for (const day of [11, 12, 13]) {
      await assert.rejects(prepareListing(app, papers, { ...options(batch(day)), categories: ['quant-ph', 'cs.ET'],
        download: async category => {
          if (category === 'cs.ET') throw new Error('Fixture feed outage');
          return batch(day);
        },
      }), /Fixture feed outage/);
      assert.equal(readPublication(app), undefined);
      assert.equal(readWorkingListing(app), undefined);
      assert.equal(cachedDownload(papers, 'quant-ph')!.batch.date, `2026-11-${day}`);
      assert.equal(papers.prepare('SELECT COUNT(*) AS n FROM batches').get()!.n, 1);
      assert.deepEqual(papers.prepare('SELECT arxiv_id FROM paper_authors ORDER BY arxiv_id').all().map(r => r.arxiv_id), batch(day).papers.map(p => p.id));
    }
    const calls: string[] = [];
    const recovered = await prepareListing(app, papers, { ...options(batch(13)), refresh: false, categories: ['quant-ph', 'cs.ET'],
      download: async category => { calls.push(category); return batch(13, category); },
    });
    assert.deepEqual(calls, ['cs.ET']); // Successful partial category was not evicted or marked stale.
    assert.equal(recovered.digest.date, '2026-11-13');
    assert.deepEqual(recovered.digest.categories, ['cs.ET', 'quant-ph']);
  } finally { app.close(); papers.close(); }
});

test('failed/mixed-date generation expires all feedback metadata while preserving publication and resumable work', async () => {
  const app = openAppDatabase(':memory:'), papers = openPaperDatabase(':memory:');
  try {
    const old = await generateListing(app, papers, options());
    saveVote(app, old.papers[0], 1);
    app.prepare('UPDATE vote_events SET created_at = ?').run(new Date(now.getTime() - 365 * 86400_000 + 1000).toISOString());
    const current = await generateListing(app, papers, options(batch(11)));
    await assert.rejects(generateListing(app, papers, { ...options(batch(12)),
      createEmbeddingProvider: async () => { throw new Error('Fixture model interruption'); },
    }), /Fixture model interruption/);
    const working = readWorkingListing(app)!;
    assert.equal(current.ranking!.feedbackSnapshot!.votes.length, 1);
    assert.ok(app.prepare('SELECT 1 FROM embeddings WHERE content_hash = ?').get(paperHash(old.papers[0])));
    for (const paper of [current.papers[0], working.digest.papers[0], batch(9).papers[0]]) {
      savePaperText(papers, { html, result: { paperId: paper.id, version: 1, status: 'available', sourceUrl: 'fixture',
        checkedAt: now.toISOString(), extractor: 'fixture', text: 'Cached scientific paper.' } });
    }
    const later = new Date(now.getTime() + 2000);
    for (const day of [13, 14]) {
      await assert.rejects(prepareListing(app, papers, { ...options(batch(day)), now: later, categories: ['quant-ph', 'cs.ET'],
        download: async category => {
          if (category === 'cs.ET') {
            if (day === 13) throw new Error('Fixture feed outage');
            return batch(13, category); // Next attempt has mismatched dates instead.
          }
          return batch(day);
        },
      }), day === 13 ? /Fixture feed outage/ : /different announcement dates/);
      assert.deepEqual(readVotes(app), {});
      assert.equal(app.prepare('SELECT 1 FROM embeddings WHERE content_hash = ?').get(paperHash(old.papers[0])), undefined);
      const frozen = JSON.parse(app.prepare('SELECT snapshot_json FROM feedback_snapshots').get()!.snapshot_json as string);
      assert.deepEqual(frozen.votes, []);
      const published = readPublication(app)!.digest;
      assert.deepEqual(published.ranking!.feedbackSnapshot!.votes, []);
      assert.deepEqual(published.ranking!.feedbackSnapshot!.examples, []);
      assert.deepEqual(published.ranking!.scores, current.ranking!.scores);
      assert.deepEqual(published.ranking!.featured, current.ranking!.featured);
      assert.equal(readWorkingListing(app)!.generationId, working.generationId);
      for (const paper of [current.papers[0], working.digest.papers[0]]) assert.ok(readPaperText(papers, paper));
      assert.equal(readPaperText(papers, batch(9).papers[0]), undefined);
      assert.equal(cachedDownload(papers, 'quant-ph')!.batch.date, `2026-11-${day}`);
    }
  } finally { app.close(); papers.close(); }
});
