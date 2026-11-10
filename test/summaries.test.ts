import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { createCloudflareSummaryProvider } from '../src/cloudflare.ts';
import { loadConfig, type Config } from '../src/config.ts';
import { renderDigest } from '../src/render.ts';
import { scoreDigest } from '../src/scoring.ts';
import { claimSummary, latestDigest, openAppDatabase, openPaperDatabase, readPaperText, readSummaries, saveDigest, savePaperText, startSummaryRun } from '../src/store.ts';
import { summarizeFeatured, summaryMessages, SUMMARY_PROMPT_VERSION, validateSummary, type PaperSummary, type SummaryProvider } from '../src/summaries.ts';
import { estimatePromptTokens } from '../src/tokenizer.ts';

const quiet = () => {};
const config = loadConfig();
const summary = 'The paper investigates correlations in a numerical model. The authors simulate changing boundary conditions. They find stable correlations within the tested finite system.';
const batch = { category: 'quant-ph', date: '2026-11-09', sourceUrl: 'fixture', papers: Array.from({ length: 8 }, (_, i) => ({
  id: `2611.${String(i + 1).padStart(5, '0')}`, version: 1, title: `Paper ${i}`, abstract: `Readable abstract ${i}.`, categories: ['quant-ph'],
})) };
const profiles = [{ id: 'physics', title: 'Physics', subjects: ['Correlations'], keywords: [] }];
const embedder = async () => ({ fingerprint: 'summary-test', dimensions: 2, async embed() { return [1, 0]; } });
const body = 'Full scientific paper text with numerical results, methods, and limitations. '.repeat(20);

async function setup(count = 8, appPath = ':memory:', papersPath = ':memory:') {
  const app = openAppDatabase(appPath);
  const papers = openPaperDatabase(papersPath);
  const digest = await scoreDigest(app, saveDigest(app, [{ ...batch, papers: batch.papers.slice(0, count) }]), profiles, embedder, quiet);
  for (const { id } of digest.ranking!.featured) {
    savePaperText(papers, { html: '<article>cached</article>', result: {
      paperId: id, version: 1, status: 'available', text: body,
      contentHash: createHash('sha256').update(body).digest('hex'), extractor: 'test-html-v1',
      sourceUrl: `https://arxiv.org/html/${id}v1`, checkedAt: '2026-11-09T12:00:00Z',
    } });
  }
  return { app, papers, digest };
}

function goodResponse() {
  return { model: 'resolved-model', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: summary } }],
    usage: { prompt_tokens: 100, completion_tokens: 80, completion_tokens_details: { reasoning_tokens: 20 } } };
}

