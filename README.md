# ruminator

A local, minimal arXiv browser for discovering papers in the **latest announcement batch**, not building a personal copy of arXiv. A small ASCII cow keeps you company while you ruminate.

The reading page contains:

- Six featured papers: four **Selected**, one **Adjacent**, and one **Wildcard**.
- Every remaining posting in a diversity-aware order, with expandable abstracts and links.
- Compact authors, two-decimal relevance scores, and optional + / − relevance votes.
- Featured **Abstract** and **AI summary** disclosures, both closed by default, in that order. The summary has a light-grey background without a left border; its marker aligns with Abstract. Links and votes remain outside both disclosures.

The current ranking stays fixed while you read. There is **one global listing**, no history browser, and no unread backlog. When another listing is successfully published, the old one is discarded. Papers themselves remain available on arXiv; save worthwhile papers or notes in your own bibliography/notebook.

## Manual workflow

Requires **Node.js 24+**, for built-in TypeScript and SQLite support.

```sh
npm install
npm run generate          # Fetch and rank locally, publish, then exit
npm run serve             # Browse http://127.0.0.1:3000
```

Or `npm start` to generate without paid summaries and then serve. Stop the server with Ctrl-C. It follows newly published listings on page refresh, without a restart, network retrieval, or inference on page requests.

On first scoring, the pinned BGE-small assets download into `data/models/`. Later runs reuse model assets and compatible cached embeddings. The source is the RSS announcement batch, not papers submitted on the machine's calendar date. Weekends and holidays can leave the latest batch unchanged; its actual announcement date stays visible.

For optional full-text AI summaries:

```sh
npm run generate -- --summarize  # Explicitly permits paid calls for a new/unfinished listing
```

This retrieves featured HTML, makes separate sequential summary requests, and then publishes. Without `--summarize`, generation does not retrieve full text or call a summary provider. There is no scheduler, cron job, hosted API, or deployment infrastructure in this version.

### Repeated generation and explicit replacement

Generating an already-published announcement date/category set is a **no-op**, even with `--summarize`: it does not rerank, fetch featured text, or make paid calls. Changed interests/configuration affect the next listing, not the current one.

To deliberately regenerate the same batch:

```sh
npm run generate -- --clear              # Rebuild ranking; no paid calls
npm run generate -- --clear --summarize  # Rebuild and regenerate summaries; potentially billable
```

`--clear` resets working membership, ranking, feedback/configuration snapshots, full-text caches, summaries, outcomes, and budgets. It preserves active votes, useful embeddings, and downloaded model assets. It uses the current feed cache unless `--refresh` is also specified. It **does not remove the visible publication before its replacement succeeds**. If interrupted, resume with ordinary `generate` (and `--summarize` if desired); repeating `--clear` deliberately discards the partial work again.

The current page remains available after feed, model, or local-credential failures. Missing HTML, refused/failed API responses, and budget skips produce explicit unavailable summaries rather than blocking an otherwise readable listing. First publication requires a complete ranking; there is no public unranked staging preview.

### Categories, caching, and offline operation

```sh
npm run generate -- --categories quant-ph,cs.ET
npm run generate -- --refresh
npm run generate -- --offline
npm run generate -- --offline --clear
npm run serve -- --port 3001
```

Category feeds are cached once per US Eastern calendar day. `--refresh` checks them again; it is not permission to replace an existing ranking. All requested categories must report the same announcement date. Mismatched dates or failed downloads leave the publication unchanged; successful category downloads remain cached for another attempt. Generation refuses a batch older than the current publication. A category feed that regresses behind its cached date is rejected before changing source data or freshness, preserving offline regeneration.

There is one listing across **all** category combinations: generating a different combination replaces it. `serve` always displays the global current publication. The lower-level commands below act on the single working listing, not a historical category-specific digest.

`--offline` uses current cached feeds and model assets only. It cannot be combined with `generate --summarize`. There is no fallback to an older common-date archive if current feeds disagree. `serve` is always offline and requires a published listing.

### Individual development commands

