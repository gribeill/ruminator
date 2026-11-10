import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { parseHTML } from 'linkedom';
import type { Batch, Paper } from '../src/arxiv.ts';
import { loadConfig } from '../src/config.ts';
import { createCloudflareSummaryProvider } from '../src/cloudflare.ts';
import { generateListing, prepareListing, type GenerateOptions } from '../src/generate.ts';
import { acquireGenerationLock, pruneListingData, readPublication, readWorkingListing } from '../src/listing-store.ts';
import { openAppDatabase, openPaperDatabase, readVotes, saveVote } from '../src/store.ts';
import { createDigestServer } from '../src/server.ts';
import { SummaryError } from '../src/summaries.ts';

const config = loadConfig();
const profiles = [{ id: 'physics', title: 'Physics', subjects: ['Quantum mechanics'], keywords: [] }];
const now = new Date('2026-11-20T12:00:00Z');
const quiet = () => {};
const html = readFileSync('test/fixtures/paper.html', 'utf8');
function batch(day = 10, category = 'quant-ph'): Batch {
  return { category, date: `2026-11-${day}`, sourceUrl: 'fixture', papers: [0, 1].map(i => ({
    id: `2611.${String(day * 10 + i).padStart(5, '0')}`, version: 1, title: `Paper ${day}-${i}`,
    abstract: `Scientific abstract for ${day}-${i}.`, categories: [category], authors: ['A. Researcher'],
  })) };
}
function options(source = batch()): GenerateOptions {
  return { categories: [source.category], config, profiles, now, refresh: true,
    download: async () => source, log: quiet,
    createEmbeddingProvider: async () => ({ fingerprint: 'test', dimensions: 2, embed: async () => [1, 0] }),
    textOptions: { minIntervalMs: 0, fetcher: async () => new Response(html, { headers: { 'Content-Type': 'text/html' } }) },
    createSummaryProvider: () => ({ summarize: async () => ({ summary: 'A concrete result from a scientific paper.' }) }),
  };
}
const hash = (paper: Paper) => createHash('sha256').update(JSON.stringify({ kind: 'paper', title: paper.title, text: paper.abstract })).digest('hex');

function databases() {
  const app = openAppDatabase(':memory:'), papers = openPaperDatabase(':memory:');
  return { app, papers, close() { app.close(); papers.close(); } };
}

test('manual generation publishes one global listing; replacement prunes history but retains useful vote vectors', async () => {
  const { app, papers, close } = databases();
  try {
    const first = await generateListing(app, papers, { ...options(), summarize: true });
    assert.equal(Object.keys(first.summaries!).length, 2);
    assert.equal(papers.prepare('SELECT COUNT(*) AS n FROM paper_texts').get()!.n, 2);
    saveVote(app, first.papers[0], 1);
    const next = await generateListing(app, papers, options(batch(11, 'cs.ET')));
    assert.deepEqual(readPublication(app)!.digest, next);
    assert.deepEqual(next.categories, ['cs.ET']);
    assert.equal(next.ranking!.scores[next.papers[0].id].feedback, 0.75);
    assert.deepEqual(readVotes(app), { [first.papers[0].id]: 1 });
    assert.ok(app.prepare('SELECT 1 FROM embeddings WHERE content_hash = ?').get(hash(first.papers[0])));
    assert.equal(app.prepare('SELECT 1 FROM embeddings WHERE content_hash = ?').get(hash(first.papers[1])), undefined);
    for (const table of ['digests', 'rankings', 'semantic_scores', 'feedback_snapshots']) {
      assert.equal(app.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n, 1);
      assert.equal(app.prepare(`SELECT announcement_date FROM ${table}`).get()!.announcement_date, next.date);
    }
    for (const table of ['digest_summaries', 'summary_runs', 'summary_cache']) assert.equal(app.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n, 0);
    assert.equal(papers.prepare('SELECT COUNT(*) AS n FROM paper_texts').get()!.n, 0);
    assert.equal(papers.prepare('SELECT COUNT(*) AS n FROM batches').get()!.n, 1);
    assert.equal(papers.prepare('SELECT COUNT(*) AS n FROM feed_downloads').get()!.n, 1);
    assert.equal(papers.prepare('SELECT COUNT(*) AS n FROM paper_authors').get()!.n, 2);
    await assert.rejects(generateListing(app, papers, options(batch(10))), /go back in time/);
    assert.deepEqual(readPublication(app)!.digest, next);
  } finally { close(); }
});