test('six sequential calls use full text; persist summaries/provenance/usage and reuse successes across digests', async () => {
  const { app, papers, digest } = await setup();
  const originalRanking = JSON.stringify(digest.ranking);
  let requests = 0, active = 0, maxActive = 0;
  const logs: string[] = [];
  const server = createServer(async (req, res) => {
    requests++;
    maxActive = Math.max(maxActive, ++active);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString());
    assert.equal(req.headers.authorization, 'Bearer test-secret');
    assert.equal(req.headers['cf-aig-max-attempts'], '1');
    assert.equal(payload.model, config.llm.model);
    assert.equal(payload.max_completion_tokens, 2048);
    assert.equal(payload.messages.length, 2);
    assert.ok(payload.messages[1].content.includes(body));
    assert.ok(!payload.messages[1].content.includes('Readable abstract'));
    setTimeout(() => {
      active--;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(goodResponse()));
    }, 5);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const factory = (saved: Config | Pick<Config, 'llm' | 'tokenizer' | 'summaries'>) => createCloudflareSummaryProvider(saved, {
      credentials: { accountId: 'test-account', apiToken: 'test-secret', gatewayId: 'test-gateway' },
      fetcher: (_url, init) => fetch(base, init), verbose: true, log: line => logs.push(line),
    });
    const first = await summarizeFeatured(app, papers, digest, config, factory, quiet);
    assert.equal(requests, 6);
    assert.equal(maxActive, 1);
    assert.equal(logs.length, 6);
    assert.ok(logs.every(line => line.includes('Model response for arXiv:') && line.includes(JSON.stringify(goodResponse()))));
    assert.ok(logs.every(line => !line.includes('test-secret')));
    const results = Object.values(first.summaries!);
    assert.equal(results.length, 6);
    for (const result of results) {
      assert.equal(result.status, 'available');
      assert.equal(result.summary, summary);
      assert.equal(result.provenance!.actualModel, 'resolved-model');
      assert.equal(result.provenance!.promptVersion, SUMMARY_PROMPT_VERSION);
      assert.equal(result.usage!.reasoningTokens, 20);
    }
    assert.equal(JSON.stringify(first.ranking), originalRanking);
    assert.deepEqual(first.semantic, digest.semantic);
    assert.deepEqual(latestDigest(app, ['quant-ph'])!.summaries, first.summaries);
    const never = () => { throw new Error('Must reuse cache'); };
    assert.deepEqual(await summarizeFeatured(app, papers, digest, { ...config, llm: { provider: 'cloudflare', model: 'changed' } }, never, quiet), first);
    const next = await scoreDigest(app, saveDigest(app, [{ ...batch, date: '2026-11-10' }]), profiles, embedder, quiet);
    // Use the same saved selections to exercise all six cache entries.
    next.ranking = digest.ranking;
    const reused = await summarizeFeatured(app, papers, next, config, never, quiet);
    assert.ok(Object.values(reused.summaries!).every(r => r.status === 'available'));
    const run = app.prepare('SELECT used_input_tokens FROM summary_runs WHERE announcement_date = ?').get(next.date);
    assert.equal(run!.used_input_tokens, 0);
    assert.equal(requests, 6);
    const rendered = renderDigest(first);
    assert.equal((rendered.match(/AI summary/g) ?? []).length, 6);
    assert.ok(rendered.indexOf(summary) < rendered.indexOf('Readable abstract'));
  } finally {
    app.close(); papers.close(); server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test('budget boundaries, output reservation, and latch: failed calls still spend budget and skipped outcomes never retry', async () => {
  const { app, papers, digest } = await setup();
  try {
    const first = digest.papers.find(p => p.id === digest.ranking!.featured[0].id)!;
    const estimate = estimatePromptTokens(summaryMessages(first, body), config.tokenizer).estimatedInputTokens;
    const bounded = { ...config, summaries: { ...config.summaries, run_input_tokens: estimate } };
    let calls = 0;
    const failing: SummaryProvider = { async summarize() { calls++; throw new Error('A failed call can still cost tokens'); } };
    const result = await summarizeFeatured(app, papers, digest, bounded, () => failing, quiet);
    assert.equal(calls, 1); // Exact boundary admits one request.
    assert.equal(result.summaries![first.id].status, 'summarization_error');
    assert.equal(Object.values(result.summaries!).filter(r => r.status === 'token_budget').length, 5);
    assert.equal(app.prepare('SELECT used_input_tokens FROM summary_runs').get()!.used_input_tokens, estimate);
    await summarizeFeatured(app, papers, digest, config, () => { throw new Error('No retries'); }, quiet);
    assert.equal(calls, 1);
    const html = renderDigest(result);
    assert.match(html, /Summary unavailable: exhausted token budget/);
    assert.match(html, /Summary unavailable: summarization error/);
  } finally { app.close(); papers.close(); }

  for (const limits of [
    { ...config.summaries, paper_input_tokens: 1 },
    { ...config.summaries, context_tokens: config.summaries.max_completion_tokens + 1 },
  ]) {
    const { app, papers, digest } = await setup(1);
    try {
      const result = await summarizeFeatured(app, papers, digest, { ...config, summaries: limits }, () => { throw new Error('Must skip oversized paper'); }, quiet);
      assert.equal(Object.values(result.summaries!)[0].status, 'token_budget');
      assert.equal(app.prepare('SELECT used_input_tokens FROM summary_runs').get()!.used_input_tokens, 0);
    } finally { app.close(); papers.close(); }
  }
});

test('HTML unavailable and API unavailable are distinct permanent states; no abstraction fallback', async () => {
  const { app, papers, digest } = await setup(2);
  try {
    const missingId = digest.ranking!.featured[0].id;
    const record = readPaperText(papers, { id: missingId, version: 1 })!;
    record.result = { ...record.result, status: 'unavailable', text: undefined, reason: 'HTTP 404' };
    savePaperText(papers, record);
    const result = await summarizeFeatured(app, papers, digest, config, saved => createCloudflareSummaryProvider(saved, { credentials: {} }), quiet);
    assert.equal(result.summaries![missingId].status, 'html_unavailable');
    const apiId = digest.ranking!.featured[1].id;
    assert.equal(result.summaries![apiId].status, 'api_unavailable');
    const html = renderDigest(result);
    assert.match(html, /Summary unavailable: HTML unavailable/);
    assert.match(html, /Summary unavailable: API unavailable/);
    assert.match(html, /Readable abstract/);
    savePaperText(papers, { ...record, result: { ...record.result, status: 'available', text: body } });
    await summarizeFeatured(app, papers, digest, config, () => { throw new Error('No retry after fixing HTML or credentials'); }, quiet);
    assert.equal(readSummaries(app, digest)[missingId].status, 'html_unavailable');
  } finally { app.close(); papers.close(); }
});

test('adapter classifies invalid, refused, truncated, HTTP and network responses with exactly one attempt', async () => {
  const fixtures = [
    { status: 503, body: '{}', expected: 'api_unavailable' },
    { status: 400, body: '{}', expected: 'summarization_error' },
    { status: 200, body: 'not JSON', expected: 'summarization_error' },
    { status: 200, body: JSON.stringify({ choices: [] }), expected: 'summarization_error' },
    { status: 200, body: JSON.stringify({ ...goodResponse(), choices: [{ finish_reason: 'stop', message: { refusal: 'No' } }] }), expected: 'summarization_error' },
    { status: 200, body: JSON.stringify({ ...goodResponse(), choices: [{ finish_reason: 'length', message: { content: 'Partial' } }] }), expected: 'token_budget' },
    { status: 200, body: JSON.stringify({ ...goodResponse(), choices: [{ finish_reason: 'stop', message: { content: '  ' } }] }), expected: 'summarization_error' },
    { status: 0, body: '', expected: 'api_unavailable' },
  ];
  for (const fixture of fixtures) {
    const { app, papers, digest } = await setup(1);
    let calls = 0;
    try {
      const result = await summarizeFeatured(app, papers, digest, config, saved => createCloudflareSummaryProvider(saved, {
        credentials: { accountId: 'account', apiToken: 'secret', gatewayId: 'gateway' },
        fetcher: async () => { calls++; if (!fixture.status) throw new Error('secret'); return new Response(fixture.body, { status: fixture.status }); },
      }), quiet);
      const outcome = Object.values(result.summaries!)[0];
      assert.equal(outcome.status, fixture.expected);
      if (fixture.body.includes('prompt_tokens')) assert.equal(outcome.usage!.inputTokens, 100);
      assert.ok(!JSON.stringify(outcome).includes('secret'));
      await summarizeFeatured(app, papers, digest, config, () => { throw new Error('No retry'); }, quiet);
      assert.equal(calls, 1);
    } finally { app.close(); papers.close(); }
  }
});

test('summary snapshots survive reopening and CLI accepts both verbose flags without offline network calls', async () => {
  const dir = mkdtempSync('data/summary-test-');
  const appPath = join(dir, 'app.sqlite');
  const papersPath = join(dir, 'papers.sqlite');
  const { app, papers, digest } = await setup(1, appPath, papersPath);
  const result = await summarizeFeatured(app, papers, digest, config, () => ({ async summarize() { return { summary }; } }), quiet);
  app.close(); papers.close();
  try {
    for (const flag of ['-v', '--verbose']) {
      const child = spawnSync(process.execPath, ['src/cli.ts', 'summarize', flag, '--offline', '--app-db', appPath, '--papers-db', papersPath], { encoding: 'utf8' });
      assert.equal(child.status, 0, child.stderr);
      assert.match(child.stdout, /Offline: using saved summaries/);
      assert.doesNotMatch(child.stdout, /Model response for|Computing local scores/);
    }
    const reopened = openAppDatabase(appPath);
    assert.deepEqual(latestDigest(reopened, ['quant-ph']), result);
    reopened.close();
    const invalid = spawnSync(process.execPath, ['src/cli.ts', 'score', '-v'], { encoding: 'utf8' });
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /--verbose requires summarize/);
  } finally { rmSync(dir, { recursive: true }); }
});

test('explicit CLI --clear deletes all summary state only, exits without generation, and needs no saved digest', async () => {
  const dir = mkdtempSync('data/summary-clear-');
  const appPath = join(dir, 'app.sqlite');
  const papersPath = join(dir, 'papers.sqlite');
  const unusedPapers = join(dir, 'unused', 'papers.sqlite');
  const { app, papers, digest } = await setup(1, appPath, papersPath);
  await summarizeFeatured(app, papers, digest, config, () => ({ async summarize() { return { summary }; } }), quiet);
  const later = await scoreDigest(app, saveDigest(app, [{ ...batch, date: '2026-11-10', papers: batch.papers.slice(0, 1) }]), profiles, embedder, quiet);
  await summarizeFeatured(app, papers, later, config, () => { throw new Error('Cache should be reused'); }, quiet);
  const tables = ['digests', 'embeddings', 'rankings', 'semantic_scores'];
  const before = Object.fromEntries(tables.map(table => [table, app.prepare(`SELECT * FROM ${table}`).all()]));
  app.close(); papers.close();
  const sourceBytes = readFileSync(papersPath);
  const args = ['--app-db', appPath, '--papers-db', unusedPapers];
  try {
    const rejected = spawnSync(process.execPath, ['src/cli.ts', 'score', '--clear', ...args], { encoding: 'utf8' });
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /--clear requires summarize/);
    const intact = openAppDatabase(appPath);
    assert.equal(intact.prepare('SELECT COUNT(*) AS n FROM digest_summaries').get()!.n, 2);
    assert.equal(intact.prepare('SELECT COUNT(*) AS n FROM summary_runs').get()!.n, 2);
    assert.equal(intact.prepare('SELECT COUNT(*) AS n FROM summary_cache').get()!.n, 1);
    intact.close();

    const cleared = spawnSync(process.execPath, ['src/cli.ts', 'summarize', '--clear', ...args], { encoding: 'utf8' });
    assert.equal(cleared.status, 0, cleared.stderr);
    assert.match(cleared.stdout, /Cleared all summary outcomes, cache entries, and run budgets/);
    assert.match(cleared.stdout, /No API calls made/);
    assert.doesNotMatch(cleared.stdout, /summary available|Model response for|Computing local scores/);
    assert.equal(existsSync(unusedPapers), false);
    assert.equal(existsSync(join(dir, 'unused')), false);
    assert.deepEqual(readFileSync(papersPath), sourceBytes);
    const reopened = openAppDatabase(appPath);
    for (const table of ['digest_summaries', 'summary_cache', 'summary_runs']) {
      assert.equal(reopened.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n, 0);
    }
    for (const table of tables) assert.deepEqual(reopened.prepare(`SELECT * FROM ${table}`).all(), before[table]);
    assert.equal(latestDigest(reopened, ['quant-ph'])!.summaries, undefined);
    reopened.close();
    const emptyPath = join(dir, 'empty.sqlite');
    const empty = spawnSync(process.execPath, ['src/cli.ts', 'summarize', '--clear', '--offline', '--app-db', emptyPath, '--papers-db', unusedPapers], { encoding: 'utf8' });
    assert.equal(empty.status, 0, empty.stderr);
    assert.match(empty.stdout, /No API calls made/);
    assert.equal(existsSync(unusedPapers), false);
  } finally { rmSync(dir, { recursive: true }); }
});