```sh
npm run fetch                         # Fetch into staging, without publishing
npm run score -- --offline            # Rank staging and publish without summaries
npm run text                          # Retrieve HTML for working featured selections
npm run text -- --offline             # Inspect/re-extract cached HTML, no downloads
npm run text -- --retry-unavailable   # Explicitly retry failed HTML retrieval
npm run summarize -- --tokens         # Full-prompt input estimates and output allowances only
npm run summarize                     # Explicit paid summaries, then publish
npm run summarize -- -v               # Full responses for actual requests; credentials redacted
```

If a different batch is already staged, `fetch` of the published batch fails explicitly rather than claiming to switch staging. Use `serve` to read the publication, continue the named working batch, or use `generate --clear --categories ...` to rebuild the requested batch deliberately. A successful `fetch` reports the actual working date and categories.

`text` does not publish or change ranking. `score` publishes the working ranking; `summarize` publishes after recording its outcomes. These commands also let you add summaries explicitly after an unsummarized publication; `generate --summarize` alone remains a no-op for that published batch.

`summarize --tokens` includes all featured papers, even those with cached summaries. It flags missing HTML/partial totals and never loads credentials, calls APIs, or changes budgets/outcomes. `summarize --offline` also leaves summary state untouched.

The narrower `summarize --clear` command still clears only summary state and exits without API calls or source-database access. If the working listing is published, its summary display is cleared too. Regeneration requires a separate command and may incur charges. Use `generate --clear` for a full listing reset instead.

Only one writing generation/development command may run at a time for an app database. A local process lock prevents overlapping clears and paid calls; an interrupted process's lock can be reclaimed when its process is no longer alive. The reading server can stay running. SQLite connections wait up to one second for brief lock contention. Saving a completed summary gets up to five persistence attempts with short pauses; this never repeats the provider call or its budget reservation. Persistent storage errors still stop the command conservatively. Old browser vote forms are rejected after publication replacement: reload the current page before voting.

## Ephemeral storage and retention

- **`data/app.sqlite`**: one self-contained publication, one working generation (which may be the published generation), useful embeddings, current vote memory, and current generation/summary provenance.
- **`data/papers.sqlite`**: current per-category feed caches, working/current paper metadata, and current/working full-text caches. This is a working cache, not an archive.
- **`data/models/`**: pinned model assets, independent of listing lifecycle.

Override the database paths with `--app-db` and `--papers-db`; they must be different files, including symlink/hard-link aliases. Existing parent directories are resolved before either database is created. Use one app/source pair for normal operation. Separate experiments sharing a source DB should not run concurrently.

Publication is an atomic application-database replacement. Source cleanup follows it and is safe to repeat after interruption. Each generation attempt prunes obsolete batches, rankings, text, summaries, budgets, and unused embeddings, including when downloads fail or dates disagree. Useful partial downloads and their latest source metadata remain cached for retry; older author metadata does not accumulate. Expired vote metadata/vectors are removed even during network outages. Embeddings are retained only for current/working paper and profile inputs, active voted examples, and frozen feedback needed by unfinished ranking. This can reuse vectors without retaining old reading artifacts. Successful summaries are reusable within the retained working state, not a permanent cross-day archive.

### Votes expire after 365 days

Votes mean **more/less relevant to your interests**, not scientific quality. The selected + / − button can be clicked again to clear a vote, or the other button to change it. Votes share a base arXiv ID across versions.

Manual generation compacts vote changes to the latest active vote per paper and discards votes **older than 365 days since their last explicit change**, with their no-longer-needed metadata and vectors. The exact 365-day boundary is retained. Changing a vote renews its lifetime; reading a paper, propagating feedback, or resubmitting the same desired state does not. Cleared and superseded vote events are removed during pruning. Timestamped metadata is also removed from frozen feedback provenance when expired, without changing published scores/order.

There is no background expiry job. With no manual generation, existing disk state remains in place. Current/working paper metadata is retained because it is needed for those listings, independently of vote expiry.

Active voted examples retain title and abstract so they can be embedded again in a future compatible model space. New votes affect subsequent generation, never an existing ranking. Profiles, configuration (including weights), and active votes are frozen together in one SQLite transaction before inference; interrupted runs resume that complete snapshot, never a mixture of inputs from different invocations. Expired feedback is removed even from a very old interrupted run.

