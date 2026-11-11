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
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { fetchBatch, MAX_RSS_BYTES } from '../src/arxiv.ts';
import { createCloudflareSummaryProvider, MAX_SUMMARY_RESPONSE_BYTES } from '../src/cloudflare.ts';
import { loadConfig } from '../src/config.ts';
import { readResponseText, ResponseTooLargeError } from '../src/http-body.ts';
import { SummaryError } from '../src/summaries.ts';

function streamed(chunks: Uint8Array[], headers: HeadersInit = {}) {
  let pulls = 0, cancellations = 0;
  const response = new Response(new ReadableStream({
    pull(controller) {
      const chunk = chunks[pulls++];
      if (chunk) controller.enqueue(chunk); else controller.close();
    },
    cancel() { cancellations++; },
  }, { highWaterMark: 0 }), { headers });
  return { response, pulls: () => pulls, cancellations: () => cancellations };
}

test('bounded text reads preserve split UTF-8 and enforce exact byte boundaries', async () => {
  const bytes = Buffer.from('α🙂');
  const exact = streamed([bytes.subarray(0, 1), bytes.subarray(1, 3), bytes.subarray(3)]);
  assert.equal(await readResponseText(exact.response, bytes.length), 'α🙂');
  assert.equal(exact.cancellations(), 0);
  const tooSmall = streamed([bytes]);
  await assert.rejects(readResponseText(tooSmall.response, bytes.length - 1), ResponseTooLargeError);
  assert.equal(tooSmall.cancellations(), 1);
  assert.equal(await readResponseText(new Response(null), 8), '');
  assert.equal(await readResponseText(new Response('\uFEFFbody'), 8), '\uFEFFbody');
  assert.equal(await readResponseText(new Request('http://localhost/form', { method: 'POST', body: 'vote=1' }), 8), 'vote=1');
});

test('declared, missing, or misleading lengths cannot bypass the stream limit; overflow cancels without reading the rest', async () => {
  const declared = streamed([Buffer.from('never read')], { 'Content-Length': '9' });
  await assert.rejects(readResponseText(declared.response, 8), /8 byte limit/);
  assert.equal(declared.pulls(), 0);
  assert.equal(declared.cancellations(), 1);
  for (const headers of [new Headers(), new Headers({ 'Content-Length': '1' })]) {
    const oversized = streamed([Buffer.from('12345678'), Buffer.from('9'), Buffer.from('unread tail')], headers);
    await assert.rejects(readResponseText(oversized.response, 8), ResponseTooLargeError);
    assert.equal(oversized.pulls(), 2);
    assert.equal(oversized.cancellations(), 1);
  }
  const failed = new Response(new ReadableStream({ start(controller) { controller.error(new Error('Fixture read failure')); } }));
  await assert.rejects(readResponseText(failed, 8), /Fixture read failure/);
  assert.equal(failed.body!.locked, false);
});

test('RSS and summary adapters bound real chunked/compressed HTTP bodies before parsing or verbose logging', async () => {
  const xml = readFileSync('test/fixtures/quant-ph.xml', 'utf8');
  const compressed = gzipSync(Buffer.concat([Buffer.from(xml), Buffer.alloc(MAX_RSS_BYTES, 32)]));
  assert.ok(compressed.length < MAX_RSS_BYTES);
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url!);
    if (req.url === '/rss') {
      res.writeHead(200, { 'Content-Type': 'application/xml', 'Transfer-Encoding': 'chunked' });
      res.end(xml);
    } else if (req.url === '/rss-compressed') {
      res.writeHead(200, { 'Content-Encoding': 'gzip', 'Content-Length': compressed.length });
      res.end(compressed);
    } else if (req.url === '/rss-large') {
      res.writeHead(200, { 'Transfer-Encoding': 'chunked' });
      res.end(Buffer.alloc(MAX_RSS_BYTES + 1, 120));
    } else if (req.url === '/rss-error') {
      res.writeHead(503); res.end('Temporary outage');
    } else if (req.url === '/api') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' });
      res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'Scientific description.' } }] }));
    } else if (req.url === '/api-declared') {
      res.writeHead(200, { 'Content-Length': MAX_SUMMARY_RESPONSE_BYTES + 1 });
      res.flushHeaders(); // Client should reject/cancel without waiting for any body.
    } else {
      res.writeHead(req.url === '/api-error-large' ? 503 : 200, { 'Transfer-Encoding': 'chunked' });
      res.end(Buffer.alloc(MAX_SUMMARY_RESPONSE_BYTES + 1, 120));
    }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const fetcher = (path: string): typeof fetch => (_url, init) => fetch(base + path, init);
  try {
    assert.ok((await fetchBatch('quant-ph', fetcher('/rss'))).papers.length > 0);
    for (const path of ['/rss-large', '/rss-compressed']) {
      await assert.rejects(fetchBatch('quant-ph', fetcher(path)), ResponseTooLargeError);
    }
    await assert.rejects(fetchBatch('quant-ph', fetcher('/rss-error')), /HTTP 503/);
    const logs: string[] = [];
    const provider = (path: string) => createCloudflareSummaryProvider(loadConfig(), {
      credentials: { accountId: 'fixture-account', apiToken: 'fixture-secret', gatewayId: 'fixture-gateway' },
      fetcher: fetcher(path), verbose: true, log: line => logs.push(line),
    });
    assert.equal((await provider('/api').summarize([{ role: 'user', content: 'Paper' }], 2048)).summary, 'Scientific description.');
    assert.equal(logs.length, 1);
    for (const path of ['/api-large', '/api-error-large', '/api-declared']) {
      await assert.rejects(provider(path).summarize([{ role: 'user', content: 'Paper' }], 2048),
        (error: unknown) => error instanceof SummaryError && error.kind === 'summarization_error' && /1 MiB size limit/.test(error.message));
      assert.equal(logs.length, 1); // Never print a truncated/oversized body, including HTTP errors.
      assert.equal(requests.filter(request => request === path).length, 1);
    }
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