test('run budget stops subsequent requests even if a later smaller paper would fit', async () => {
  const { app, papers, digest } = await setup(3);
  try {
    const [first, second, third] = digest.ranking!.featured.map(({ id }) => digest.papers.find(p => p.id === id)!);
    const shortText = 'A short full-text fixture.';
    const editText = (id: string, text: string) => {
      const cached = readPaperText(papers, { id, version: 1 })!;
      cached.result.text = text;
      savePaperText(papers, cached);
    };
    editText(second.id, body.repeat(10));
    editText(third.id, shortText);
    const firstTokens = estimatePromptTokens(summaryMessages(first, body), config.tokenizer).estimatedInputTokens;
    const thirdTokens = estimatePromptTokens(summaryMessages(third, shortText), config.tokenizer).estimatedInputTokens;
    const bounded = { ...config, summaries: { ...config.summaries, run_input_tokens: firstTokens + thirdTokens } };
    let calls = 0;
    const result = await summarizeFeatured(app, papers, digest, bounded, () => ({ async summarize() { calls++; return { summary }; } }), quiet);
    assert.equal(calls, 1);
    assert.equal(result.summaries![first.id].status, 'available');
    assert.equal(result.summaries![second.id].status, 'token_budget');
    assert.equal(result.summaries![third.id].status, 'token_budget');
  } finally { app.close(); papers.close(); }
});

