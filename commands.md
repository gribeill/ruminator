# Command reference

Start with the [getting-started guide](README.md#getting-started). Run these commands from the repository root with Node.js 24+ installed. Pass options after `--`:

```sh
npm run generate -- --help
```

## Everyday use

| Command | Purpose |
| --- | --- |
| `npm start` | Fetch, rank, publish, then serve; no paid summaries. |
| `npm run generate` | Fetch, rank, and publish, then exit. |
| `npm run serve` | Read the current publication offline. No fetching or inference. |

Open **http://127.0.0.1:3000** after starting the service. Use `npm run serve -- --port 3001` for another port. The service binds only to your computer's loopback interface. Stop it with Ctrl-C.

The service can stay running during generation; refresh the page to see a replacement. Reload before voting if an old form is rejected after replacement.

### Categories and feed caching

```sh
npm run generate -- --categories quant-ph,cs.ET
npm run generate -- --refresh
```

The default category is `quant-ph`. Categories are comma-separated and must report the same announcement date. There is one global listing: generating another category combination replaces it, rather than creating a separate view.

Feeds are cached once per US Eastern calendar day. `--refresh` checks arXiv again that day, but does not authorize reranking an already-published batch. Failed downloads, mixed dates, or regressed feeds do not replace the readable listing; useful partial downloads remain cached for retry.

### Cached reruns and interruption

Generating the published date/category set is a **no-op**, even with `--summarize`. Changed interests or ranking settings do not alter that publication.

If generation fails or is interrupted, repeat the command to resume. Include `--summarize` again if you want paid summary generation to continue. Completed work is reused; actual summary attempts are not retried. The previous publication remains readable until its replacement is ready.

Run only one generation or data-changing command at a time per application database. A process lock prevents overlapping writers; a dead process's lock can be reclaimed. The reading service may remain running.

### Rebuild the current batch

To apply changed interests or ranking settings immediately:

```sh
npm run generate -- --clear
```

`--clear` discards partial generation and resets listing-generation state, including ranking snapshots, full-text caches, summaries, outcomes, and budgets. It preserves active votes, useful embeddings, and downloaded models. The old publication remains readable until replacement succeeds.

The rebuild uses cached feeds unless you also pass `--refresh`. After an interruption, resume **without** `--clear`; repeating it deliberately starts over again.

```sh
npm run generate -- --clear --summarize  # Rebuild with explicitly authorized paid summaries
```

Clearing allows new summary attempts and may incur new charges.

### Offline use

```sh
npm run serve                         # Read the saved listing
npm run generate -- --offline         # Generate from current cached feeds and models
npm run generate -- --offline --clear # Deliberately rebuild from those caches
```

Offline generation requires all requested category feeds and model assets to be cached already. Mixed feed dates are rejected; there is no older archive to fall back to. `--offline` cannot be combined with `--refresh` or `generate --summarize`.

## Interests and configuration

```sh
npm run generate -- --profiles path/to/interests.md --config path/to/config.toml
```

Defaults are [interests.md](interests.md) and [config.toml](config.toml). `--profiles` takes one Markdown file, not a directory. See the [profile example](README.md#make-it-yours) before editing.

Configuration covers score weights, feedback thresholds, and summary model/token limits. Invalid or unknown settings fail explicitly. Changing the embedding configuration or using a summary provider other than Cloudflare is not currently supported.

Ranking inputs are frozen at generation start and reused on resumption. New interests, votes, and ranking configuration affect the next generation; use an explicit rebuild to abandon an unfinished snapshot. Summary configuration is read on each manual summary invocation for still-eligible papers, without resetting previous outcomes or spent input.

## Optional AI summaries

### Setup and costs

Review the model and limits in **[config.toml](config.toml)** before enabling summaries. You need Cloudflare AI Gateway access and credentials in an ignored `.env` file at the repository root:

```dotenv
CLOUDFLARE_ACCOUNT_ID=your-account-id
CLOUDFLARE_API_TOKEN=your-api-token
CLOUDFLARE_GATEWAY_ID=your-gateway-id
```

Keep secrets out of TOML, commits, and shared output. Existing environment variables take precedence over `.env`. Credentials are loaded only for explicit online summary generation.

```sh
npm run generate -- --summarize
```

For a new or unfinished listing, this retrieves featured papers' HTML, makes sequential summary requests, then publishes. Missing HTML, API failures, and budget skips leave readable abstracts and visible summary-status messages; they do not change ranking.

**Only `generate --summarize` and online `summarize` authorize paid summary calls.** Requests use full available HTML text, not abstract-only substitutes. Local token estimates and configured budgets are not guaranteed dollar limits; check the provider's pricing and usage too.

### Add summaries to an existing listing

`generate --summarize` is a no-op for an already-published batch. To add summaries without rebuilding its ranking:

```sh
npm run text                    # Retrieve featured HTML; network access, no model calls
npm run summarize -- --tokens   # Estimate input tokens and completion allowances
npm run summarize               # Explicitly authorize paid requests and publish outcomes
```

These commands act on the **working listing**, which normally matches the publication after successful generation. If you have staged a different batch, they act on that batch instead.

Token preflight includes all featured papers, even those with cached summaries, and flags missing HTML/partial totals. It does not load credentials, call APIs, or change budgets/outcomes. `summarize --offline` likewise leaves summary state untouched.

### Resuming, failures, and clearing

Each uncached featured paper gets a separate request. Estimated input is reserved before sending. **Actual model attempts and budget skips are never automatically retried**, including after interruption; failed attempts do not refund reserved input. Repeating summarization processes only still-eligible papers. Successful cached summaries need no new request budget.

Missing HTML is a recoverable precondition, not a model attempt. Retry unavailable HTML explicitly, then rerun summarization:

```sh
npm run text -- --retry-unavailable
npm run summarize
```

To deliberately discard **all summary outcomes, reusable summaries, and budgets** in the selected application database:

```sh
npm run summarize -- --clear
```

This is clear-only: it makes no API calls and preserves rankings, embeddings, and HTML. It also clears the visible summaries if the working listing is published. Regeneration requires a separate `summarize` command and may incur charges. Use `generate --clear` instead for a full listing rebuild.

For inspecting actual provider responses:

```sh
npm run summarize -- --verbose
```

Verbose mode is also available with `generate --summarize`. It prints full responses for actual calls, with credential redaction; output may still contain paper text. Raw provider responses are not saved.

## Individual steps

Most readers only need `generate` and `serve`. These commands let you inspect or run stages separately:

| Command | Effect |
| --- | --- |
| `npm run fetch` | Fetch into the working listing without publishing. Supports `--categories`, `--refresh`, and `--offline`. |
| `npm run score -- --offline` | Rank the working listing using cached models and publish without summaries. Omit `--offline` to allow model downloads. |
| `npm run text` | Retrieve available HTML for ranked featured papers; does not publish or change ranking. |
| `npm run text -- --offline` | Inspect/re-extract cached HTML without downloads. |
| `npm run text -- --retry-unavailable` | Retry failed HTML retrieval; requires network access. |
| `npm run summarize -- --tokens` | Estimate full-prompt tokens without requests or summary-state changes. Cannot be combined with `--clear`. |
| `npm run summarize` | Summarize cached featured text and publish outcomes; potentially billable. |

If `fetch` requests the published batch while another batch is staged, it fails rather than silently switching working listings. Continue the working batch, use `serve` to read the publication, or deliberately rebuild with `generate --clear --categories ...`.

## Storage and resets

| Path | Contents |
| --- | --- |
| `data/app.sqlite` | Current publication, resumable working listing, embeddings, votes, and summary state. |
| `data/papers.sqlite` | Current category feeds, paper metadata, and relevant HTML/text caches. |
| `data/models/` | Downloaded local model assets. |

Use `--app-db path/to/app.sqlite` and `--papers-db path/to/papers.sqlite` to select another database pair. They must be different files, including filesystem aliases. Use the same pair across generation and serving; avoid concurrent experiments sharing a source database.

Generation prunes superseded reading artifacts. Latest active votes are kept for 365 days after their last explicit change; using a vote does not renew it. Cleanup happens during manual generation, not in the background. This working storage is not an archive or a bibliography.

For an ordinary reset, prefer `generate --clear`: it preserves votes and keeps the old page readable until replacement. Stop running processes and back up anything valuable before deleting databases. Deleting `app.sqlite` loses votes and the current listing; cached feeds and models can support a fresh offline generation, but not historical reconstruction. Development schemas have no migrations or compatibility layer.

## Hosted auth preview

```sh
npm run dev:hosted
```

Open the printed loopback URL and choose an example account through **Log in to your reader**. This runs the hosted Worker locally with signed fixture identities, synthetic saved listings, private voting, and default-interest onboarding. No email, inference, or cloud resources are used; state resets on exit and normal `data/` databases are untouched. Editors and generation controls are not implemented yet. See [hosted.md](hosted.md) before deploying anything.

## Development checks

```sh
npm test
npm run typecheck
```

These checks use recorded feeds/HTML, real SQLite, and local HTTP fixtures; they do not contact arXiv, download models, or make paid calls.

### Security scanning

Install the [Gitleaks CLI](https://github.com/gitleaks/gitleaks#installing) on your PATH (CI uses version 8.30.1), then run:

```sh
npm run security:audit    # npm advisory check, including development dependencies
npm run security:secrets  # Gitleaks, with secret values redacted
npm run security         # Both checks
```

CI runs both checks on pushes and pull requests. `npm audit` contacts the npm advisory service and fails on reported vulnerabilities at any severity; do not blindly run `npm audit fix --force`.

The secret scan copies current tracked files and non-ignored new files into a temporary directory, scans them with Gitleaks's default rules, and removes the copy afterward. It does not scan historical commits or ignored local files such as `.env`, `data/`, and `.wrangler/`. A credential file accidentally tracked with Git is still scanned even when its name matches `.gitignore`. Deleted files, submodule contents, and symlink targets outside the repository are not copied. `.gitleaks.toml` extends the default rules with exact-value, file-scoped exceptions for the public tokenizer revision/checksums and Access audience identifier. There are no blanket file exclusions or historical baseline. This is a guardrail, not a guarantee that every credential format will be recognized.

Optional real-model checks:

```sh
npm run test:model                  # May download model assets; no paid summaries
MODEL_OFFLINE=1 npm run test:model  # Requires already-cached assets
```

Hosted auth tests run in local workerd/D1 with signed fixture identities; no Cloudflare account is required. The completed feasibility experiments have been removed; their architecture findings remain in [the development plan](.agents/PLAN.md#retained-hosted-feasibility-findings).

Live generation contacts arXiv and may download model assets. Paid summaries require the credentials and explicit summary commands described above; they are never part of the ordinary test suite.
