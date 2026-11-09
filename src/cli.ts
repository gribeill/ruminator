import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { categoriesFrom } from './arxiv.ts';
import { latestDigest, openDatabase } from './store.ts';
import { loadDailyDigest } from './load.ts';
import { createDigestServer } from './server.ts';

const usage = `Usage: npm run <start|fetch|serve> -- [options]
  start                  Use today's cached download, or download, then serve
  fetch                  Use today's cached download, or download, and save only
  serve                  Serve saved data without network access
  --categories quant-ph  Comma-separated arXiv categories
  --db data/digest.sqlite SQLite file
  --port 3000            Local preview port
  --refresh              Bypass daily download cache (start/fetch only)
`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      categories: { type: 'string', default: 'quant-ph' },
      db: { type: 'string', default: 'data/digest.sqlite' },
      port: { type: 'string', default: '3000' },
      refresh: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) { console.log(usage); return; }
  const command = positionals[0];
  if (positionals.length !== 1 || !['start', 'fetch', 'serve'].includes(command)) throw new Error(usage);
  if (command === 'serve' && values.refresh) throw new Error('serve is offline; use start or fetch with --refresh');
  const categories = categoriesFrom(values.categories);
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be between 1 and 65535');
  mkdirSync(dirname(values.db), { recursive: true });
  const db = openDatabase(values.db);
  let digest;
  try {
    if (command !== 'serve') {
      digest = await loadDailyDigest(db, categories, { refresh: values.refresh });
      console.log(`Saved ${digest.date}: ${digest.papers.length} papers (${digest.categories.join(', ')}).`);
    } else {
      digest = latestDigest(db, categories);
      if (!digest) throw new Error('No saved digest for these categories. Run npm start first.');
    }
  } finally {
    db.close();
  }
  if (command === 'fetch') return;
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
