# Plan

The project will generate a minimal, distraction-free daily arXiv browsing page, initially focused on `quant-ph`. It should feature six papers, preserve access to the full posting list, and encourage serendipitous discovery rather than replace reading papers. Ranking should use a small semantic pipeline; LLM summaries for featured papers should be provider-independent and cached to limit token spend.

## Scope and architecture

Build a fully local app first, using TypeScript, SQLite, a daily generation command, and a small local server for HTML preview and vote submission. No full web framework is required initially. Keep APIs flat and explicit; prioritize correctness and readable code over infrastructure.

Separate these responsibilities:

- **Ingestion:** fetch arXiv announcement batches and cache paper metadata.
- **Generation:** read profiles and a snapshot of feedback, obtain embeddings, compute scores and selections, request summaries, and save a completed digest.
- **Presentation:** render saved digests as static HTML. Browsing does not call models or recompute rankings.
- **Feedback:** persist explicit votes through the local server for use in subsequent digests.

Use narrow provider-independent interfaces for embeddings and summaries. Use BGE-small-en-v1.5 as the initial embedding model, locally through Transformers.js/ONNX. It produces 384-dimensional vectors and has a 512-token context window. Its availability in Cloudflare Workers AI (`@cf/baai/bge-small-en-v1.5`) provides a future hosted path; do not implement Cloudflare integration yet. Record provider/model identity and content hashes in caches; vectors from incompatible models must not be compared.

Use two SQLite databases and a small database module, keeping SQL within D1's supported SQLite subset where practical. Keep downloaded paper information/source metadata separate from disposable application state. Use current schema definitions only: no migration runner, version upgrades, or legacy schema fallbacks during development. Isolate filesystem, local-server, and database-driver dependencies from ranking and generation logic. Do not build a generic storage framework or implement a D1 adapter yet.

### Daily lifecycle and immutability

1. Fetch a posting batch and snapshot the profiles, configuration, and votes available at generation start.
2. Generate and persist scores, selections, summaries, and the complete remaining-paper order.
3. Publish the completed digest to the local HTML view/export.
4. Store subsequent votes separately; they affect only future digests.

A displayed digest is a fixed artifact: page refreshes, new votes, and provider/configuration changes do not reorder or rewrite it. Cache intermediate work so interrupted generation can resume without repeating successful paid calls. Keep incomplete runs separate from published digests. Seeded randomness is reproducible, but persisting final order is what guarantees display stability.

### Local storage

- **`data/papers.sqlite`** (`schema/papers.sql`): archived announcement batches, paper information/source metadata, and latest per-category download/freshness records. Preserve this database across application schema changes.
- **`data/app.sqlite`** (`schema/app.sql`): generated digest snapshots, vectors, semantic score/profile snapshots, and later votes/summaries. Recreate this database explicitly when its schema changes; do not migrate old development schemas.
- **`data/models/`**: independently cached model assets, also preserved during application DB resets.

Expose separate `--papers-db` and `--app-db` paths; reject using the same file. Offline commands reuse published digests when available, or reconstruct an unscored digest from the latest announcement date shared by all requested archived categories. This allows local re-scoring after an application reset without re-fetching arXiv. `serve` can reconstruct this initial view but never invokes a model.

Retain at least:

- Papers: arXiv ID/version, title, abstract, categories, and source metadata.
- Posting batches: announcement date and paper membership, separate from paper identity.
- Profiles and embeddings: content/configuration snapshots or hashes, model identity, and vectors for papers and profile inputs.
- Votes: paper identity, up/down value, and timestamps; allow changing or clearing a vote without changing existing digests. Preserve enough history or snapshot data to reproduce feedback inputs.
- Generation runs/digests: posting batch, configuration/profile/model identities, feedback snapshot, completion state, ordered paper membership, and selection roles.
- Scores: semantic, keyword, feedback, and combined relevance components for inspection.
- Summaries: structured response and cache identity.

### Future integration (not current implementation)

The personal site uses Hugo. Eventually a scheduled daily job will generate a digest, export Hugo content/data, and trigger a site rebuild. Static pages will submit votes to a small API; votes will affect only the next generated digest. Cloudflare Workers and D1 are the intended runtime/storage options, not prerequisites for the local app.

Keep generation independent of presentation so Hugo can replace the local renderer without changing ranking. A Worker would trigger a Hugo build rather than run Hugo itself. Hosted model calls are the natural fit for Worker execution; paid Workers still have execution/resource limits, so preserve restartable stages and the option to run generation elsewhere. No Cloudflare integration, deployment infrastructure, or scheduling setup is required now.

## Implementation sequence

Implement one focused slice at a time, with integration and correctness tests for non-trivial logic rather than exhaustive mocking.

