# ruminator

A local, minimal arXiv browser, with a small ASCII cow to keep you company while you ruminate. Downloads the latest `quant-ph` announcement feed, saves it in SQLite, and displays:

- Six featured papers: four relevance picks, one adjacent topic, and one weighted-random wildcard, with titles, abstracts, and PDF links.
- Every remaining paper in a diversity-aware order, as an expandable title revealing its abstract and PDF link.
- Compact authors (up to four; first two … last two for longer lists), with all names in a tooltip.

Selections and display order are fixed once ranking is saved for an announcement batch. Math in titles and abstracts is rendered with KaTeX, including `$…$`, `$$…$$`, `\(…\)`, and `\[…\]`. Styles and fonts are served locally, with no CDN or browser JavaScript. Unsupported/malformed math stays visible as escaped source text. Every ranked paper shows a combined relevance score with a component breakdown in its tooltip. LLM summaries and voting are not implemented yet.

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

## Configuration

Edit **[config.toml](config.toml)** for model documentation, score weights, and local summary-token counting settings. All commands accept `--config path/to/config.toml`; the default is the file in the current working directory. Invalid, missing, or unknown settings fail explicitly.

- **LLM:** `cloudflare` with configurable model ID, initially `openai/gpt-6-luna`. Changing provider away from Cloudflare is not yet supported. These settings are reserved for the summary service: no LLM calls are wired yet. Full-text retrieval is a separate explicit command below.
- **Embeddings:** documents the existing pinned BGE model/revision, q8 precision, and CLS pooling. Changing embedding configuration is not yet supported and is rejected, rather than silently using incompatible preprocessing or caches.
- **Score weights:** nonnegative semantic/keyword/feedback weights must sum to 1. They apply to new rankings and are saved with them; existing ranked digests and embedding caches are unchanged. Other selection/MMR constants remain in `src/ranking.ts`.
- **Tokenizer:** `gpt-tokenizer` runs `o200k_base` entirely locally, with no model weights, downloads, or inference calls. This is an **approximation**, not a verified tokenizer match or upper bound for `gpt-6-luna`. Configurable text-count headroom and per-message/request allowances account conservatively for unknown framing. Other implementations/encodings are not yet supported.

The `estimatePromptTokens(messages, config.tokenizer)` function in `src/tokenizer.ts` counts the complete supplied message text, including instructions, without truncation. It returns raw text tokens and an estimated input total (`ceil(text tokens × safety multiplier) + message allowances + request allowance`), explicitly marked approximate. It treats control-token-looking paper text as ordinary data. Output/reasoning reservations and per-run budget enforcement belong to the forthcoming summary request loop and are not implemented yet.

Keep Cloudflare credentials in the ignored `.env`, not `config.toml`. The current CLI does not load `.env` or call the summary provider; a future summary command will explicitly load those settings.

## Editing research interests

Edit **[interests.md](interests.md)**, the sole profile configuration file. It contains six independent profiles; combining the files does not combine their scores or interests.

```markdown
## Superconducting Quantum Computing {#superconducting-quantum-computing}

### Subjects
- Superconducting qubit architectures

### Keywords
- tunable coupler; tunable coupling

### Positive examples
### Deprioritize
### Negative examples
```

Keep each `{#id}` unique and stable when renaming or rearranging sections. Profile IDs are lowercase letters/digits separated by hyphens. Document order is for editing convenience, not ranking priority.

- **Subjects:** required semantic interest bullets; only these and the display title feed embeddings.
- **Keywords:** optional explicit lexical signals, one phrase/alias group per bullet. Missing/empty lists are neutral; see scoring details below.
- **Positive examples:** space for paper IDs/URLs and why they are relevant.
- **Deprioritize / Negative examples:** space for topics or recommendations that are less relevant, with reasons—not judgments of paper quality or scientific null results. These and positive examples are reserved for future use and currently do not affect ranking.

HTML comments and empty placeholders are ignored. Scientifically interesting negative/null results remain welcome; these profiles are not exclusion filters. Existing ranked digests remain fixed after edits. Use `--profiles my-interests.md` to select a different single Markdown file; directory-based profiles are no longer supported.