test('interrupted staging survives reopen, freezes ranking inputs, and never exposes a partial listing', async () => {
  const dir = mkdtempSync('data/generation-test-');
  const appPath = join(dir, 'app.sqlite'), papersPath = join(dir, 'papers.sqlite');
  let app = openAppDatabase(appPath), papers = openPaperDatabase(papersPath);
  try {
    const first = await generateListing(app, papers, options());
    saveVote(app, first.papers[0], 1);
    const nextOptions = options(batch(11));
    await assert.rejects(generateListing(app, papers, { ...nextOptions, createEmbeddingProvider: async () => ({
      fingerprint: 'test', dimensions: 2, async embed(input) {
        if (input.title === 'Paper 11-1') throw new Error('Interrupted');
        return [1, 0];
      },
    }) }), /Interrupted/);
    assert.deepEqual(readPublication(app)!.digest, first);
    const generationId = readWorkingListing(app)!.generationId;
    app.close(); papers.close();
    app = openAppDatabase(appPath); papers = openPaperDatabase(papersPath);
    saveVote(app, first.papers[0], -1);
    const resumed = await generateListing(app, papers, { ...nextOptions,
      profiles: [{ ...profiles[0], title: 'Changed interests' }],
      config: { ...config, scoring: { weights: { semantic: 0, keywords: 1, feedback: 0 } } },
    });
    assert.equal(readPublication(app)!.generationId, generationId);
    assert.equal(resumed.semantic!.profiles[0].title, 'Physics');
    assert.deepEqual(resumed.ranking!.config.weights, config.scoring.weights);
    assert.equal(resumed.ranking!.scores[resumed.papers[0].id].feedback, 0.75);
    assert.equal(app.prepare('SELECT COUNT(*) AS n FROM digests').get()!.n, 1);
    const beforeFailure = readPublication(app);
    await assert.rejects(generateListing(app, papers, { ...options(batch(12)), download: async () => { throw new Error('Feed failure'); } }), /Feed failure/);
    assert.deepEqual(readPublication(app), beforeFailure);
    await assert.rejects(prepareListing(app, papers, { ...options(batch(12)), categories: ['quant-ph', 'cs.ET'],
      download: async category => batch(category === 'quant-ph' ? 12 : 11, category),
    }), /different announcement dates/);
    assert.deepEqual(readPublication(app), beforeFailure);
  } finally { app.close(); papers.close(); rmSync(dir, { recursive: true }); }
});

test('same-batch generation is a no-op; clear is resumable and preserves publication/votes but not text or summaries', async () => {
  const { app, papers, close } = databases();
  try {
    let paid = 0, texts = 0;
    const paidOptions = { ...options(), summarize: true,
      textOptions: { minIntervalMs: 0, fetcher: async () => { texts++; return new Response(html, { headers: { 'Content-Type': 'text/html' } }); } },
      createSummaryProvider: () => ({ async summarize() { paid++; return { summary: 'Scientific result.' }; } }),
    };
    const first = await generateListing(app, papers, paidOptions);
    saveVote(app, first.papers[0], -1);
    const never = () => { throw new Error('No calls on a published rerun'); };
    await generateListing(app, papers, { ...paidOptions, createEmbeddingProvider: never, createSummaryProvider: never });
    assert.equal(paid, 2); assert.equal(texts, 2);
    const originalPublication = readPublication(app)!;
    await assert.rejects(generateListing(app, papers, { ...options(), clear: true, createEmbeddingProvider: async () => {
      assert.deepEqual(readPublication(app), originalPublication);
      assert.equal(papers.prepare('SELECT COUNT(*) AS n FROM paper_texts').get()!.n, 0);
      throw new Error('Interrupted clear');
    } }), /Interrupted clear/);
    for (const table of ['rankings', 'semantic_scores', 'digest_summaries', 'summary_runs', 'summary_cache']) {
      assert.equal(app.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n, 0);
    }
    assert.deepEqual(readVotes(app), { [first.papers[0].id]: -1 });
    assert.notEqual(readWorkingListing(app)!.generationId, originalPublication.generationId);
    const replacement = await generateListing(app, papers, options()); // No --clear again, no paid permission.
    assert.equal(replacement.summaries, undefined);
    assert.equal(paid, 2); assert.equal(texts, 2);
    assert.notEqual(readPublication(app)!.generationId, originalPublication.generationId);
    assert.equal(replacement.ranking!.scores[first.papers[0].id].feedback, 0.25);
    const changed = batch(); changed.papers[0].title = 'Corrected upstream title';
    const corrected = await generateListing(app, papers, { ...options(changed), clear: true });
    assert.equal(corrected.papers[0].title, 'Corrected upstream title');
  } finally { close(); }
});

