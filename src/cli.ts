import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { categoriesFrom } from './arxiv.ts';
import { openAppDatabase, openPaperDatabase } from './store.ts';
import { loadDailyDigest, loadSavedDigest } from './load.ts';
import { createDigestServer } from './server.ts';
import { createBgeProvider } from './bge.ts';
import { loadProfiles } from './profiles.ts';
import { scoreDigest } from './scoring.ts';

const usage = `Usage: npm run <start|fetch|serve|score> -- [options]
  start                  Use today's cached download, or download, then serve
  fetch                  Use today's cached download, or download, and save only
  serve                  Serve saved data without network access or inference
  score                  Score the latest saved digest (never contacts arXiv)
  --categories quant-ph  Comma-separated arXiv categories
  --app-db data/app.sqlite       Disposable application state
  --papers-db data/papers.sqlite Downloaded paper information and source metadata
  --port 3000            Local preview port
  --refresh              Bypass daily download cache (start/fetch only)
  --profiles interests.md Research-interest Markdown file
  --offline              Use saved digest and cached model assets only
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
      offline: { type: 'boolean', default: false },
      profiles: { type: 'string', default: 'interests.md' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) { console.log(usage); return; }
  const command = positionals[0];
  if (positionals.length !== 1 || !['start', 'fetch', 'serve', 'score'].includes(command)) throw new Error(usage);
  if (values.refresh && (values.offline || command === 'serve' || command === 'score')) {
    throw new Error('--refresh requires start or fetch without --offline');
  }
  const categories = categoriesFrom(values.categories);
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be between 1 and 65535');
  const appPath = values['app-db'];
  const papersPath = values['papers-db'];
  if (resolve(appPath) === resolve(papersPath)) throw new Error('Application and paper databases must be separate files');
  mkdirSync(dirname(appPath), { recursive: true });
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
        digest = await scoreDigest(appDb, digest, loadProfiles(values.profiles), () => createBgeProvider({ offline: values.offline }));
      }
      console.log('Using saved relevance scores, featured selections, and MMR listing order.');
    }
  } finally {
    appDb.close();
    papersDb.close();
  }
  if (command === 'fetch' || command === 'score') return;
  const server = createDigestServer(digest!);
  server.on('error', error => { console.error(error.message); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`Browse http://127.0.0.1:${port} (announcement ${digest!.date})`));
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => server.close());
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