## Local scoring and ranking

`npm start` scores and ranks an unranked digest automatically. To score the latest saved digest without downloading arXiv data or starting a server:

```sh
npm run score
npm run serve
```

After the first model download, inference can run fully offline:

```sh
npm run score -- --offline
npm start -- --offline
```

`start --offline` uses the latest saved digest, never checks arXiv, and requires cached model assets if scoring is needed. If the application DB has been recreated, offline commands rebuild an unscored digest from the latest archived announcement shared by all requested categories. `serve` neither loads a model nor computes missing scores. Use `--profiles my-interests.md` to choose a different profile file.

The baseline is **BGE-small-en-v1.5**, using the pinned `Xenova/bge-small-en-v1.5` ONNX conversion, q8 weights, CLS pooling, and normalized 384-dimensional vectors. Profiles use only their titles and Subjects bullets, with BGE's retrieval-query instruction. Papers use titles and abstracts. Long inputs are split into sentence-oriented chunks within the 512-token limit, repeating the title, then their vectors are averaged and renormalized.

The visible score, rounded to three decimals, is:

```text
# Default weights from config.toml:
relevance = 0.60 * semantic + 0.25 * keywords + 0.15 * feedback
```

- **Semantic:** maximum cosine similarity across profiles, mapped by `(cosine + 1) / 2` to a fixed [0, 1] scale. No daily min-max stretching.
- **Keywords:** only the explicit `### Keywords` bullets in each profile. Each bullet is one phrase or group of semicolon-separated aliases, e.g. `tunable coupler; tunable coupling`. Match whole normalized phrases (case, punctuation/hyphens, simple plurals), never partial coverage or inferred Subjects words. Title hits count twice as much as abstract hits; aliases and repetitions contribute at most once per group. Evidence saturates as `1 - exp(-evidence / 2)`. A missing/empty keyword list scores a neutral **0.5** for that profile; a configured list with no hits scores **0**. Take the strongest profile score, including neutral values (an unspecified profile therefore gives a 0.5 floor).
- **Feedback:** a neutral **0.5** until voting is implemented.

Hover over a score to inspect its components and closest semantic profile. These numbers are not probabilities, quality assessments, or percentiles; BGE similarities naturally occupy a narrow high-valued band.

### Selection and order

- **For you:** greedily choose four high relevance scores with a small redundancy penalty.
- **Adjacent topic:** favor semantic relevance with low keyword overlap, less similarity to the featured set, and a bonus for an unrepresented profile.
- **Wildcard:** draw from an equal mixture of uniform sampling and softmax sampling over semantic scores (initial temperature 0.05). No keyword weighting or relevance cutoff. Exclude already selected papers and avoid near-duplicates.
- **Other postings:** greedy Maximal Marginal Relevance, `0.7 * relevance - 0.3 * maximum_similarity + jitter`, comparing initially against all six featured papers and then against each newly ordered paper. Jitter is fixed per paper/date and bounded by ±0.005. This order intentionally does **not** decrease monotonically by relevance score.

Random draws are date/category-seeded; candidate IDs break ties deterministically. Featured slots avoid identical titles and cosine similarities ≥0.95 whenever alternatives exist. Very small or redundant batches relax this preference to fill up to six distinct IDs. Every remaining paper stays available. Defaults are collected in `src/ranking.ts` and saved with each ranking; they are initial settings, not calibrated estimates of scientific importance.

Embeddings are cached in SQLite by input content and model/preprocessing fingerprint. Changed Subjects/title or paper text require new vectors; keyword-only edits and ignored negative sections do not. Explicit keyword lists are snapshotted separately with each ranking. Semantic snapshots retain their profile/model context. The first completed ranking saves score components, featured roles, and the entire remaining order; later profile/model/configuration changes apply only to future digests. Interrupted scoring reuses completed vectors and never publishes a partial ranking. A fetch-only or not-yet-ranked digest has a temporary random preview; run `score` to replace it with its first fixed ranked view. To experiment with new keyword lists for the same saved batch, use a fresh `--app-db` path with `--offline`, preserving the existing digest and paper cache.