## Configuration and research interests

Edit **[config.toml](config.toml)**, or pass `--config path/to/config.toml`. Missing, invalid, and unknown settings fail explicitly.

- **LLM:** Cloudflare, with a configurable model ID. Only `summarize` and `generate --summarize` authorize paid calls. Provider changes away from Cloudflare are not supported yet.
- **Embeddings:** pinned BGE-small model/revision, q8 CPU inference, CLS pooling, normalized 384-dimensional vectors. Unsupported embedding configuration changes are rejected.
- **Score weights:** nonnegative semantic/keyword/feedback weights summing to 1; apply to new rankings.
- **Feedback:** configurable raw cosine thresholds, initially 0.90 for propagation and 0.95 for near-duplicate suppression.
- **Tokenizer and summaries:** local `gpt-tokenizer`/`o200k_base`, configurable framing/headroom, input/context limits, and completion allowance. Estimates are approximate, not guaranteed dollar caps.

Keep credentials in the ignored `.env`, never in TOML or saved/public artifacts:

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_GATEWAY_ID`

Only explicit online summary generation loads `.env`; existing environment variables take precedence. Missing credentials are a recoverable precondition, not a model attempt. No cross-provider fallback is implemented.

Edit **[interests.md](interests.md)**, the sole research-interest file, or use `--profiles path/to/interests.md`:

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

Keep each explicit ID unique and stable when renaming/reordering headings. Titles and Subjects supply semantic inputs. Keywords are optional phrase groups with semicolon-separated aliases. Positive/negative example headings are currently placeholders and do not affect ranking; HTML comments are ignored. Profile file order does not change ranking priority.

## Ranking and reading

The initial relevance score is:

```text
0.60 × semantic + 0.25 × keywords + 0.15 × feedback
```

- **Semantic:** maximum cosine similarity across interest profiles, mapped to [0, 1] by `(cosine + 1) / 2`, without daily rescaling. Profiles use BGE's query instruction. Papers use title/abstract, split into token-bounded sentence chunks with the title repeated; normalized chunk vectors are averaged and renormalized.
- **Keywords:** whole normalized explicit phrases, not inferred Subjects words or partial matches. Aliases/repetitions count once per group; title hits count twice abstract hits. Evidence saturates as `1 - exp(-evidence / 2)`. Empty lists are neutral 0.5; configured lists without hits score 0. Take the strongest profile, including neutral values.
- **Feedback:** nearby votes, newest first, with duplicate examples suppressed. For similarity `c` above cutoff `t`, weight `w = (c - t) / (1 - t)`. The component is `0.5 + 0.5 × sum(w × vote) / (1 + sum(w))`. No nearby evidence stays neutral 0.5; one perfectly matching up/down vote gives 0.75/0.25.

These are experimental relevance measures, **not probabilities or scientific-quality assessments**. Display rounding to two decimal places does not change stored scores or order. A semantic-only development view can display semantic similarity; unscored papers have no number.

- **Selected:** four high-relevance papers with a small redundancy penalty.
- **Adjacent:** semantic connections with lower keyword overlap and less represented topics.
- **Wildcard:** a seeded equal mixture of uniform and semantic-softmax sampling, not constrained by keyword relevance.
- **Other postings:** greedy MMR ordering against the featured set and then previously ordered papers, with small seeded jitter. This deliberately does not sort monotonically by relevance.

Featured selections avoid identical titles and cosine similarity ≥0.95 when alternatives exist; tiny/redundant batches relax this to fill up to six distinct IDs. Every remaining paper stays available. Constants live in `src/ranking.ts`.

Math is rendered server-side with KaTeX, local styles/fonts, escaped paper text, disabled trust features, and escaped-source fallback. A running server pre-renders paper HTML and math once per publication; subsequent GETs assemble only live vote controls around those static fragments. HEAD requests skip page assembly and vote reads. New or updated publications rebuild the rendered snapshot. No browser JavaScript or CDN is needed. The standalone 800px reading column loosely follows Hugo's XMin theme, without importing site navigation or remote assets.

## Full text and summaries

Text comes only from versioned `https://arxiv.org/html/{id}v{version}` pages, never abstract-only substitutions. TeX/PDF extraction is deferred. Retrieval is sequential, at least three seconds between starts, with 30-second timeouts and a 16 MiB download limit. Both successes and failures are cached while relevant; failed HTML requires explicit retry. Cached HTML can be re-extracted offline when the extractor changes.