test('new model/text inputs invalidate reusable summaries, while interrupted runs retain their saved configuration', async () => {
  const { app, papers, digest } = await setup(1);
  let calls = 0;
  const factory = () => ({ async summarize() { calls++; return { summary }; } });
  try {
    const first = await summarizeFeatured(app, papers, digest, config, factory, quiet);
    const second = await scoreDigest(app, saveDigest(app, [{ ...batch, date: '2026-11-10', papers: batch.papers.slice(0, 1) }]), profiles, embedder, quiet);
    const changedModel = { ...config, llm: { provider: 'cloudflare' as const, model: 'new-model' } };
    startSummaryRun(app, second, changedModel);
    const secondResult = await summarizeFeatured(app, papers, second, config, saved => {
      assert.equal(saved.llm.model, 'new-model');
      return factory();
    }, quiet);
    assert.equal(calls, 2);
    const id = digest.papers[0].id;
    assert.notEqual(first.summaries![id].cacheKey, secondResult.summaries![id].cacheKey);
    const cached = readPaperText(papers, digest.papers[0])!;
    cached.result.text += '\nA new extraction includes additional scientific context.';
    savePaperText(papers, cached);
    const third = await scoreDigest(app, saveDigest(app, [{ ...batch, date: '2026-11-11', papers: batch.papers.slice(0, 1) }]), profiles, embedder, quiet);
    const thirdResult = await summarizeFeatured(app, papers, third, config, factory, quiet);
    assert.equal(calls, 3);
    assert.notEqual(thirdResult.summaries![id].cacheKey, first.summaries![id].cacheKey);
  } finally { app.close(); papers.close(); }
});

