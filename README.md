# arxiv-digest

A local, minimal arXiv browser. Downloads the latest `quant-ph` announcement feed, saves it in SQLite, and displays:

- Six randomly selected papers with titles, abstracts, and PDF links.
- Every remaining paper as an expandable title revealing its abstract and PDF link.

The random selection is fixed for each saved announcement batch. Math in titles and abstracts is rendered with KaTeX, including `$…$`, `$$…$$`, `\(…\)`, and `\[…\]`. Styles and fonts are served locally, with no CDN or browser JavaScript. Unsupported/malformed math stays visible as escaped source text. Every scored paper shows a numeric semantic relevance score. The six picks and listing order are still unchanged; combined ranking, LLM summaries, and voting are not implemented yet.

## Run locally

Requires **Node.js 24+** (uses built-in TypeScript support and SQLite).

```sh
npm install
npm start
```

Open **http://127.0.0.1:3000**. Stop with Ctrl-C. Startup reuses each category's downloaded feed for the current US Eastern calendar day, downloading only missing or stale feeds. Restarting the app, browsing, and refreshing the page do not repeatedly contact arXiv. On first scoring, startup downloads the pinned BGE-small model assets into `data/models/`, then computes embeddings locally on CPU. Subsequent runs reuse saved scores without loading the model. SQLite may emit an experimental-feature warning on some Node versions.

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

Storage is split into two databases (both ignored by Git):

- **`data/papers.sqlite`** — downloaded paper information, source metadata, announcement archives, and download freshness. Keep this file when changing application schemas.
- **`data/app.sqlite`** — generated digests, embeddings, and scores; future votes and summaries also belong here.

Override them independently with `--papers-db data/another-papers.sqlite` and `--app-db data/another-app.sqlite`. They must be different files. Category combinations have separate saved digests. Restart the preview server after downloading another batch; a running preview always shows its original snapshot. If downloading fails, the command reports the error rather than silently showing stale data; use `serve` explicitly to view saved data.

## Local semantic scores

`npm start` scores an unscored digest automatically. To score the latest saved digest without downloading arXiv data or starting a server:

```sh
npm run score
npm run serve
```

After the first model download, inference can run fully offline:

```sh
npm run score -- --offline
npm start -- --offline
```

`start --offline` uses the latest saved digest, never checks arXiv, and requires cached model assets if scoring is needed. If the application DB has been recreated, offline commands rebuild an unscored digest from the latest archived announcement shared by all requested categories. `serve` neither loads a model nor computes missing scores. Use `--profiles profiles` to choose a different profile directory.

The baseline is **BGE-small-en-v1.5**, using the pinned `Xenova/bge-small-en-v1.5` ONNX conversion, q8 weights, CLS pooling, and normalized 384-dimensional vectors. Profiles use only their titles and Subjects bullets, with BGE's retrieval-query instruction. Papers use titles and abstracts. Long inputs are split into sentence-oriented chunks within the 512-token limit, repeating the title, then their vectors are averaged and renormalized.

A paper's raw score is its **maximum cosine similarity across the six profiles**. The visible number is `(cosine + 1) / 2`, on a fixed **[0, 1]** scale, rounded to three decimals. It is not a probability, quality assessment, or percentile. BGE similarities can cluster in a narrow, high-valued band; the scale deliberately does not stretch each day's best and worst papers to 1 and 0. Hover over a score to see its closest profile.

Embeddings are cached in SQLite by input content and model/preprocessing fingerprint. Changed positive interests or paper text require new vectors; changes to ignored negative sections do not. The first completed score snapshot for a digest is saved with its profile/model context. Existing unscored digests can acquire scores once, without changing selections or order; later profile/model changes apply only to future digests. Interrupted scoring reuses completed vectors and never publishes partial scores. `unscored` appears when viewing an older digest before scoring it.

## What counts as “today”?

The source is [arXiv's category RSS feed](https://rss.arxiv.org/rss/quant-ph), not a search for papers submitted on the machine's calendar date. The page shows the feed's announcement date in arXiv's US Eastern timezone. It may be the latest available batch rather than today's date, particularly around weekends and holidays. RSS provides the current batch, not historical backfill.

Include new announcements and cross-listings; exclude replacements/revisions. The RSS feed carries abstracts directly, so there is no need to download individual paper pages or PDFs. PDF links point to the announced version.

Saved digests are immutable: repeating a download for the same announcement date and category set does not replace the published page, even if the upstream feed changes. Corrected-batch regeneration is deliberately not implemented yet.

## Development

There are **no schema migrations or old-schema compatibility paths**. `schema/papers.sql` and `schema/app.sql` define the current schemas; opening a database initializes any missing tables, but does not upgrade existing tables.

When changing the application schema, stop the server and recreate only its database:

```sh
rm data/app.sqlite
npm start -- --offline
```

This resets generated digests, embeddings, and scores. They are rebuilt locally using the preserved `data/papers.sqlite` and `data/models/`, without arXiv requests or model downloads. Keep the paper database; do not remove the entire `data/` directory. If needed, `npm run serve` reconstructs a basic view without loading the model. Deleting application state is an explicit development reset, not a change to an existing published digest.


```sh
npm test
npm run typecheck
```

Default tests use a recorded RSS excerpt, real SQLite, a loopback HTTP server, and small deterministic vectors for scoring correctness. They do not download models or call arXiv or paid model APIs.

An explicit real-model integration test checks basic relevance, long-input inference, and offline model reload:

```sh
npm run test:model # Downloads model assets on first run; no arXiv calls
MODEL_OFFLINE=1 npm run test:model # Requires already-cached model assets
```

The app uses Node's built-in HTTP server and native HTML `<details>` elements; no browser JavaScript or frontend build is needed.

- `src/arxiv.ts`: RSS fetching/parsing and category configuration.
- `src/digest.ts`: deduplication and seeded random selection.
- `src/load.ts`: per-category daily download caching and explicit refresh.
- `src/profiles.ts`: positive-subject profile loading.
- `src/embeddings.ts`, `src/bge.ts`: embedding interface, token-bounded chunking, and local BGE backend.
- `src/scoring.ts`: vector caching, cosine scores, and fixed score snapshots.
- `src/store.ts`, `schema/`: separate paper/application databases and current SQL schemas.
- `src/math.ts`, `src/render.ts`, `src/server.ts`: safe math/HTML rendering, local KaTeX assets, and preview.
- `src/cli.ts`: download/preview commands.

See [research-interest profiles](profiles/README.md) and [PLAN.md](PLAN.md) for the intended relevance-based pipeline and later Hugo/Cloudflare integration. Those integrations are not part of this local slice.