Extraction keeps scientific prose, equation TeX, captions/tables, and appendices, without executing scripts or fetching assets. It accepts unsectioned articles but requires substantive body content beyond title/author/abstract/bibliography metadata. Information present only in figure images is not recovered.

The summary prompt requests a short factual description grounded in the complete cached text. It explicitly treats paper titles/full text as untrusted data and instructs the model to ignore embedded instructions or role claims. This is a safeguard, not a guarantee against prompt injection or inaccurate summaries; read the paper for scientific conclusions. Cache identity and provenance include a SHA-256 hash of the exact message roles/content sent to the provider, including system instructions and user-message framing. Prompt edits therefore invalidate reusable results without relying on a manually updated version label; existing published outcomes stay unchanged. The page distinguishes missing HTML, API failure, exhausted token budget, and summarization errors.

Default limits are 250,000 estimated input tokens per run, 100,000 per paper, 2,048 completion tokens, and a 102,048-token application context allowance. Full prompts are counted locally without truncation. Output allowance is reserved separately. These estimates are not a verified tokenizer match for every configured model or hard spending limits.

Each uncached paper gets a separate sequential request. Before a request, SQLite durably claims it and reserves estimated input. **Attempted requests are never automatically retried**, including after interruption; errors do not refund reservations. Missing HTML can become eligible after manual retrieval, since it was not an attempt. Successful current cache entries cost no new budget. Exceeding the remaining run budget latches subsequent uncached papers as skipped. Previously recorded attempts/skips remain fixed until an explicit clear. Current summary configuration applies to still-eligible papers without resetting spent input.

RSS responses are capped at **8 MiB** and Cloudflare summary responses at **1 MiB**, before XML/JSON parsing. Streaming reads enforce these limits on decoded bytes even for chunked/compressed responses without a trustworthy `Content-Length`; oversized bodies are cancelled and rejected, not truncated or printed in verbose logs. HTML retrieval retains its separate 16 MiB cap.

Verbose mode prints full responses only for actual calls, defensively redacting credentials; raw responses are not stored. Logs may still contain paper text. Page requests never retrieve text or invoke a provider.

## Development

There are **no migrations or legacy-schema compatibility paths**. `schema/app.sql` and `schema/papers.sql` define current development schemas. Stop processes before resetting databases. Resetting `app.sqlite` loses the current publication, votes, and generated state; `generate --clear` is the normal listing reset that preserves votes and the old page until replacement. Keep model assets. An application reset can generate again from current feed caches with `generate --offline`, but serving never reconstructs historical listings.

```sh
npm test
npm run typecheck
```

Tests use recorded feeds/HTML, real SQLite, loopback HTTP, and deterministic test vectors/providers. They do not call arXiv, download models, or make paid API requests. Lifecycle tests cover atomic publication, resumable failures, repeated generation, explicit clearing, vote expiry/pruning, stale forms, and live server replacement.

Optional real-model integration checks:

```sh
npm run test:model                  # May download assets; no paid summaries
MODEL_OFFLINE=1 npm run test:model  # Uses already-cached assets
```

The main modules are `arxiv.ts`/`load.ts` (ingestion), `generate.ts` (manual orchestration), `listing-store.ts` (publication/retention/lock), `store.ts` (paper/vector/score/summary persistence), `scoring.ts`/`ranking.ts`/`feedback.ts` (relevance), `fulltext.ts`/`summaries.ts`/`cloudflare.ts` (optional summaries), and `render.ts`/`server.ts` (reading).

See [the development plan](.agents/PLAN.md). Historical implementation notes describe superseded archive-oriented behavior; the ephemeral listing contract takes precedence. Cron-like scheduling, authentication, Hugo, and Cloudflare deployment remain future work.
