import { existsSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { categoriesFrom } from './arxiv.ts';
import { clearSummaries, openAppDatabase, openPaperDatabase, readVotes, saveVote } from './store.ts';
import { acquireGenerationLock, freezeGenerationInputs, pruneListingData, publishListing, readPublication, readWorkingListing } from './listing-store.ts';
import { generateListing, prepareListing } from './generate.ts';
import { createDigestServer } from './server.ts';
import { createBgeProvider } from './bge.ts';
import { loadProfiles } from './profiles.ts';
import { scoreDigest } from './scoring.ts';
import { loadConfig } from './config.ts';
import { retrieveFeaturedText } from './fulltext.ts';
import { reportSummaryTokens, summarizeFeatured } from './summaries.ts';
import { createCloudflareSummaryProvider } from './cloudflare.ts';

const usage = `ruminator — a local, ephemeral arXiv browser

Usage: npm run <generate|start|fetch|serve|score|text|summarize> -- [options]
  generate               Fetch, rank, and publish one global listing, then exit
  --summarize            Also retrieve text and summarize (generate only; paid)
  --clear                Regenerate listing state (generate); or clear only summaries (summarize)
  start                  Generate without paid summaries, then serve
  fetch                  Fetch into staging without publishing
  serve                  Serve the current publication offline; follows replacements
  score                  Rank the working listing and publish it
  text                   Retrieve featured HTML for the working listing
  summarize              Summarize working text and publish (paid; no request retries)
  -v, --verbose          Print model responses (summarize or generate --summarize)
  --tokens               Estimate summary tokens only (summarize)
  --categories quant-ph  Comma-separated categories for generate/start/fetch
  --app-db data/app.sqlite       Current/working listing and preference memory
  --papers-db data/papers.sqlite Current source cache, not an archive
  --port 3000            Loopback preview port
  --refresh              Bypass daily feed cache (generate/start/fetch)
  --config config.toml   Model, scoring, tokenizer and budget configuration
  --profiles interests.md Research-interest Markdown file
  --offline              Current cached feeds/assets only; no paid summaries
  --retry-unavailable    Explicit retry of failed HTML downloads (text only)
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
      summarize: { type: 'boolean', default: false },
    },
  });
  if (values.help) { console.log(usage); return; }
  const command = positionals[0];
  if (positionals.length !== 1 || !['generate', 'start', 'fetch', 'serve', 'score', 'text', 'summarize'].includes(command)) throw new Error(usage);
  if (values.summarize && command !== 'generate') throw new Error('--summarize requires generate');
  if (values.summarize && values.offline) throw new Error('--summarize cannot be combined with --offline');
  if (values.verbose && command !== 'summarize' && !(command === 'generate' && values.summarize)) throw new Error('--verbose requires summarize or generate --summarize');
  if (values.clear && !['generate', 'summarize'].includes(command)) throw new Error('--clear requires summarize or generate');
  if (values.tokens && command !== 'summarize') throw new Error('--tokens requires summarize');
  if (values.tokens && values.clear) throw new Error('--tokens cannot be combined with --clear');
  if (values['retry-unavailable'] && (command !== 'text' || values.offline)) throw new Error('--retry-unavailable requires text without --offline');
  if (values.refresh && (values.offline || !['generate', 'start', 'fetch'].includes(command))) throw new Error('--refresh requires generate, start or fetch without --offline');
  const config = loadConfig(values.config);
  const categories = categoriesFrom(values.categories);
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be between 1 and 65535');
  const appPath = values['app-db'], papersPath = values['papers-db'];
  const sameFile = existsSync(appPath) && existsSync(papersPath) &&
    (realpathSync(appPath) === realpathSync(papersPath) ||
      (statSync(appPath).dev === statSync(papersPath).dev && statSync(appPath).ino === statSync(papersPath).ino));
  if (resolve(appPath) === resolve(papersPath) || sameFile) throw new Error('Application and paper databases must be separate files');
  mkdirSync(dirname(appPath), { recursive: true });
  const app = openAppDatabase(appPath);
  let release: (() => void) | undefined;
  try {
    const readOnly = command === 'serve' || (command === 'summarize' && !values.clear && (values.tokens || values.offline));
    if (!readOnly) release = acquireGenerationLock(app);
    if (command === 'summarize' && values.clear) {
      clearSummaries(app);
      const working = readWorkingListing(app), publication = readPublication(app);
      if (working?.digest.ranking && working.generationId === publication?.generationId) publishListing(app, working.digest);
      console.log('Cleared all summary outcomes, cache entries, and run budgets. No API calls made.');
      return;
    }
    if (command !== 'serve') {
      mkdirSync(dirname(papersPath), { recursive: true });
      const papers = openPaperDatabase(papersPath);
      try {
        const provider = (settings: Parameters<typeof createCloudflareSummaryProvider>[0]) => {
          if (existsSync('.env')) loadEnvFile('.env');
          return createCloudflareSummaryProvider(settings, { verbose: values.verbose });
        };
        const options = { categories, config, offline: values.offline, clear: values.clear, refresh: values.refresh, log: console.log };
        if (command === 'generate' || command === 'start') {
          await generateListing(app, papers, { ...options, profiles: loadProfiles(values.profiles),
            createEmbeddingProvider: () => createBgeProvider({ offline: values.offline }),
            summarize: values.summarize, createSummaryProvider: provider });
        } else if (command === 'fetch') {
          const result = await prepareListing(app, papers, options);
          console.log(`Working batch ${result.digest.date}: ${result.digest.papers.length} papers.`);
        } else {
          if (command === 'score') pruneListingData(app, papers);
          let digest = readWorkingListing(app)?.digest;
          if (!digest) throw new Error('No working listing; run generate or fetch first');
          if (command === 'score') {
            const inputs = freezeGenerationInputs(app, { config, profiles: loadProfiles(values.profiles) });
            digest = await scoreDigest(app, digest, inputs.profiles, () => createBgeProvider({ offline: values.offline }), console.log,
              inputs.config.scoring.weights, inputs.config.feedback);
            publishListing(app, digest);
            pruneListingData(app, papers);
          } else if (command === 'text') {
            await retrieveFeaturedText(papers, digest, { offline: values.offline, retryUnavailable: values['retry-unavailable'] });
          } else if (values.tokens) {
            reportSummaryTokens(papers, digest, config);
          } else if (values.offline) {
            console.log('Offline: using saved summaries; no requests or new outcomes recorded.');
          } else {
            digest = await summarizeFeatured(app, papers, digest, config, provider);
            publishListing(app, digest);
            pruneListingData(app, papers);
          }
        }
      } finally { papers.close(); }
    }
  } finally { release?.(); app.close(); }
  if (!['serve', 'start'].includes(command)) return;
  const votesDb = openAppDatabase(appPath);
  if (!readPublication(votesDb)) { votesDb.close(); throw new Error('No published listing; run generate first'); }
  const server = createDigestServer(() => readPublication(votesDb), {
    read: () => readVotes(votesDb), write: (paper, value) => saveVote(votesDb, paper, value),
  });
  const closeVotes = () => { if (votesDb.isOpen) votesDb.close(); };
  server.once('close', closeVotes);
  server.on('error', error => { closeVotes(); console.error(error.message); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`Browse http://127.0.0.1:${port} (current listing; refresh after generation)`));
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => server.close());
}

main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
