# ruminator development plan

ruminator generates a minimal, distraction-free arXiv browsing page, initially focused on `quant-ph`. It features six papers, preserves access to the full posting list, and encourages serendipitous discovery rather than replacing reading papers. Ranking uses a small semantic pipeline; optional LLM summaries are provider-independent and cached to limit token spend.

This public plan records architecture, implementation milestones, and future work. Keep personal identities, invitation lists, resource identifiers, credentials, deployment versions, and operational diaries out of it. Changes here do not authorize remote operations, destructive resets, paid calls, or schedule activation.

## Scope and architecture

Standalone local operation uses TypeScript, SQLite, manual generation, local embeddings, and a loopback reading/voting server. Hosted operation uses a separate Cloudflare Worker, D1, Access, hosted inference, and Workflows. A hosted installation is authoritative for its users and runs independently of their computers; local installations remain independent, not synchronized replicas.

Keep APIs flat and explicit. Prioritize correctness, readable code, low cost, and safe paid effects over infrastructure or high availability. Separate these responsibilities:

- **Ingestion:** fetch arXiv announcement batches and cache scientific metadata.
- **Generation:** snapshot interests/configuration/feedback, obtain embeddings, compute scores/selections, request authorized summaries, and save a completed digest.
- **Presentation:** render saved digests. Browsing never fetches papers, calls models, or recomputes ranking.
- **Feedback:** persist explicit votes for future digests. Hosted writes require authenticated ownership or the appropriate admin role.

### Right-sized operation

This is WIP hobby software. Breaking changes and explicitly confirmed resets of disposable development state are acceptable. Roughly daily weekday execution and ~90% availability are sufficient; this is a tolerance, not a monitored SLA. Missed updates, safe large-paper failures, and manual repair are acceptable. Preserve the previous publication when available; do not add failover, leases, watchdogs, automatic claim takeovers, migration infrastructure, or paid monitoring to chase uptime.

Reset permission must be specific to an installation and operation. Confirm exact targets and quiesce old execution before deleting claims; loss of state must not enable duplicate paid effects. Standalone local data and future retained user data require separate decisions.

Treat approximately $5/month as a soft estimate, not a guaranteed maximum bill. Existing per-user token reservations plus deliberately configured provider daily/monthly spending caps are sufficient controls. Review rough model/platform costs, included allowances, cap scope, and actual usage as the cohort grows. Pricing/tokenization uncertainty and cap-enforcement lag are accepted; no internal dollar ledger or aggregate budget service is required. Caps may safely skip work.

Low availability does not relax verified authentication, invitation/role/ownership boundaries, Origin/CSRF/stale-form checks, private no-store responses, escaping, bounded inputs, secrets handling, atomic publication, or durable no-repeat claims and reservations.

### Ephemeral listing contract

Keep one current publication and at most one resumable working listing per standalone installation, or per hosted user. Only the admin's hosted publication is public. There is no historical navigation, daily archive, unread queue, or archive reconstruction.

1. Fetch a complete announcement batch and freeze interests, configuration, and active votes.
2. Persist scores, featured selections, requested summary outcomes, and the entire remaining-paper order.
3. Publish atomically only after ranking and requested summary attempts finish.
4. Store subsequent votes separately; they affect only future listings.

Refreshes, votes, and settings/provider changes never reorder an existing publication. Fetch-only work stays invisible in staging. Feed/ranking failures retain the old publication; unavailable HTML/API summaries do not block an otherwise complete publication. Persist progress to resume without repeating paid attempts.

A repeated published announcement date/category batch is a no-op. Local `generate` fetches/ranks; `generate --summarize` additionally authorizes featured-text retrieval and paid summary attempts. `generate --clear` deliberately restarts working generation while preserving the old publication, and requires `--summarize` again for paid calls. Development step commands remain available.

Prune during generation, including failure paths where practical. Remove superseded batches, rankings, full text, summaries, snapshots, and unneeded vectors. Retain inputs needed by any current/working listing or active feedback. Keep only latest active votes, expiring 365 days after their last explicit change; using feedback does not renew retention. Expire private frozen provenance without rewriting published scores/order/text.

### Research-interest configuration

