import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { extractArxivHtml, HTML_EXTRACTOR, retrieveFeaturedText } from '../src/fulltext.ts';
import { latestDigest, openAppDatabase, openPaperDatabase, readPaperText, saveDigest, savePaperText } from '../src/store.ts';
import { scoreDigest } from '../src/scoring.ts';

const html = readFileSync(new URL('./fixtures/paper.html', import.meta.url), 'utf8');
const batch = { category: 'quant-ph', date: '2026-11-09', sourceUrl: 'fixture', papers: Array.from({ length: 8 }, (_, i) => ({
  id: `2611.${String(i + 1).padStart(5, '0')}`, version: 1, title: `Paper ${i}`, abstract: 'Abstract only.', categories: ['quant-ph'],
})) };
const profiles = [{ id: 'physics', title: 'Physics', subjects: ['Correlations'], keywords: [] }];
const provider = async () => ({ fingerprint: 'fulltext-test', dimensions: 2, async embed() { return [1, 0]; } });
const quiet = () => {};

test('HTML extraction keeps body structure, equations, captions, tables, and appendices, not site chrome', () => {
  const text = extractArxivHtml(html);
  assert.match(text, /1 Introduction\n/);
  assert.match(text, /service\.\n\nSeparate paragraphs/);
  assert.match(text, /α & β/);
  assert.ok(text.includes(String.raw`$F = 0.99 \\pm 0.01$`));
  assert.doesNotMatch(text, /duplicate equation|SHOULD_NOT_APPEAR|Outside navigation|Outside footer/);
  assert.match(text, /Figure 1: Simulated correlations/);
  assert.match(text, /Iterations 1000/);
  assert.match(text, /Appendix A/);
  assert.throws(() => extractArxivHtml('<html><body>Access denied</body></html>'), /No arXiv HTML/);
  assert.throws(() => extractArxivHtml('<article class="ltx_document"><div class="ltx_abstract">Abstract only.</div></article>'), /body sections/);
  assert.throws(() => extractArxivHtml(`<article class="ltx_document"><section class="ltx_section"><script>${'junk'.repeat(100)}</script></section></article>`), /body sections/);
});