- [x] Create six editable Markdown research-interest profiles with example subjects and space for negative feedback.
- [x] Document the agreed local-first architecture, immutable-digest lifecycle, and ranking/display design.
- [x] **Local ingestion and browsing slice.** Set up the minimal TypeScript project and SQLite schema; fetch and persist the latest `quant-ph` announcement batch, with configurable additional categories. Display six seeded random papers with titles, abstracts, and versioned PDF links; show every remaining title in a native dropdown revealing its abstract and links. Provide download-only, offline preview, and download-plus-preview commands. Tests cover recorded RSS parsing, deduplication, small/empty batches, real SQLite persistence/idempotency/rollback, immutable snapshots, escaped HTML, and loopback HTTP serving. Live ingestion and a repeated download were verified. This temporary random/expandable layout precedes relevance-based selection and the final title-only remainder layout.
- [x] **Math rendering and development download cache.** Render delimited TeX in all titles and abstracts with server-side KaTeX, serving styles/fonts locally and retaining escaped source for malformed/unsupported expressions. Cache each category's download once per US Eastern calendar day; make `start`/`fetch` reuse it by default, support `--refresh`, and keep `serve` strictly offline. Persist successful per-category downloads independently of published digests. Test math/security/fallback behavior, local assets, cache hits across category combinations, daily rollover/DST, failures, empty batches, and cache persistence without live arXiv calls.
- [x] **Local embeddings and visible semantic scores.** Load positive profile subjects; run pinned q8 BGE-small locally through Transformers.js/ONNX with CLS pooling, query instructions, token-bounded sentence chunks, and normalized vectors. Cache vectors by content/model/preprocessing identity; persist complete per-digest semantic score/profile snapshots. Show a three-decimal fixed-scale score and closest-profile tooltip for every entry, retaining current selections/order. Add offline scoring and preview support. Test parsing, normalization, chunking, cache invalidation/isolation, interrupted-run resumption, score visibility, immutability, and current-schema initialization. Verified real-model relevance, long inputs, offline reload, and scoring all 83 cached papers without contacting arXiv.
- [x] **Separate source/application storage; remove schema compatibility.** Replace numbered migrations with current paper/app schema files and remove old schema versions/fallbacks. Store downloaded batches and freshness in an independent paper database; keep digests, embeddings, and scores in the disposable application database. Reconstruct digests offline after an application reset. Test separate on-disk databases, reset/reopen behavior, preservation of source bytes/freshness, and latest shared-batch selection. Copy the existing local arXiv download once into the new source cache, leaving the original database untouched; no conversion code remains in the app.
- [ ] **Next:** Implement keyword/feedback components, combined relevance scores, seeded six-paper selection, and MMR ordering. Inspect real posting data to calibrate constants; test determinism, uniqueness, diversity behavior, and preservation of all remaining papers.
- [ ] Add provider-independent batched summaries, validation, and caching. Test with structured response fixtures and failed/invalid output; retain readable abstracts when summaries are unavailable.
- [ ] Complete fixed-digest generation and the minimal reading interface: six featured papers, remaining title links, and persisted up/down/clear votes. Connect feedback to future generation. Test that voting does not change published digests and that feedback is captured only for subsequent runs.
- [ ] Document and exercise the full local workflow, including resumable generation and cached reruns. Keep external model/API smoke tests optional and explicit about credentials and spend.

## Agreed ranking and browsing design

### Local embedding baseline

- Embed each paper's title and abstract as scientific source text, not rendered HTML.
- Build profile queries from the profile name and positive subjects; exclude comments, empty sections, and negative feedback. Apply BGE's recommended retrieval-query instruction to profiles, not papers.
- Use model-appropriate pooling and L2 normalization. Split overlength paper inputs into sentence-oriented, token-bounded chunks with the title repeated; average chunk vectors and renormalize rather than silently truncating long abstracts. Account for special tokens and the title within the context budget.
- Use maximum cosine similarity across profiles for the initial raw semantic score; retain all per-profile similarities for inspection. Display `(cosine + 1) / 2` on a fixed [0, 1] scale, rounded to three decimals, with the closest profile in a tooltip. This is semantic relevance only, not yet the combined relevance score.
- Download model assets once into a repository-local ignored cache, then support offline inference. Cache vectors by content and a fingerprint including model revision, backend, precision, pooling, and preprocessing/chunking configuration.
- Implemented artifact: `Xenova/bge-small-en-v1.5`, revision `ea104dacec62c0de699686887e3f920caeb4f3e3`, q8 CPU inference through pinned Transformers.js 4.3.2. Model assets live under ignored `data/models/`; vectors and score snapshots live in SQLite. `score` processes saved data without arXiv calls; `--offline` also prohibits model downloads. `start` scores new/unscored digests; `serve` never performs inference.
- The first complete semantic snapshot can enrich an existing unscored digest without changing selections/order; after that, profile/model changes affect future digests only. Preserve the complete profile inputs and model fingerprint with each score snapshot.
- Treat local ONNX and future hosted outputs as distinct embedding spaces until compatibility is verified; sharing a model name does not guarantee identical preprocessing or vectors.
- Inspect scores on real cached postings and evaluate a small set of reader-labeled matches, adjacent papers, and misses before calibrating combined scoring. Cosine similarity is not a probability; avoid daily min-max normalization that forces a weak day's best match to appear maximally relevant.

### Relevance

Start with `S = 0.60 * semantic + 0.25 * keywords + 0.15 * feedback`, with components normalized to comparable scales. These are initial weights, not calibrated constants.