Use one `interests.md` document containing independent profiles. Each `## Display name {#stable-id}` starts a profile; `### Subjects`, optional `### Keywords`, and example headings belong to that profile. Stable IDs survive renaming/reordering. Parse profiles in ID order so document arrangement cannot affect tie-breaking. `--profiles` accepts a Markdown file, not a directory; there is no legacy directory format.

Names and Subjects are semantic inputs. Keyword groups are separate lexical inputs. Positive/negative example sections are placeholders, not ranking inputs. Explicit votes supply feedback.

### Local storage

- `data/papers.sqlite` (`schema/papers.sql`): current per-category feed/freshness, paper metadata/authors, and relevant raw/extracted HTML.
- `data/app.sqlite` (`schema/app.sql`): publication, working generation, embeddings, active vote memory, rankings, and summary provenance/accounting.
- `data/models/`: independently cached model assets, preserved through application resets.

Expose separate `--papers-db` and `--app-db` paths; reject aliases of the same file, including symlinks and hard links. Use current schemas only: no migration runner, upgrade path, or legacy fallbacks during development. Keep SQL within D1's supported SQLite subset where practical, without a generic storage framework.

Offline generation uses only current downloaded category feeds and cached models; reject mixed dates rather than searching history. The local server binds only to loopback, follows atomic replacements, and never invokes inference. Use bounded generation locking/contention waits and rotate form tokens when publication changes.

## Hosted application contract

### Public and private routes

Use a dedicated application hostname and Worker, independent of any personal-site build. Styling may remain consistent with a minimal static site, but Hugo export and cross-repository publishing are not prerequisites.

- Public: `/` and local KaTeX assets. Public output is always the admin publication and excludes private vote states.
- Authenticated: `/reader`, `/reader/vote`, and `/interests`.
- Admin-only: `/admin` and its descendants.

Use Cloudflare Access emailed one-time codes with seven-day sessions. Access is the sole invitation allowlist; there is no open registration or application password/session system. Verify RS256 app assertions against bounded, cached issuer JWKS, checking configured issuer/audience, identity, type, and times. Never trust unverified headers, submitted ownership/roles, or token-selected key URLs.

Automatically provision approved identities as regular enabled users with stable IDs keyed by verified issuer/subject. Explicitly grant the sole admin role outside editable TOML. Identity/email collisions or changes require operator review, not automatic linking.

New users receive six valid broad quantum-computing profiles: hardware; control/measurement; error correction; algorithms; architecture/scaling; simulation/applications. First login and saving interests never start generation. Before first publication show a waiting message, never another user's private listing. Valid defaults make the user eligible for a subsequent authorized cohort update without an initial save.

Enforce ownership, role, and enabled state server-side; mutation predicates recheck eligibility. Bind CSRF tokens to identity, session, action, and publication/revision as appropriate. Reject wrong or missing POST Origin and stale forms. Private responses are no-store and must not leak across users or public caches. Keep alternate Worker hostnames/previews disabled. Canonical HTTP-to-HTTPS redirects should preserve paths/queries without weakening application origin checks.

Removing an invitation alone does not immediately invalidate an existing JWT. Revocation requires disabling the application user, removing Access admission, and revoking sessions. Logout uses Access's logout endpoint. Keep invitation/role management manual initially.

Secrets belong in hosted secret configuration, never editable TOML, snapshots, scientific content, published artifacts, or logs. Keep deployment and runtime inference credentials separate and least-privileged.

### Plain-text editors and explicit execution

Provide native Markdown interests and admin-only TOML editors. Validate documents with a 64 KiB UTF-8 bound. Use revision-checked saves; preserve escaped submitted text and the original base revision on validation/conflict failure. No autosave, editor framework, or structured profile builder is needed.

Show saved, published-applied, and working-frozen revisions, including separate summary revisions. Saving applies only to future generation and never mutates an existing publication or in-progress snapshot. Regular users cannot force a run, reset, rerank, or request summaries.

Keep Save, Rebuild ranking, Regenerate summaries, and Populate feed distinct:

