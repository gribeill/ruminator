# arxiv-digest

A local, minimal arXiv browser. Downloads the latest `quant-ph` announcement feed, saves it in SQLite, and displays:

- Six randomly selected papers with titles, abstracts, and PDF links.
- Every remaining paper as an expandable title revealing its abstract and PDF link.

The random selection is fixed for each saved announcement batch. Math in titles and abstracts is rendered with KaTeX, including `$…$`, `$$…$$`, `\(…\)`, and `\[…\]`. Styles and fonts are served locally, with no CDN or browser JavaScript. Unsupported/malformed math stays visible as escaped source text. There is no ranking, LLM usage, or voting yet.

## Run locally

Requires **Node.js 24+** (uses built-in TypeScript support and SQLite).

```sh
npm install
npm start
```

Open **http://127.0.0.1:3000**. Stop with Ctrl-C. Startup reuses each category's downloaded feed for the current US Eastern calendar day, downloading only missing or stale feeds. Restarting the app, browsing, and refreshing the page do not repeatedly contact arXiv. SQLite may emit an experimental-feature warning on some Node versions.

Add other arXiv listings with comma-separated category IDs:

```sh
npm start -- --categories quant-ph,cs.ET --port 3001
```

Cross-listed papers appear only once. Downloads are cached per category, so adding a category doesn't download today's already-cached categories again. All requested categories must have the same announcement date; if feeds are updating at different times, retry later with `--refresh`.

Download once (or reuse today's download) without starting a server, or browse saved data without internet access:

```sh
npm run fetch -- --categories quant-ph
npm run serve -- --categories quant-ph
```

To explicitly check arXiv again within the same day:

```sh
npm run fetch -- --refresh
# Or download again and start the preview:
npm start -- --refresh
```

The daily cache tracks **download time**, not announcement date: weekends can return the same announcement batch on successive days. A download early in the day can miss a later feed update; use `--refresh` if needed. Refreshing bypasses the download cache but never rewrites an already-published digest. Successful downloads remain cached even if a different category fails; failed requests do not mark that category as checked.

The default database is `data/digest.sqlite` (ignored by Git). Override it with `--db data/another.sqlite`. Category combinations have separate saved digests. Restart the preview server after downloading another batch; a running preview always shows its original snapshot. If downloading fails, the command reports the error rather than silently showing stale data; use `serve` explicitly to view saved data.

## What counts as “today”?

The source is [arXiv's category RSS feed](https://rss.arxiv.org/rss/quant-ph), not a search for papers submitted on the machine's calendar date. The page shows the feed's announcement date in arXiv's US Eastern timezone. It may be the latest available batch rather than today's date, particularly around weekends and holidays. RSS provides the current batch, not historical backfill.

Include new announcements and cross-listings; exclude replacements/revisions. The RSS feed carries abstracts directly, so there is no need to download individual paper pages or PDFs. PDF links point to the announced version.

Saved digests are immutable: repeating a download for the same announcement date and category set does not replace the published page, even if the upstream feed changes. Corrected-batch regeneration is deliberately not implemented yet.

## Development

```sh
npm test
npm run typecheck
```

Tests use a recorded RSS excerpt, real SQLite, and a loopback HTTP server. They do not call arXiv or paid model APIs. The app uses Node's built-in HTTP server and native HTML `<details>` elements; no browser JavaScript or frontend build is needed.

- `src/arxiv.ts`: RSS fetching/parsing and category configuration.
- `src/digest.ts`: deduplication and seeded random selection.
- `src/load.ts`: per-category daily download caching and explicit refresh.
- `src/store.ts`, `migrations/`: local SQLite snapshots and schema.
- `src/math.ts`, `src/render.ts`, `src/server.ts`: safe math/HTML rendering, local KaTeX assets, and preview.
- `src/cli.ts`: download/preview commands.

See [research-interest profiles](profiles/README.md) and [PLAN.md](PLAN.md) for the intended relevance-based pipeline and later Hugo/Cloudflare integration. Those integrations are not part of this local slice.