## Featured-paper text cache

After saving a ranking, download HTML text for **only its six featured papers** (or fewer for a small batch):

```sh
npm run text
npm run text -- --offline          # Inspect cached results without network access
npm run text -- --retry-unavailable # Explicitly retry failures, not successful downloads
```

This command uses the latest saved digest for `--categories`, honors the usual database paths, and requires a saved ranking. It does not fetch RSS, load an embedding model, rescore, or change selections/order. `start`, `fetch`, `score`, and `serve` do not automatically retrieve full text; page requests remain offline.

Text comes only from versioned `https://arxiv.org/html/{id}v{version}` pages. **TeX source and PDF extraction are deferred** until HTML coverage proves insufficient. Missing/unusable HTML leaves an explicit unsummarized status in the cache and command output; the abstract stays readable, but is never substituted as full text. LLM summarization itself is not implemented yet, and this retrieval state is not yet displayed on the reading page.

The paper database caches raw HTML, extracted text, SHA-256 text hashes, source URL, extraction version, and retrieval timestamps by arXiv ID/version. These survive application DB resets. Both successes and failures are reused on reruns, including across announcement dates; failures do not automatically expire. Use `--retry-unavailable` if a page becomes available later. Offline cache misses are reported without being persisted as failures. Cached HTML can be re-extracted locally after an extractor-version change, without another request.

Extraction retains article headings, paragraphs, captions, tables, appendices, and equation TeX where supplied. It excludes site navigation and scripts, never executes JavaScript or downloads page assets, and rejects abstract-only pages. It does not recover information contained only in figure images. Requests are sequential with at least three seconds between starts, have a 30-second timeout, and reject downloads larger than 16 MiB rather than truncating them.

## What counts as “today”?

The source is [arXiv's category RSS feed](https://rss.arxiv.org/rss/quant-ph), not a search for papers submitted on the machine's calendar date. The page shows the feed's announcement date in arXiv's US Eastern timezone. It may be the latest available batch rather than today's date, particularly around weekends and holidays. RSS provides the current batch, not historical backfill.

Include new announcements and cross-listings; exclude replacements/revisions. The RSS feed carries abstracts directly, so browsing and ranking need no individual paper pages or PDFs. Only the explicit `text` command downloads featured-paper HTML. PDF links point to the announced version. Author names come from the feed's `dc:creator` field; abbreviation of unstructured names uses a heuristic that preserves common surname particles and explicit collaboration names. Full names remain in tooltips. An author metadata side table can enrich matching archived IDs/versions on a feed refresh without rewriting the original announcement snapshots; published application snapshots remain unchanged. Papers without author metadata show “Authors unavailable.”

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
- `src/profiles.ts`: separate semantic Subjects and explicit Keywords profile loading.
- `src/embeddings.ts`, `src/bge.ts`: embedding interface, token-bounded chunking, and local BGE backend.
- `src/scoring.ts`: vector caching, cosine scores, and fixed ranking orchestration.
- `src/ranking.ts`: combined scores, featured selection, wildcard sampling, and MMR ordering.
- `src/authors.ts`: compact author formatting and display-name normalization.
- `src/store.ts`, `schema/`: separate paper/application databases and current SQL schemas.
- `src/math.ts`, `src/render.ts`, `src/server.ts`: safe math/HTML rendering, local KaTeX assets, and preview.
- `src/config.ts`, `config.toml`: validated, commented model/scoring/tokenizer configuration.
- `src/tokenizer.ts`: local full-prompt token estimates for the forthcoming summary service.
- `src/fulltext.ts`: cached, HTML-only featured-paper text retrieval and extraction.
- `src/cli.ts`: download/preview commands.

See [research interests](interests.md) and [development plan](.agents/PLAN.md) for the intended relevance-based pipeline and later Hugo/Cloudflare integration. Those integrations are not part of this local slice.