Explicit up/down votes mean more or less relevant to the reader's interests, not judgments of scientific quality. Feedback should inform relevance for future papers; absent evidence should be neutral.

### Featured papers

Show titles, LLM-generated summaries, and abstracts for six distinct papers:

1. Four highest relevance scores, with a small redundancy penalty.
2. One adjacent-topic paper: favor semantic connections with low keyword overlap and a topic not already represented.
3. One wildcard: a date-seeded random draw from remaining candidates, excluding near-duplicates of the other selections.

For the wildcard, start with an equal mixture of uniform sampling and softmax sampling over semantic relevance. Feedback may later make a modest adjustment; keywords and hard relevance cutoffs should not constrain this slot. Calibrate softmax temperature against observed similarity distributions rather than assuming a scale.

### Featured-paper summaries

After selecting the six featured papers, send only uncached papers to an LLM provider in a batch. The request supplies each paper's arXiv ID, title, and abstract, plus concise relevant profile context and its selection role (top relevance, adjacent, or wildcard). The JSON below is the requested response shape, not the input paper data:

```json
{
  "papers": [
    {
      "arxiv_id": "2601.01234",
      "summary": "Two to three factual sentences.",
      "relevance_reason": "Why this might be worth reading."
    }
  ]
}
```

Ask for summaries grounded only in the supplied title and abstract: preserve uncertainty, distinguish proposed results from demonstrated ones, and do not invent findings or evaluate scientific quality. Treat paper text as data, not instructions. The relevance reason should be one short sentence connecting the paper to the supplied interests where justified; for a wildcard without a clear connection, explain its exploratory value without inventing a personal match.

Keep this contract independent of provider-specific SDKs. Validate returned IDs and fields against the requested batch before accepting results; associate results by ID rather than response order. Cache results using paper content/version, relevant profile context, selection role, prompt version, and provider/model identity so changed inputs do not silently reuse stale text. If summarization is unavailable or invalid, retain the paper and its abstract with an explicit summary-unavailable state. LLM output does not affect ranking.

### Remaining postings

Show every remaining daily posting as a title-only list linking to the paper. Order greedily using Maximal Marginal Relevance (MMR): balance personal relevance against maximum embedding similarity to papers already selected. Initialize this comparison set with the six featured papers so the list opens with alternatives to them.

Add a small, fixed random offset per candidate, seeded by announcement date and applied consistently throughout ordering. Keep the perturbation small relative to the calibrated relevance/diversity terms; it should loosen ordering, not overwhelm it. All remaining papers must eventually appear, including low-scoring papers and near-duplicates excluded from featured slots.

## Implemented source and batch semantics

Use `https://rss.arxiv.org/rss/{category}`, which includes abstracts and the current announcement batch without per-paper scraping or pagination. Include `new` and `cross` announcements, exclude `replace` and `replace-cross`, and deduplicate papers across configured categories. Derive the announcement date from channel `pubDate` in US Eastern time, not the local calendar date or a submission-date search. Display the reported date; the latest batch can predate today, especially around weekends/holidays. There is no historical backfill yet.

Require all requested feeds to report the same date. Publish a digest only after all requested categories are available; successful downloads are archived independently, and failures do not publish partial digests. Save the first source batch and digest snapshots for each date/category or category set, and do not silently overwrite them on reruns. The paper database stores source metadata and paper information as JSON batch snapshots; the application database stores copies within immutable digest snapshots. Additional indexed tables can be introduced when ranking and feedback require them.

The local server binds only to loopback and serves a saved snapshot without network access on page requests. Restart it to display a newly downloaded digest. Math is rendered server-side with KaTeX for `$…$`, `$$…$$`, `\(…\)`, and `\[…\]`; styles and fonts are local assets, so cached reading needs neither a CDN nor client-side scripts. Paper HTML remains escaped and KaTeX trust features are disabled; unsupported math falls back to escaped source.

A separate per-category download cache tracks when feeds were successfully retrieved, independently of announcement dates and immutable published digests. `start` and `fetch` reuse downloads from the current US Eastern calendar day, even across different category combinations. `--refresh` explicitly bypasses this cache, without overwriting published digests. The download cache and batch archive live solely in the paper database and survive application schema resets. Failed requests do not advance cache freshness, while successful categories remain cached if a later category fails. Since the cache checks only once per calendar day, a later same-day feed update requires an explicit refresh. `start` reports download failures rather than silently serving stale data; `serve` explicitly opens existing data offline.

## Open design questions
- Choose the summary provider/model separately; keep provider configuration flexible and credentials out of saved/public artifacts.
- Specify score normalization, feedback propagation with neutral behavior when no votes exist, adjacent-topic selection, MMR balance, and perturbation scale using actual posting data.
- Fix deterministic candidate ordering and stable paper IDs for seeded selection; define behavior for batches with fewer than six papers and all other undersized candidate pools.
- Define explicit handling of corrected batches or intentional regeneration without silently mutating a published digest.

The first local browsing slice is complete. Continue with the next unchecked slice only when requested; Cloudflare and Hugo integration remain deferred.