- **Rebuild ranking:** admin's own current posting batch with latest saved interests/configuration/votes; no feed fetch. Preserve old publication until replacement. Require explicit paid consent and reject unfinished work.
- **Regenerate summaries:** bulk replacement of all featured summaries, not individual-paper selection. Preserve ranking/order/scores and their original inputs while freezing latest summary settings. Require fresh paid consent; a new generation is the explicit no-retry exception. Bypass the admin's content hits without deleting shared content or other users' claims/accounting.
- **Populate feed:** explicit admin-confirmed cohort action. Fetch configured feeds once and admit normal per-user Workflows for all enabled users. It can initialize a new user or admit a new same-day batch, but never replaces unfinished work or rebuilds an already published batch. Preserve mixed-date, future-date, and regression guards.

For valid empty feeds, reuse the latest matching nonempty batch retained by current/working snapshots. If none exists, preserve publications and report waiting/no retained batch. Do not add a historical source/backfill mechanism.

### Weekday execution and paid-effect safety

Target one update at 06:00 America/New_York, Monday–Friday, observing DST. Display the arXiv announcement date, not the scheduler date. A single `0 10,11 * * MON-FRI` UTC cron supplies both DST candidates; the intended-timestamp Eastern gate accepts only 06:00. Use named weekdays because Cloudflare numbers Sunday as 1. Local preview remains inactive.

Scheduling requires separate execution and schedule switches, a Workflow binding, valid runtime credential configuration, explicit standing paid authorization, and reviewed per-user budgets. Only exact `"true"` enables a switch. Page visits and saved settings do not authorize execution. A plan entry is not authorization to install a cron or run paid checks.

Fetch each configured category once per cohort. Fetch/parse failure, mixed dates, future dates, or a regressed batch admit nobody and preserve publications. A singleton latest-pass record consumes the intended date before ingestion, preventing automatic retries after failed/interrupted ingestion. Manual paid confirmations use fresh atomic attempt IDs. Redacted diagnostics contain only fixed stages, intended date, category, and HTTP status—not exception messages or bodies.

Admit one working generation per user with frozen documents/votes, durable intended-date deduplication, stable generation/Workflow IDs, and next-weekday 06:00 deadline. One user's failure must not invalidate another's completed publication. Each enabled user receives up to six featured summary attempts within independent limits; compatible scientific work may be shared, never private interests/votes/accounting.

At the next boundary, fence unfinished old work from new claims and publication, retain spent/ambiguous claims and the prior publication, and allow latest-batch admission. Already dispatched external requests cannot be unsent. Recheck activity before effects and writes without claiming a transaction between D1 and the provider.

Use one sequential Workflow per generation over the existing lifecycle. Journal small references/scalar results, not full text/vectors/digests. Steps allow four embedding requests or one summary request per callback, with a ten-minute timeout and transport headroom. Keep a bounded step count and three five-minute shared-work sleeps, then fail only the waiter. Interrupted/unconfirmed launches await manual intervention or the next boundary; no leases, takeover, recovery service, or second lifecycle framework.

Acquire durable claims and per-user input reservations inside the retried effect callback, never from a cached step result. No automatic resend of actual or ambiguous summary requests and no refund/reclaim of ambiguous spending. Retry only persistence while the response remains in memory; otherwise retain an unavailable outcome. Never finalize another user's shared in-flight claim. Independently verify Gateway/provider retries, fallbacks, and response caching are disabled/bypassed.

### Hosted persistence and inference

Use D1 as the hosted source of truth, in one transaction domain with logically separated source/application tables. Keep normalized immutable membership/content, atomic per-user publication/accounting, and bounded reference-aware cleanup. Do not prune shared artifacts still needed by another user's current/working listing or active feedback.

Store large text as 256 KiB UTF-8 byte chunks, reading/writing at most eight per page/batch. Verify completion, byte length, and SHA-256 before use. D1 sessions provide sequential consistency, not multi-query snapshot transactions. Readers pin immutable IDs, validate complete contiguous rows, retry once if overtaken by cleanup, and otherwise fail uncached rather than serving a partial listing. No reader leases or archive API.

Keep scientific paper vectors and successful summary content shared. Profile vectors are private to a user's retained generations. Shared summary hits do not reserve new input or copy another user's provider usage. Published summaries are immutable inline copies with an 8 KiB UTF-8 acceptance bound; projection rows have an aggregate 1 MiB bound. Pruning a cache cannot rewrite published text.