test('missing credentials do not claim summaries; actual API failures publish readable unavailable states', async () => {
  const { app, papers, close } = databases();
  try {
    const first = await generateListing(app, papers, options());
    await assert.rejects(generateListing(app, papers, { ...options(batch(11)), summarize: true,
      createSummaryProvider: settings => createCloudflareSummaryProvider(settings, { credentials: {} }),
    }), /Missing Cloudflare/);
    assert.deepEqual(readPublication(app)!.digest, first);
    assert.equal(app.prepare('SELECT COUNT(*) AS n FROM digest_summaries').get()!.n, 0);
    assert.equal(app.prepare('SELECT used_input_tokens FROM summary_runs').get()!.used_input_tokens, 0);
    let calls = 0;
    const result = await generateListing(app, papers, { ...options(batch(11)), summarize: true,
      createSummaryProvider: () => ({ async summarize() { calls++; throw new SummaryError('api_unavailable', 'Fixture outage'); } }),
    });
    assert.equal(calls, 2);
    assert.ok(Object.values(result.summaries!).every(s => s.status === 'api_unavailable'));
    assert.deepEqual(readPublication(app)!.digest, result);
    const unavailable = await generateListing(app, papers, { ...options(batch(12)), summarize: true,
      textOptions: { minIntervalMs: 0, fetcher: async () => new Response('Not available', { status: 404 }) },
      createSummaryProvider: () => { throw new Error('No provider needed without HTML'); },
    });
    assert.ok(Object.values(unavailable.summaries!).every(s => s.status === 'html_unavailable'));
    assert.deepEqual(readPublication(app)!.digest, unavailable);
  } finally { close(); }
});

test('FIFO retention uses latest explicit change, compacts history, and removes expired metadata/vectors', async () => {
  const { app, papers, close } = databases();
  try {
    const old = await generateListing(app, papers, options());
    const cutoff = new Date(now.getTime() - 365 * 86400_000);
    saveVote(app, old.papers[0], 1);
    app.prepare('UPDATE vote_events SET created_at = ?').run(new Date(cutoff.getTime() - 1).toISOString());
    saveVote(app, old.papers[1], 1);
    app.prepare('UPDATE vote_events SET created_at = ? WHERE arxiv_id = ?').run(new Date(cutoff.getTime() - 86400_000).toISOString(), old.papers[1].id);
    saveVote(app, old.papers[1], -1); // A real change renews this example.
    app.prepare('UPDATE vote_events SET created_at = ? WHERE event_id = (SELECT MAX(event_id) FROM vote_events)').run(cutoff.toISOString());
    const next = await generateListing(app, papers, options(batch(11)));
    assert.deepEqual(readVotes(app), { [old.papers[1].id]: -1 });
    assert.equal(app.prepare('SELECT COUNT(*) AS n FROM vote_events').get()!.n, 1);
    assert.equal(next.ranking!.feedbackSnapshot!.votes.length, 1);
    assert.equal(app.prepare('SELECT 1 FROM embeddings WHERE content_hash = ?').get(hash(old.papers[0])), undefined);
    assert.ok(app.prepare('SELECT 1 FROM embeddings WHERE content_hash = ?').get(hash(old.papers[1])));
    // Repeated use does not renew the retained timestamp; boundary is inclusive at exactly 365 days.
    assert.equal(app.prepare('SELECT created_at FROM vote_events').get()!.created_at, cutoff.toISOString());
    pruneListingData(app, papers, new Date(now.getTime() + 1));
    assert.deepEqual(readVotes(app), {});
    assert.equal(app.prepare('SELECT 1 FROM embeddings WHERE content_hash = ?').get(hash(old.papers[1])), undefined);
    assert.deepEqual(readPublication(app)!.digest.ranking!.feedbackSnapshot!.votes, []);
    assert.deepEqual(readPublication(app)!.digest.ranking!.scores, next.ranking!.scores);
    assert.equal(papers.prepare('SELECT 1 FROM paper_authors WHERE arxiv_id = ?').get(old.papers[1].id), undefined);
  } finally { close(); }
});