test('six sequential HTML requests, persistent positive/negative caches, explicit retries, and unchanged ranking', async () => {
  const dir = mkdtempSync('data/fulltext-test-');
  const app = openAppDatabase(join(dir, 'app.sqlite'));
  let papers = openPaperDatabase(join(dir, 'papers.sqlite'));
  const digest = await scoreDigest(app, saveDigest(app, [batch]), profiles, provider, quiet);
  const original = JSON.stringify(latestDigest(app, ['quant-ph']));
  const selected = digest.ranking!.featured.map(p => p.id);
  const requested: string[] = [];
  let repaired = false;
  let active = 0;
  let maxActive = 0;
  const server = createServer((req, res) => {
    requested.push(req.url!);
    assert.equal(req.headers['user-agent'], 'ruminator/0.1 (local literature browser)');
    maxActive = Math.max(maxActive, ++active);
    setTimeout(() => {
      active--;
      const id = req.url!.split('/').pop()!.replace(/v\d+$/, '');
      if (!repaired && id === selected[1]) { res.writeHead(404); res.end('No HTML'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(!repaired && id === selected[2] ? '<html>Unavailable</html>' : html);
    }, 5);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const fetcher: typeof fetch = (url, init) => fetch(`${origin}${new URL(String(url)).pathname}`, init);
  const opts = { fetcher, minIntervalMs: 0, log: quiet };
  try {
    const first = await retrieveFeaturedText(papers, digest, opts);
    assert.equal(first.length, 6);
    assert.deepEqual(requested, selected.map(id => `/html/${id}v1`));
    assert.equal(maxActive, 1);
    assert.equal(first.filter(r => r.status === 'available').length, 4);
    assert.match(first[1].reason!, /HTTP 404/);
    assert.match(first[2].reason!, /No arXiv HTML/);
    assert.equal(first[0].contentHash, createHash('sha256').update(first[0].text!).digest('hex'));
    papers.close();
    papers = openPaperDatabase(join(dir, 'papers.sqlite'));
    assert.deepEqual(await retrieveFeaturedText(papers, digest, opts), first);
    assert.deepEqual(await retrieveFeaturedText(papers, digest, { ...opts, offline: true }), first);
    assert.equal(requested.length, 6);

    // An extractor change reuses raw HTML, including a previously invalid page.
    for (const index of [0, 2]) {
      const cached = readPaperText(papers, { id: selected[index], version: 1 })!;
      cached.result.extractor = 'older-extractor';
      savePaperText(papers, cached);
    }
    const reextracted = await retrieveFeaturedText(papers, digest, opts);
    assert.equal(reextracted[0].extractor, HTML_EXTRACTOR);
    assert.equal(reextracted[2].extractor, HTML_EXTRACTOR);
    assert.equal(requested.length, 6);

    repaired = true;
    const retried = await retrieveFeaturedText(papers, digest, { ...opts, retryUnavailable: true });
    assert.ok(retried.every(r => r.status === 'available'));
    assert.equal(requested.length, 8); // Only the two failures retried.
    assert.equal(JSON.stringify(latestDigest(app, ['quant-ph'])), original);
    app.close();
    rmSync(join(dir, 'app.sqlite'));
    const reset = openAppDatabase(join(dir, 'app.sqlite'));
    reset.close();
    assert.deepEqual(await retrieveFeaturedText(papers, digest, opts), retried);
    assert.equal(requested.length, 8); // Source cache survives application resets.
  } finally {
    if (app.isOpen) app.close();
    papers.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    rmSync(dir, { recursive: true });
  }
});

test('offline misses do not poison cache; versions are isolated and unranked previews cannot retrieve', async () => {
  const papers = openPaperDatabase(':memory:');
  const app = openAppDatabase(':memory:');
  let calls = 0;
  const fetcher: typeof fetch = async () => { calls++; return new Response(html, { headers: { 'Content-Type': 'text/html' } }); };
  try {
    const provisional = saveDigest(app, [{ ...batch, papers: batch.papers.slice(0, 1) }]);
    await assert.rejects(retrieveFeaturedText(papers, provisional, { fetcher }), /Save a ranking/);
    const digest = await scoreDigest(app, provisional, profiles, provider, quiet);
    const opts = { fetcher, minIntervalMs: 0, log: quiet };
    const miss = await retrieveFeaturedText(papers, digest, { ...opts, offline: true });
    assert.match(miss[0].reason!, /not cached/);
    assert.equal(calls, 0);
    assert.equal(readPaperText(papers, digest.papers[0]), undefined);
    await retrieveFeaturedText(papers, digest, opts);
    const nextVersion = { ...digest, papers: digest.papers.map(p => ({ ...p, version: 2 })) };
    await retrieveFeaturedText(papers, nextVersion, opts);
    assert.equal(calls, 2);
    assert.equal(readPaperText(papers, { id: digest.papers[0].id, version: 1 })!.result.status, 'available');
    await assert.rejects(retrieveFeaturedText(papers, digest, { ...opts, offline: true, retryUnavailable: true }), /offline/);
    assert.equal(calls, 2);
  } finally { app.close(); papers.close(); }
});

test('text CLI reads saved selections offline without loading a model or changing the digest', async () => {
  const dir = mkdtempSync('data/fulltext-cli-');
  const appPath = join(dir, 'app.sqlite');
  const papersPath = join(dir, 'papers.sqlite');
  const app = openAppDatabase(appPath);
  const papers = openPaperDatabase(papersPath);
  const digest = await scoreDigest(app, saveDigest(app, [{ ...batch, papers: batch.papers.slice(0, 1) }]), profiles, provider, quiet);
  const cached = await retrieveFeaturedText(papers, digest, {
    fetcher: async () => new Response(html, { headers: { 'Content-Type': 'text/html' } }), log: quiet,
  });
  app.close(); papers.close();
  try {
    const args = ['src/cli.ts', 'text', '--offline', '--app-db', appPath, '--papers-db', papersPath];
    const result = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /HTML text available/);
    assert.doesNotMatch(result.stdout, /Computing local scores|Browse http/);
    const reopened = openAppDatabase(appPath);
    assert.deepEqual(latestDigest(reopened, ['quant-ph']), digest);
    reopened.close();
    const source = openPaperDatabase(papersPath);
    assert.deepEqual(readPaperText(source, digest.papers[0])!.result, cached[0]);
    source.close();
    const invalid = spawnSync(process.execPath, [...args, '--retry-unavailable'], { encoding: 'utf8' });
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /requires text without --offline/);
  } finally { rmSync(dir, { recursive: true }); }
});

test('network, content-type, and oversize failures are explicit and cached without abstract fallback', async () => {
  for (const fetcher of [
    async () => { throw new Error('Connection failed'); },
    async () => new Response('%PDF', { headers: { 'Content-Type': 'application/pdf' } }),
    async () => new Response(html, { headers: { 'Content-Type': 'text/html', 'Content-Length': String(17 * 1024 * 1024) } }),
  ] as (typeof fetch)[]) {
    const papers = openPaperDatabase(':memory:');
    const app = openAppDatabase(':memory:');
    try {
      const digest = await scoreDigest(app, saveDigest(app, [{ ...batch, papers: batch.papers.slice(0, 1) }]), profiles, provider, quiet);
      const result = await retrieveFeaturedText(papers, digest, { fetcher, minIntervalMs: 0, log: quiet });
      assert.equal(result[0].status, 'unavailable');
      assert.ok(result[0].reason);
      assert.equal(result[0].text, undefined);
      const cached = await retrieveFeaturedText(papers, digest, { fetcher: async () => { throw new Error('Must not retry'); }, log: quiet });
      assert.deepEqual(cached, result);
    } finally { app.close(); papers.close(); }
  }
});