Use hosted inference for hosted generation and local ONNX for standalone operation. Their embedding spaces remain distinct even with a matching model name. Fingerprint provider/model/pooling/tokenizer/preprocessing/aggregation plus an invalidation epoch. Re-embed feedback in the generation's current model space.

Bound transport bodies before parsing: RSS 8 MiB, HTML 16 MiB, model responses 1 MiB. Hosted HTML uses validated versioned arXiv IDs, a fixed host, no credentials, no redirects/assets/PDF fallback, and a bounded timeout. Scientific text must not be silently truncated. Safe rejection of exceptional papers is acceptable; HTML DOM extraction remains a resource risk worth representative testing.

## Retained hosted feasibility findings

The experimental probes are retired; retain their design findings, not their deployment state or credentials:

- Shared RSS/HTML parsing, Markdown/TOML validation, token counting, and KaTeX rendering work in local workerd without Node compatibility. Isolate filesystem, SQLite-driver, ONNX, and local-server dependencies from shared logic.
- D1 supports the normalized/chunked design above. Recheck [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) when changing storage; reviewed limits included 2,000,000-byte values/rows, 100,000-byte statements, 100 parameters, and 50 MB results.
- Workflows support replay-safe bounded execution when admission/claims remain authoritative in D1. Recheck [Workflows limits](https://developers.cloudflare.com/workflows/reference/limits/) when changing orchestration; the reviewed non-stream step-result limit was 1 MiB.
- Workers AI `@cf/baai/bge-small-en-v1.5` uses 384 dimensions and requires explicit `cls` pooling; its default `mean` is incompatible with this application. Count CLS/SEP within 512 tokens, repeat titles across sentence/token-bounded chunks, apply the retrieval instruction to profiles only, normalize each chunk, average, and renormalize.
- Package standalone `@huggingface/tokenizers` 0.2.0 metadata for `BAAI/bge-small-en-v1.5` revision `5c38ec7c405ec4b44b94cc5a9bb96e735b38267a`. `tokenizer.json` SHA-256: `d241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66`; `tokenizer_config.json` SHA-256: `9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3`. These are public artifact identities, not credentials.
- Reference endpoint checks accepted five 384-dimensional CLS vectors with local token counts `[512, 512, 260, 24, 512]`. This does not prove pinned provider weights, deployed-tokenizer equivalence, model immutability, or ranking quality.

## Implementation milestones

Implement focused slices with representative integration/correctness tests, not a coverage target or generic testing framework. Prefer real SQLite/workerd/D1/Workflows and recorded sources over exhaustive mocks. Retain model-call counts where they protect cache reuse and no-repeat guarantees.

- [x] Local feed ingestion, separate source/application databases, offline model/cache reuse, and loopback reading.
- [x] Stable Markdown profiles, explicit lexical keywords, semantic scoring, feedback propagation, diversified selection, and persisted MMR ordering.
- [x] Versioned HTML extraction, token preflight, optional sequential summaries, cache identities, budgets, and no-repeat attempts.
- [x] One atomic publication plus resumable working generation, stale-form rejection, active-vote expiry, and reachability pruning.
- [x] Shared escaped rendering, bounded transport, KaTeX, native disclosures/votes, minimal styling, and repository-edited `ui_text.toml`.
- [x] Hosted Access verification, automatic regular-user provisioning, server-side isolation, private responses, and revision-checked editors.
- [x] D1 frozen snapshots, chunked scientific source storage, shared inference caches, private profile vectors, atomic publication, and bounded retention.
- [x] Hosted embedding/summary execution with durable claims, independent per-user reservations, deadlines, and sequential bounded Workflows.
- [x] Admin-owned rebuild/bulk summary regeneration, explicitly confirmed cohort Populate feed, empty-feed reuse, and intended-time weekday scheduling.
- [x] Native form Origin compatibility and Workers manual-redirect handling without forwarding credentials or retrying paid requests.
- [x] Local fixture tests and CI; `npm audit` plus redacted Gitleaks scanning of the current Git-visible working tree. No historical scan or history rewrite is required by this plan.
- [ ] Lightweight hosted vote updates without page refresh, only after explicitly requested implementation and review of scheduled operation. Use a small same-origin vanilla JavaScript enhancement and explicit JSON response option on the existing endpoint. Preserve normal forms as the no-JavaScript fallback, disable affected controls while saving, confirm persistence before changing selected state, and show accessible inline errors for stale publications/expired sessions. Retain all server-side checks, private no-store responses, and immutable rankings. Narrow CSP only for the same-origin asset; leave standalone voting unchanged unless requested.

## Agreed ranking and browsing design

### Embeddings

Embed paper titles/abstracts as scientific text, not HTML. Profile queries contain display name and Subjects, excluding Keywords/comments/example placeholders, with the BGE retrieval-query instruction applied only to profiles. Split overlength inputs into sentence-oriented token-bounded chunks with repeated title and room for special tokens. Normalize chunks, average, and renormalize; do not silently truncate.

The local artifact is `Xenova/bge-small-en-v1.5`, revision `ea104dacec62c0de699686887e3f920caeb4f3e3`, q8 CPU inference through pinned Transformers.js 4.3.2. Cache by content and full model/preprocessing identity. Download once into ignored `data/models/`; offline mode prohibits further downloads. `serve` never infers.

Use maximum cosine across profiles as raw semantic relevance. Normalize with `(cosine + 1) / 2`, retaining per-profile similarities/provenance. Avoid daily min-max normalization. The browser shows saved combined relevance to two decimal places, or semantic fallback for semantic-only previews; scores are not probabilities or scientific-quality judgments.

### Relevance and feedback

Initial weights are `S = 0.60 * semantic + 0.25 * keywords + 0.15 * feedback`; validate nonnegative finite weights summing to one. Freeze them with each generation.

Explicit votes mean more/less relevant, not good/bad science. Use raw embedding cosine with configurable minimum similarity 0.90 and near-duplicate threshold 0.95. Consider active examples newest first, greedily suppress duplicate base IDs or near-duplicate vectors, and let latest evidence win conflicts. For retained examples use `weight = (cosine - cutoff) / (1 - cutoff)` and:

`feedback = 0.5 + 0.5 * sum(weight * signed_vote) / (1 + sum(weight))`

No evidence stays neutral at 0.5. Freeze active votes and thresholds at generation start; all example vectors must match the generation fingerprint. Keep private provenance for inspection without displaying it in the public reader.

Keywords come only from explicit bullets. Semicolons group aliases. Match whole phrases after case/punctuation/hyphen/simple-plural normalization, never inferred Subjects or partial token coverage. Count each group once, weight title hits twice abstract hits, and saturate with `1 - exp(-evidence / 2)`. Missing keywords are neutral 0.5; configured keywords without hits score zero. Take the strongest profile, including neutral values. Keyword-only edits reuse semantic embeddings, but cannot rewrite a published ranking.

### Featured selection and remaining order

Feature up to six distinct papers: four relevance picks, one adjacent-topic pick, and one wildcard. Persist roles and complete order, not just a random seed.

Defaults in `src/ranking.ts`:

- Relevance-pick redundancy penalty: 0.04.
- Adjacent objective: semantic minus 0.35 times keywords minus 0.15 times maximum featured similarity, plus 0.05 for a previously unrepresented best-matching profile.
- Avoid identical titles and cosine similarity at least 0.95 when alternatives exist. Relax diversity preferences for tiny/redundant pools, keeping distinct IDs and allocating relevance slots first.
- Wildcard: equal mixture of uniform and softmax semantic sampling, initial temperature 0.05. Keywords/hard relevance cutoffs do not constrain it. Seed by batch date/categories.
- Remaining papers: greedy MMR with `0.7 * relevance - 0.3 * maximum_similarity`, initialized by the featured set, plus fixed seeded per-paper jitter of ±0.005. Every remaining paper eventually appears.

Show selection labels Selected, Adjacent, and Wildcard. Use closed native Abstract and AI-summary disclosures for featured papers, with abstract before summary and links/votes outside both. Remaining papers use expandable titles with score, compact authors, abstract, and links/votes. Voting uses accessible small + / − controls with selected-state clear/change behavior.

### Summaries

Summaries cannot affect ranking, selection, or order. Only featured papers are eligible, one request at a time in saved order. Retrieve only versioned arXiv HTML; defer TeX/PDF fallback until evidence warrants it. Cache raw HTML, extracted text/hash/extractor identity, and unavailable states. Re-extract cached raw HTML offline where possible. Missing/unusable HTML does not silently become abstract-only input.

Request two short factual sentences grounded in the supplied paper, describing what was done and the principal result/qualification. Distinguish experiments, simulations, proofs, and proposals; preserve uncertainty and avoid invented findings or quality judgments. Paper content is untrusted data, not instructions. Formatting validation cannot establish factuality.

Use a provider-independent interface, initially Cloudflare AI Gateway with a configurable model. Keep credentials in runtime environment/secrets, out of snapshots. Never follow inference redirects, retry actual attempts, or fall back to another provider. Local verbose response logging redacts credentials; do not persist raw provider errors/responses as provenance.

Estimate the exact sent messages locally, including framing/headroom and a separate completion allowance. Nonmatching tokenizers are estimates, not guaranteed upper bounds. Enforce per-paper/context and per-generation input limits before each request. Cache hits reserve nothing. Persist the claim and input reservation before sending, retain charges through failures/resumption, and stop later uncached requests when the next paper exhausts the run allowance.

Cache successful summaries by paper ID/version, verified text hash, extractor, prompt version/exact message hash, provider/model, and output-generation settings. Budgets alone do not invalidate scientific content. Failures/skips belong to their generation; shared content never shares private accounting. Published summary text is immutable until an explicit replacement action.

Manual local summary invocations may use latest settings for still-eligible work while preserving prior outcomes/reservations. HTML-unavailable preconditions may be revisited without retrying a model attempt. `summarize --tokens` is estimate-only and makes no budget/outcome writes. `summarize --clear` deliberately clears only summary state and exits without credentials, source access, or API calls; regeneration is a separate paid command.

## Source semantics and rendering

Use `https://rss.arxiv.org/rss/{category}`. Include `new` and `cross`, exclude replacements, and deduplicate across categories. Derive announcement date from channel `pubDate` in US Eastern time. Require all feeds to report the same date; never silently find an older shared batch. Old announcement dates around weekends/holidays are legitimate. There is no historical backfill.

Local downloads retain current per-category freshness independently of publications. `start`/`fetch` reuse the current Eastern-day download; `--refresh` explicitly bypasses it. Failed requests do not advance freshness, and successful categories survive a later-category failure. Keep only current useful source data, not per-date archives.

Render delimited TeX server-side using KaTeX for `$…$`, `$$…$$`, `\(…\)`, and `\[…\]`. Escape paper/summary/user content, disable KaTeX trust features, and fall back to escaped source on unsupported math. Serve styles/fonts locally. Pre-render static scientific content per publication while keeping votes/forms live; HEAD avoids page assembly. Resolve footer year at rendering time.

Parse authors from `dc:creator` in feed order. Show all abbreviated names for up to four authors; longer lists show first two … last two, with full-name tooltips. Keep collaboration names, common surname particles, and normalized TeX accents. Source author enrichment must not rewrite immutable published snapshots.

## Open questions and guardrails

- Evaluate summary factuality/usefulness on real papers; model choice remains configurable and prices/access require review rather than hard-coding operational assumptions here.
- Calibrate keyword/adjacent/MMR/wildcard constants and feedback cosine/shrinkage against reader judgments. Current values are explicit defaults, not probabilities or final calibration.
- Evaluate 365-day active-vote memory and current/working retention in actual use without adding a daily archive.
- Keep manual Access invitations, automatic regular-user defaults, explicit admin provisioning, and enabled-user revocation. No open registration, structured profile editor, or user-publication feature is planned.
- Use representative resource/security/large-paper checks rather than load testing or an availability programme. Safe downtime or manual repair is preferable to weakening authentication, publication integrity, or paid-effect safety.
- Future remote changes, resets, inference tests, and standing schedule activation need explicit authorization and installation-specific checks outside this public plan. Do not infer authorization from completed code milestones.