test('an interrupted request is claimed durably and never retried; successful output is safely rendered', async () => {
  const { app, papers, digest } = await setup(1);
  try {
    const paper = digest.papers[0];
    startSummaryRun(app, digest, config);
    const pending: PaperSummary = { paperId: paper.id, version: paper.version, status: 'summarization_error', createdAt: new Date().toISOString(), detail: 'Interrupted' };
    assert.equal(claimSummary(app, digest, pending, 100), true);
    assert.equal(claimSummary(app, digest, pending, 100), false);
    await summarizeFeatured(app, papers, digest, config, () => { throw new Error('Already attempted'); }, quiet);
    assert.equal(app.prepare('SELECT used_input_tokens FROM summary_runs').get()!.used_input_tokens, 100);
    const dangerous = { ...digest, summaries: { [paper.id]: { ...pending, status: 'available' as const, summary: '<script>alert(1)</script> $x^2$ & text.' } } };
    const html = renderDigest(dangerous);
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /&lt;script&gt;/);
    assert.match(html, /katex/);
    assert.match(html, /&amp; text/);
    assert.match(renderDigest(digest), /Summary unavailable: not generated/);
    assert.throws(() => validateSummary('```bad```'));
    assert.throws(() => validateSummary('x'.repeat(4001)));
  } finally { app.close(); papers.close(); }
});
