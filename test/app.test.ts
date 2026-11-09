import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { categoriesFrom, parseFeed, pdfUrl } from '../src/arxiv.ts';
import { createDigest } from '../src/digest.ts';
import { renderDigest } from '../src/render.ts';
import { createDigestServer } from '../src/server.ts';
import { latestDigest, openAppDatabase, saveDigest } from '../src/store.ts';

const xml = readFileSync(new URL('./fixtures/quant-ph.xml', import.meta.url), 'utf8');
const batch = parseFeed(xml, 'quant-ph');

function emptyFeed(): string {
  return xml.replace(/<item>[\s\S]*?<\/item>/g, '');
}

test('recorded RSS: date, full abstract, cross-listings, and versioned PDF links', () => {
  assert.equal(batch.date, '2026-11-09');
  assert.equal(batch.papers.length, 9); // Eight new, one cross; revision omitted.
  const paper = batch.papers[0];
  assert.equal(paper.id, '2611.08518');
  assert.equal(paper.version, 1);
  assert.match(paper.abstract, /The remaining cases are sporadic zeros/);
  assert.doesNotMatch(paper.abstract, /Announce Type|^Abstract:/);
  assert.ok(paper.abstract.includes('m\\le n')); // Preserve TeX, not HTML interpretation.
  assert.equal(pdfUrl(paper), 'https://arxiv.org/pdf/2611.08518v1');
  assert.ok(batch.papers.some(p => p.categories.length > 1));
  assert.equal(parseFeed(emptyFeed(), 'quant-ph').papers.length, 0);
});

test('category normalization and malformed feeds fail clearly', () => {
  assert.deepEqual(categoriesFrom('quant-ph, cs.ET,quant-ph'), ['cs.ET', 'quant-ph']);
  for (const input of ['', '../secret', 'quant-ph,', 'https://example.com']) {
    assert.throws(() => categoriesFrom(input));
  }
  assert.throws(() => parseFeed('<rss>', 'quant-ph'), /Invalid XML/);
  assert.throws(() => parseFeed('<html>Unavailable</html>', 'quant-ph'), /Unexpected/);
  assert.throws(() => parseFeed(xml, 'cs.ET'), /Unexpected/);
  assert.throws(() => parseFeed(xml.replace(/<pubDate>.*?<\/pubDate>/g, ''), 'quant-ph'), /date/);
  assert.throws(() => parseFeed(xml.replace('Abstract:', 'Missing:'), 'quant-ph'), /Incomplete/);
  assert.throws(() => parseFeed(xml.replace('<arxiv:announce_type>new</', '<arxiv:announce_type>unknown</'), 'quant-ph'), /Unknown/);
});

test('six unique random picks are stable, and all remaining papers survive', () => {
  const digest = createDigest([batch]);
  assert.equal(digest.featuredIds.length, 6);
  assert.equal(new Set(digest.featuredIds).size, 6);
  assert.ok(digest.featuredIds.every(id => digest.papers.some(p => p.id === id)));
  assert.deepEqual(createDigest([{ ...batch, papers: [...batch.papers].reverse() }]).featuredIds, digest.featuredIds);
  const small = createDigest([{ ...batch, papers: batch.papers.slice(0, 2) }]);
  assert.equal(small.featuredIds.length, 2);
  assert.deepEqual(createDigest([{ ...batch, papers: [] }]).featuredIds, []);
  assert.throws(() => createDigest([]), /At least one/);
});

test('multiple categories deduplicate cross-listings and reject mixed announcement dates', () => {
  const other = { ...batch, category: 'cs.ET', papers: batch.papers.slice(0, 2) };
  const digest = createDigest([batch, other]);
  assert.equal(digest.papers.length, batch.papers.length);
  assert.deepEqual(digest.categories, ['cs.ET', 'quant-ph']);
  assert.deepEqual(createDigest([other, batch]), digest);
  assert.throws(() => createDigest([batch, { ...other, date: '2026-11-10' }]), /different announcement dates/);
});

test('real SQLite: current schema, immutable digest snapshots, and empty batches', () => {
  const db = openAppDatabase(':memory:');
  try {
    assert.equal(latestDigest(db, ['quant-ph']), undefined);
    const original = saveDigest(db, [batch]);
    assert.deepEqual(saveDigest(db, [batch]), original);
    assert.deepEqual(saveDigest(db, [{ ...batch, papers: [] }]), original);
    assert.deepEqual(latestDigest(db, ['quant-ph']), original);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM digests').get()?.count, 1);
    const empty = saveDigest(db, [{ ...batch, date: '2026-11-10', papers: [] }]);
    assert.deepEqual(latestDigest(db, ['quant-ph']), empty);
    assert.equal(empty.papers.length, 0);
    assert.match(renderDigest(empty), /No new papers/);
    const combined = saveDigest(db, [batch, { ...batch, category: 'cs.ET', papers: [] }]);
    assert.deepEqual(latestDigest(db, ['quant-ph', 'cs.ET']), combined);
    assert.equal(combined.papers.length, original.papers.length);
    const count = db.prepare('SELECT COUNT(*) AS count FROM digests').get()?.count;
    assert.throws(() => saveDigest(db, [
      { ...batch, category: 'math.OC', date: '2026-11-11' }, batch,
    ]), /different announcement dates/);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM digests').get()?.count, count);
  } finally { db.close(); }
});

test('HTML expands only remaining titles, links every PDF, and escapes untrusted text', () => {
  const digest = createDigest([batch]);
  const html = renderDigest(digest);
  assert.equal((html.match(/<article>/g) ?? []).length, 6);
  assert.equal((html.match(/<details>/g) ?? []).length, 3);
  assert.equal((html.match(/>PDF<\/a>/g) ?? []).length, 9);
  for (const paper of batch.papers) assert.ok(html.includes(pdfUrl(paper)));
  const dangerous = createDigest([{ ...batch, papers: [{
    ...batch.papers[0], title: '<script>alert("x")</script>', abstract: '<img src=x onerror=alert(1)> & text',
  }] }]);
  const escaped = renderDigest(dangerous);
  assert.doesNotMatch(escaped, /<script>|<img/);
  assert.match(escaped, /&lt;script&gt;/);
  assert.match(escaped, /&amp; text/);
});

test('HTTP preview serves the same saved page on refresh, with no generation', async () => {
  const db = openAppDatabase(':memory:');
  const digest = saveDigest(db, [batch]);
  db.close();
  const server = createDigestServer(digest);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const response = await fetch(base);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type')!, /text\/html/);
    const html = await response.text();
    assert.equal(html, await (await fetch(base)).text());
    assert.equal(html, renderDigest(digest));
    assert.match(response.headers.get('content-security-policy')!, /font-src 'self'/);
    const css = await fetch(`${base}/assets/katex/katex.min.css`);
    assert.equal(css.status, 200);
    assert.match(css.headers.get('content-type')!, /text\/css/);
    assert.match(await css.text(), /fonts\/KaTeX_Main-Regular.woff2/);
    const font = await fetch(`${base}/assets/katex/fonts/KaTeX_Main-Regular.woff2`);
    assert.equal(font.status, 200);
    assert.equal(font.headers.get('content-type'), 'font/woff2');
    assert.ok((await font.arrayBuffer()).byteLength > 100);
    assert.equal((await fetch(`${base}/assets/katex/fonts/not-a-font.woff2`)).status, 404);
    assert.equal((await fetch(`${base}/missing`)).status, 404);
    assert.equal((await fetch(base, { method: 'HEAD' })).status, 200);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