test('local generation lock prevents overlapping commands and is explicitly released', () => {
  const { app, close } = databases();
  try {
    const release = acquireGenerationLock(app);
    assert.throws(() => acquireGenerationLock(app), /Another listing-generation/);
    release();
    acquireGenerationLock(app)();
    assert.equal(app.prepare('SELECT COUNT(*) AS n FROM generation_lock').get()!.n, 0);
  } finally { close(); }
});

test('running server follows publications and rejects stale forms, including same-batch clear replacements', async () => {
  const { app, papers, close } = databases();
  await generateListing(app, papers, options());
  const server = createDigestServer(() => readPublication(app), { read: () => readVotes(app), write: (paper, value) => saveVote(app, paper, value) });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const form = async () => {
    const doc = parseHTML(await (await fetch(base)).text()).document;
    return new URLSearchParams({ paper: doc.querySelector('input[name="paper"]')!.getAttribute('value')!,
      token: doc.querySelector('input[name="token"]')!.getAttribute('value')!, value: '1' });
  };
  const post = (body: URLSearchParams) => fetch(`${base}/vote`, { method: 'POST', body, redirect: 'manual', headers: { Origin: base } });
  try {
    const stale = await form();
    await generateListing(app, papers, { ...options(), clear: true });
    assert.equal((await post(stale)).status, 403);
    assert.equal((await post(await form())).status, 303);
    await prepareListing(app, papers, options(batch(11)));
    assert.match(await (await fetch(base)).text(), /Announcement:.*2026-11-10/);
    await generateListing(app, papers, options(batch(11)));
    assert.match(await (await fetch(base)).text(), /Announcement:.*2026-11-11/);
    assert.equal((await fetch(`${base}/2026-11-10`)).status, 404);
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); close();
  }
});

test('generate CLI is finite, offline reruns make no calls, and clear preserves the current page on failure', async () => {
  const dir = mkdtempSync('data/generate-cli-');
  const appPath = join(dir, 'app.sqlite'), papersPath = join(dir, 'papers.sqlite');
  const app = openAppDatabase(appPath), papers = openPaperDatabase(papersPath);
  try {
    await generateListing(app, papers, options());
    const publication = readPublication(app);
    const args = ['src/cli.ts', 'generate', '--offline', '--app-db', appPath, '--papers-db', papersPath];
    let result = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /already published/);
    assert.doesNotMatch(result.stdout, /Scoring|Browse|Model response/);
    result = spawnSync(process.execPath, [...args, '--summarize'], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /cannot be combined/);
    const release = acquireGenerationLock(app);
    result = spawnSync(process.execPath, [...args, '--clear'], { encoding: 'utf8' });
    release();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Another listing-generation/);
    assert.deepEqual(readPublication(app), publication);
    // A real clear starts new working state. Isolated cwd has no model assets, so
    // offline initialization fails before loading a model, leaving the page intact.
    result = spawnSync(process.execPath, [resolve('src/cli.ts'), 'generate', '--offline', '--clear',
      '--app-db', resolve(appPath), '--papers-db', resolve(papersPath),
      '--config', resolve('config.toml'), '--profiles', resolve('interests.md')], { cwd: dir, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /model assets are not cached/);
    assert.notEqual(readWorkingListing(app)!.generationId, publication!.generationId);
    assert.deepEqual(readPublication(app), publication);
    assert.equal(app.prepare('SELECT COUNT(*) AS n FROM generation_lock').get()!.n, 0);
    // Simulate a terminated writer that left its durable PID lock behind.
    result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { openAppDatabase } from './src/store.ts';
      import { acquireGenerationLock } from './src/listing-store.ts';
      const db = openAppDatabase(${JSON.stringify(appPath)});
      acquireGenerationLock(db); db.close();
    `], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(app.prepare('SELECT COUNT(*) AS n FROM generation_lock').get()!.n, 1);
    acquireGenerationLock(app)();
    assert.equal(app.prepare('SELECT COUNT(*) AS n FROM generation_lock').get()!.n, 0);
  } finally { app.close(); papers.close(); rmSync(dir, { recursive: true }); }
});
