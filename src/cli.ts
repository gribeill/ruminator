import { existsSync, mkdirSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { categoriesFrom } from './arxiv.ts';
import { clearSummaries, openAppDatabase, openPaperDatabase, readVotes, saveVote } from './store.ts';
import { loadDailyDigest, loadSavedDigest } from './load.ts';
import { createDigestServer } from './server.ts';
import { createBgeProvider } from './bge.ts';
import { loadProfiles } from './profiles.ts';
import { scoreDigest } from './scoring.ts';
import { loadConfig } from './config.ts';
import { retrieveFeaturedText } from './fulltext.ts';
import { reportSummaryTokens, summarizeFeatured } from './summaries.ts';
import { createCloudflareSummaryProvider } from './cloudflare.ts';

const usage = `ruminator — a local arXiv browser

Usage: npm run <start|fetch|serve|score|text|summarize> -- [options]
  start                  Use today's cached download, or download, then serve
  fetch                  Use today's cached download, or download, and save only
  serve                  Serve saved data without network access or inference
  score                  Score the latest saved digest (never contacts arXiv)
  text                   Cache HTML text for saved featured papers only
  summarize              Summarize featured cached text (paid calls; no retries)
  -v, --verbose          Print full model responses (summarize only)
  --clear                Delete ALL summary state and exit; no API calls (summarize only)
  --tokens               Print per-paper and total token estimates, then exit; no API calls
  --categories quant-ph  Comma-separated arXiv categories
  --app-db data/app.sqlite       Disposable application state
  --papers-db data/papers.sqlite Downloaded paper information and source metadata
  --port 3000            Local preview port
  --refresh              Bypass daily download cache (start/fetch only)
  --config config.toml   Model, scoring, and tokenizer configuration
  --profiles interests.md Research-interest Markdown file
  --offline              Use saved data and cached assets only; no network
  --retry-unavailable    Retry unavailable HTML (text only; successes stay cached)
`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      categories: { type: 'string', default: 'quant-ph' },
      'app-db': { type: 'string', default: 'data/app.sqlite' },
      'papers-db': { type: 'string', default: 'data/papers.sqlite' },
      port: { type: 'string', default: '3000' },
      refresh: { type: 'boolean', default: false },
      'retry-unavailable': { type: 'boolean', default: false },
      offline: { type: 'boolean', default: false },
      profiles: { type: 'string', default: 'interests.md' },
      config: { type: 'string', default: 'config.toml' },
      help: { type: 'boolean', short: 'h' },
      verbose: { type: 'boolean', short: 'v', default: false },
      clear: { type: 'boolean', default: false },
      tokens: { type: 'boolean', default: false },
    },
  });
  if (values.help) { console.log(usage); return; }
  const command = positionals[0];
  if (positionals.length !== 1 || !['start', 'fetch', 'serve', 'score', 'text', 'summarize'].includes(command)) throw new Error(usage);
  if (values.verbose && command !== 'summarize') throw new Error('--verbose requires summarize');
  if (values.clear && command !== 'summarize') throw new Error('--clear requires summarize');
  if (values.tokens && command !== 'summarize') throw new Error('--tokens requires summarize');
  if (values.tokens && values.clear) throw new Error('--tokens cannot be combined with --clear');
  if (values['retry-unavailable'] && (command !== 'text' || values.offline)) {
    throw new Error('--retry-unavailable requires text without --offline');
  }
  if (values.refresh && (values.offline || !['start', 'fetch'].includes(command))) {
    throw new Error('--refresh requires start or fetch without --offline');
  }
  const config = loadConfig(values.config);
  const categories = categoriesFrom(values.categories);
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be between 1 and 65535');
  const appPath = values['app-db'];
  const papersPath = values['papers-db'];
  if (resolve(appPath) === resolve(papersPath)) throw new Error('Application and paper databases must be separate files');
  mkdirSync(dirname(appPath), { recursive: true });
  // Explicit clear-only branch: no digest lookup, source DB, credentials, or API.
  if (values.clear) {
    const appDb = openAppDatabase(appPath);
    try { clearSummaries(appDb); } finally { appDb.close(); }
    console.log('Cleared all summary outcomes, cache entries, and run budgets. No API calls made.');
    console.log('Regenerating summaries requires a separate summarize command and may incur new charges.');
    return;
  }
  mkdirSync(dirname(papersPath), { recursive: true });
  const papersDb = openPaperDatabase(papersPath);
  const appDb = openAppDatabase(appPath);
  let digest;
  try {
    if ((command === 'start' || command === 'fetch') && !values.offline) {
      digest = await loadDailyDigest(papersDb, appDb, categories, { refresh: values.refresh });
      console.log(`Saved ${digest.date}: ${digest.papers.length} papers (${digest.categories.join(', ')}).`);
    } else {
      digest = loadSavedDigest(papersDb, appDb, categories);
    }
    if (command === 'start' || command === 'score') {
      if (!digest.ranking) {
        console.log('Computing local scores and diversity-aware ranking (cached embeddings are reused)…');
        digest = await scoreDigest(appDb, digest, loadProfiles(values.profiles), () => createBgeProvider({ offline: values.offline }), console.log, config.scoring.weights, config.feedback);
      }
      console.log('Using saved relevance scores, featured selections, and MMR listing order.');
    }
    if (command === 'text') {
      await retrieveFeaturedText(papersDb, digest, { offline: values.offline, retryUnavailable: values['retry-unavailable'] });
    }
    if (command === 'summarize') {
      if (values.tokens) {
        reportSummaryTokens(papersDb, digest, config);
      } else if (values.offline) {
        console.log('Offline: using saved summaries; no requests or new outcomes recorded.');
      } else {
        if (existsSync('.env')) loadEnvFile('.env');
        digest = await summarizeFeatured(appDb, papersDb, digest, config,
          settings => createCloudflareSummaryProvider(settings, { verbose: values.verbose }));
      }
    }
  } finally {
    appDb.close();
    papersDb.close();
  }
  if (['fetch', 'score', 'text', 'summarize'].includes(command)) return;
  const votesDb = openAppDatabase(appPath);
  const server = createDigestServer(digest!, { read: () => readVotes(votesDb), write: (paper, value) => saveVote(votesDb, paper, value) });
  const closeVotes = () => { if (votesDb.isOpen) votesDb.close(); };
  server.once('close', closeVotes);
  server.on('error', error => { closeVotes(); console.error(error.message); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`Browse http://127.0.0.1:${port} (announcement ${digest!.date})`));
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => server.close());
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
