# Hosted reader: local implementation and deployment

The hosted version is under development. Public/private reading, Access authentication, interests/configuration editors, per-user generation Workflows and confirmed admin controls are deployed. Manual execution and the explicitly authorized Monday–Friday 06:00 America/New_York schedule are enabled, observing DST. The cron supplies 10:00/11:00 UTC candidates; the application admits only the Eastern 06:00 event. The first scheduled attempt failed during ingestion before any generation or inference. Live model behavior and initial publication still need verification; older implementation/deployment notes below are historical where superseded by this status and `.agents/PLAN.md`.

Production adapter composition is implemented locally behind explicit execution
and schedule switches, both off by default. See [hosted-readiness.md](hosted-readiness.md)
for credential requirements, local test/build evidence, resource risks, schema
review, provider-policy checks, and the separately approved activation checklist.

The standalone local app (`npm start`, `npm run serve`) is unchanged and requires no Cloudflare login.

## Try it locally

```sh
npm install
npm run dev:hosted
```

Open the loopback URL printed by the command. **Log in to your reader** opens a local example-account picker:

- `owner@example.test`: admin, whose saved fixture listing is public.
- `friend@example.test`: a different private fixture listing and independent votes.
- `new@example.test`: first-login provisioning, default interests, and the waiting-for-first-update page.

This picker substitutes for Cloudflare's emailed code while testing locally. It still issues real signed JWTs, verified against an ephemeral local JWKS server. It sends no email and makes no Cloudflare account, model, or paid API calls. Do not expose the preview or its fixture identity provider through a public tunnel.

The preview seeds configuration from repository `config.toml`, so the admin editor is usable locally. Saving edits changes only the ephemeral D1 fixture, never that file.

Stop with Ctrl-C. Preview accounts, votes, saved document edits, and signing keys reset; existing `data/` databases and your personal `interests.md` are untouched. Fixture summaries/scores are explicitly synthetic, not real model results. No fixture users or publications should be seeded into a remote database.

## Route boundary

| Route | Behavior |
| --- | --- |
| `/` | Public admin publication, identical regardless of login; no vote forms or private account state. |
| `/assets/katex/*` | Public local CSS/fonts only. |
| `/login` | Sends the browser to the protected reader; real Cloudflare Access will handle email-code login. |
| `/logout` | Redirects to the Access logout endpoint; the local fixture clears its cookie. |
| `/reader` | Signed-in user's saved listing and voting forms, or a waiting message. |
| `/reader/vote` | Authenticated, origin/CSRF-checked POST for a paper in that user's current publication. |
| `/interests` | Authenticated GET/HEAD Markdown editor and revision/CSRF-checked POST save for the user's own interests. |
| `/admin` | Admin-only GET/HEAD TOML editor, explicit execution controls, and revision/CSRF-checked POST save for global settings. |
| `/admin/populate` | Admin-only paid-confirmed POST: fetch announcements once and launch ranking/full-text/summary Workflows for all enabled users. |

Local preview keeps execution off and has no Workflow binding or cron. Production enables explicit admin actions and weekday 06:00 America/New_York generation for all enabled users, within their independent saved limits. Scheduling is standing authorization for potentially paid inference; it observes DST and remains deduplicated by intended date. Visiting a page or saving a document never starts inference.

### Populate feed

On `/admin`, review **Populate feed**, check the paid-call consent for **all enabled users**, then submit. This works before first publication. Feed fetching/admission completes before the response; each user's generation continues independently in its Workflow, with saved inputs and independent token limits. Up to six featured papers per user receive full-text retrieval and summary attempts; missing HTML or limits can leave summaries unavailable. Other users' private status is not exposed to the admin.

The announcement date need not match today. A valid empty feed reuses the latest matching nonempty batch retained by current/working hosted snapshots. If none exists, a message explains that no generation was started and existing publications stay unchanged. There is no historical-feed backfill. Mixed/future/regressed feeds still fail safely. Already published batches are no-ops; unfinished work is skipped rather than cancelled or taken over. Replayed forms cannot fetch or launch again. A fresh explicit confirmation is required for another pass after ingestion failure. Own-listing **Rebuild ranking** and **Regenerate summaries** remain separate controls.

## Identity and data

Cloudflare Access will own the invitation allowlist and email-code sessions. A valid application JWT for our configured issuer/audience represents an approved invitation. There is no second application invitation list or password system.

First login creates a regular D1 user with a stable UUID, verified issuer/subject identity, email, enabled flag, and the agreed six broad quantum-computing profiles. Defaults are valid immediately: no initial save is required for eligibility when scheduled generation is later implemented. Login and reading never generate a listing. An existing user's interests, enabled state, and role are not reset on re-login. Identity/email changes or collisions require operator review rather than automatic account linking.

The admin is explicitly provisioned in D1; neither JWT role claims nor editable TOML grant that role. A unique index permits only one admin. The preview script performs this provisioning for its synthetic owner only.

`schema/hosted.sql` currently defines accounts with revisioned interests, a singleton saved configuration document, latest per-user votes, frozen working-generation inputs with chunked posting batches, and a normalized reading projection (publication pointer, small metadata, per-paper UI rows). It also defines shared scientific source caches, but is not an adapter for local SQLite. Publication rows are immutable inputs to reading; the publication writer uses a new generation ID on replacement. Bounded cleanup, 365-day feedback expiry, and shared paper/HTML/extracted-text caches are available as internal functions. Atomic embedding/successful-summary caches are also implemented locally. Ranking/summary execution, durable request admission, and per-user summary reservations/outcomes are implemented locally. Minimal Workflow orchestration is also implemented locally; weekday ingestion/admission and admin controls are implemented locally; live adapters/activation remain separately gated. Development schemas have no migrations.

Generation lifecycle fields now live directly in `generation_inputs`; the one-to-one `generation_state` table has been removed. Admission captures batch identity and summary-completion intent with the frozen documents in one row. Publication updates only lifecycle/output fields, never the frozen inputs. Current/working pointers, immutable reading projections, and source storage are unchanged. This consolidation reduced the schema from 19 to 18 application tables without introducing another lifecycle abstraction. The subsequent local inference-cache slice adds three small-result tables; the ranking and summary slices add embedding-request and summary-outcome tables. The local Workflow slice adds one latest-admission/status row per user in `generation_runs` (24 application tables at that slice), described below. The local scheduled-pass singleton brings the current total to 25.

Existing databases with the split generation tables require an explicit schema update/recreation before using the new generation functions; rerunning `CREATE TABLE IF NOT EXISTS` does not update them. Production still uses the prior split schema pending operator approval of this non-additive change. Recheck that generation tables are empty before any targeted recreation, preserving accounts, interests, configuration, and other retained data. No automatic reset or compatibility fallback is provided.

Vector and successful-summary caches use bounded atomic records rather than the source blob staging machinery. Published summary copies remain in `reading_papers.summary_json`, subject to the existing aggregate 1 MiB projection-row bound. Hosted cache acceptance also enforces an 8 KiB summary byte limit. Embedding admission and per-user summary claims/budgets are described below; neither is enabled by visiting a page.

## Saved inputs and plain-text editors (local-only UI)

`src/hosted/saved-inputs.ts` exposes direct D1 functions for `readSavedInterests` / `saveInterests` and admin-only `readSavedConfig` / `saveConfig`. Callers must pass the user ID established by verified authentication, never a submitted owner ID. Writes recheck enabled/admin state in SQL and require the revision originally read. A successful save increments that revision; competing or stale saves return `conflict` without overwriting newer text. Invalid, conflicting, and forbidden results preserve the submitted text for the editor. Documents are limited to 64 KiB of UTF-8 and validated with the shared Markdown/TOML parsers. The limit applies before parsing, not by truncating content.

Operator-only `initializeSavedConfig` seeds an absent document without overwriting saved edits. Production was seeded at revision 1 with the exact repository `config.toml` baseline. Its embedding settings still describe the standalone local backend. Hosted ranking instead selects the fixed Workers AI BGE adapter and records its distinct full fingerprint; it does not claim to use local ONNX/q8 weights. Token limits are settings, not authorization to make summary calls. No hosted summary authorization or execution is enabled.

`src/hosted/editors.ts` provides native HTML forms with labelled plain textareas and explicit Save buttons; no JavaScript editor, autosave, or execution action. POSTs require the application Origin, form encoding, exactly the expected fields, and a CSRF token bound to the verified user/session plus editor kind and base revision. Ownership never comes from form data. Successful saves redirect back to the editor. Validation failures (422) and revision conflicts (409) preserve submitted text, safely escaped, with the original revision/token scope. A conflict cannot silently become permission to overwrite a newer document on resubmission: a separate link opens the latest saved version in a new tab for reconciliation. Permission loss is rechecked during persistence and also preserves a validated form submission without saving it.

The form-body bound allows percent-encoded 64 KiB UTF-8 documents plus form fields. Documents exceeding 64 KiB but within that transport bound are returned intact with a validation error; unreadable or transport-oversized requests receive 413 without promising recovery of an unbounded body. Private responses remain no-store, and text cannot close the textarea or execute markup.

Pages distinguish the saved revision, editor base revision, current publication's applied revision, and any working generation's frozen revision. Missing publications or older fixture projections without recorded revisions are labelled explicitly. Global configuration status describes the admin's own listing, not every other user's applied state. Saving affects subsequent new generations, never an existing snapshot/publication; unchanged batches are not automatically rebuilt.

Real local HTTP/workerd/D1 tests cover ownership/role/session/action/origin boundaries, malformed forms, validation/conflict text preservation, Unicode size handling, redirects, saved-versus-applied status, and unchanged publications/frozen inputs/public responses. Typechecking and all **151 tests** pass. No document history, compatibility layer, execution binding, or production update is introduced.

## Frozen generation inputs (persistence only)

`src/hosted/generation-inputs.ts` provides `freezeGenerationInputs(db, userId, batches, modelIdentity, summariesRequested = false)` and `readGenerationInputs(db, userId, generationId?)`. An explicit ID can read that user's current publication snapshot or working snapshot, not arbitrary historical generations. The frozen summary flag records a completion requirement only; it does not authorize paid calls. They are internal functions for the authorized generation runner, not HTTP actions. The caller must provide the actual adapter compatibility fingerprint (provider/model/pooling/tokenizer/preprocessing/epoch), not just a model name. The snapshot module records it; the hosted ranking runner separately requires its exact supported fingerprint.

Admission copies interests/configuration text and revisions plus active vote values, paper metadata, and explicit-change times in one D1 transaction. Its timestamp is set by D1; votes older than 365 days are excluded without changing their stored timestamps or deleting live feedback. A user can have at most one working snapshot. Concurrent calls converge on that snapshot, and subsequent saves/votes or different supplied models/batches do not overwrite it. Disabled users cannot admit or read work. Snapshot capture does not change a publication. An already published announcement date/category combination is a no-op, even if documents, model settings, or feed metadata changed; admission returns `{ status: 'unchanged' }` for this case, `{ status: 'blocked' }` when it cannot capture work, or `{ status: 'captured', inputs }` for an owned snapshot. Admin same-batch rebuilding remains a separate future action.

The full posting batch (including source URLs, paper metadata, and membership) is serialized before asynchronous work and identified by SHA-256. Its UTF-8 bytes use 256 KiB BLOB chunks, read/written in pages of at most eight. A partial snapshot returns `batches: undefined`: no inference may use it. Retrying with the original batch bytes completes missing pages; a different batch cannot fill or replace it. Length, ordered chunk completeness, and SHA-256 are verified before decoding/sealing and on subsequent reads. Frozen paper membership is also indexed in bounded identity pages for shared-source retention. The future ingestion runner must retain original batch inputs until interrupted snapshot staging completes. Large papers are not silently truncated.

The local execution/Workflow slices below add deadline fencing and paid-effect claims. Cleanup can remove expired votes from a retained snapshot without rewriting its scientific results. The last authorized production check found no remote snapshots; no reset/publication endpoint is exposed. The original frozen-input tables were applied without changing the admin account or saved configuration.

## Atomic publication (persistence only)

`src/hosted/publication.ts` exposes three internal operations; none is a browser action:

- `stagePublication(db, userId, generationId, digest)` validates a complete ranked digest against frozen paper membership/content, profile/model/configuration identity, feedback provenance, and complete score/order data. If summaries were requested at admission, every featured paper needs a terminal outcome; unavailable HTML/API/budget/error outcomes are acceptable. Successful summary text is checked for nonempty content. The future inference pipeline is responsible for actual claims, accounting, and provider outcomes—not this storage function.
- Staging admits one immutable output hash per generation. It writes normalized paper rows in pages of eight and verifies persisted metadata/rows before marking the candidate ready. Exact replays resume interrupted work; a different output returns `conflict` without overwriting existing rows. Reading projection metadata and aggregate per-paper rows are bounded to 1 MiB, with oversized output rejected rather than truncated. The old publication stays readable throughout staging.
- `publishGeneration(db, userId, generationId)` atomically swaps the pointer, marks the candidate published, and releases the working slot. It rechecks ownership, enabled state, input/output completeness, and that this is still the user's working generation. Repeating a successful publication is harmless; a superseded/failed generation cannot replace a newer listing. The published snapshot remains addressable by the current generation ID, independently of later saved edits.
- `failGeneration(db, userId, generationId)` fences only that working generation and releases its slot, preserving the last publication and retained provenance. It cannot fail an already published generation or remove a newer working slot. The future scheduler/admin layer must authorize when to call it; no deadline/reset policy is activated here.

Reading pins an immutable listing ID, metadata, and expected paper count, then loads paper rows in bounded pages. It validates contiguous ordinals and the complete count before returning data. If cleanup overtakes the read, it retries once against the current pointer; a second incomplete read produces a private/no-store HTTP 503 with `Retry-After: 1`, never a truncated digest. Replacement invalidates stale vote forms. There are no reader leases, grace periods, or history endpoints.

## Generation-time retention

`src/hosted/retention.ts` exposes `cleanupHostedState(db, now?, maxPasses = 32)`. Daily admission calls it after pinning the new snapshot's paper references, preserving reusable scientific caches; execution calls it after successful publication. Continuations do not sweep global retention, and failed work can be pruned at the next admission. It is not called on page requests and has no public endpoint or schedule. It preserves every user's current publication and working generation (including incomplete staging), as well as active vote metadata. Each destructive statement rechecks current/working references, rather than relying on the earlier candidate selection.

Cleanup removes superseded/failed projections, batch chunks, snapshots, and state; clears zero-valued votes; and expires live/frozen votes older than 365 days after their last explicit change. Using feedback never renews that timestamp. Private example vectors are normalized in `generation_feedback_examples`, referencing the sole frozen vote metadata row; deleting that vote cascades to its vector. Reading projections no longer contain `feedbackSnapshot`. Private provenance is outside the display hash, and staging/replay filters expired evidence without repopulating deleted records or changing scores, order, titles, or summary text. Paper metadata still needed by a current/working scientific batch is retained independently of its former vote state.

The default budget is 32 passes; daily admission and successful publication each use two passes. Each child/feedback deletion statement targets at most 64 rows, with dependent vector rows deleted by cascade. It returns `{ rowsDeleted, complete }`; another call safely resumes after an incomplete sweep or interruption. This is intended for roughly daily low-traffic generation, not continuous high availability. The same bounded sweep now also prunes shared source outcomes, unreferenced blob chunks, and metadata. It retains source data pinned by any current/working generation and compatible cache entries for papers in those listings. Active feedback alone retains scientific metadata for re-embedding, not obsolete HTML/full text. Inference-cache cleanup now retains paper-vector variants for current/working papers, nonexpired frozen feedback, and active vote versions. Summary-cache variants are retained for current/working papers; private profile vectors are removed with their owning generation. The current metadata format requires an expected paper count; no old-format fallback or migration layer is provided.

## Shared scientific source storage (persistence only)

`src/hosted/source-store.ts` uses the same D1 transaction domain, with separate `source_*` tables. It does not fetch arXiv, perform extraction, or invoke models:

- `saveSourcePaper` / `readSourcePaper` cache scientific metadata by arXiv ID/version, recording and verifying its SHA-256. Metadata is bounded to 1 MiB and refreshed only by an enabled user's working generation containing that paper/version. This latest shared metadata never rewrites frozen batches, votes, or reading projections.
- `readSourceText` looks up an extractor-compatible outcome and pins it for the working generation. Existing pins remain readable while current/working, and take precedence over later shared-cache changes. An incomplete outcome returns undefined; it is not eligible summary input. Disabled users, another user's generation ID, and paper versions outside frozen membership grant no access or writes through these generation-scoped APIs.
- `saveSourceText` accepts already downloaded/extracted `CachedPaperText` data. Successes and failures are cache hits. An explicit `retryUnavailable` may replace only the caller's working failure association; it cannot downgrade a success, rewrite a publication, or clear another user's pin. A failed retry with no new HTML retains the previous raw HTML. Outcome identity includes paper/version, extractor, source URL, check time, status/reason, and content hashes.
- `readSourceHtml` returns verified raw HTML and its hash/provenance for offline re-extraction, including when raw storage completed but extracted-text persistence was interrupted. It may pin a compatible shared cache entry but never fabricates a completed extraction result. Different extractor revisions keep separate outcomes while sharing identical raw/text bytes.

Raw HTML and extracted text use immutable SHA-256-addressed UTF-8 blobs, persisted in 256 KiB chunks with eight-chunk pages. Length, ordered completeness, and hash are verified before sealing and before use. HTML retains the local 16 MiB admission limit; oversized data is rejected, never truncated. Extracted text is stored completely in chunks. A generation association protects preparing blobs against cleanup. Interrupted writes resume only matching content, with the original check timestamp; identical concurrent writes share bytes. Cleanup can interrupt a superseded generation, which must stop rather than consume partial source data.

Source retention uses frozen membership, current reading membership, generation outcome pins, and active vote versions. Removing one user's generation cannot delete another user's required source data. Unreferenced old extractor/retry outcomes and their unused bytes are disposable, not a source archive. Frozen feedback already retains its own exact scientific metadata for resumption.

`src/fulltext-types.ts` contains the platform-neutral contracts/constants; existing local retrieval exports and behavior are preserved. Tests use recorded HTML and the real shared extractor with local workerd/D1. No source data was seeded remotely. End-to-end hosted ingestion resource usage and external-request admission remain to be validated when the runner is implemented; embedding/summary caches and paid-call claims are outside this slice.

## Inference caches (local persistence only)

`src/hosted/inference-cache.ts` adds three tables and no request lifecycle:

- **`paper_vectors`:** complete scientific vectors keyed by paper/version, exact title/abstract input hash, and the frozen generation's full hosted model fingerprint. The caller selects batch or frozen-feedback input; metadata is taken from that snapshot, not arbitrary submitted text. Both reads and writes validate finite, normalized 384-dimensional vectors. Local and hosted spaces must use different fingerprints.
- **`generation_profile_vectors`:** private completed vectors keyed by generation/profile, with a semantic-input hash. Profile inputs come from frozen interests. A compatible result can be reused only from the same user's current/working generation; reading a reusable hit copies it atomically into the working generation. This preserves resumable progress without a separate private-cache/reference graph. Changed subjects/title/model invalidate reuse; keywords are not embedding inputs.
- **`summary_cache`:** successful scientific text only. Identity is derived from frozen paper identity, verified pinned extracted text/hash/extractor, exact message roles/content hash, shared prompt version, and frozen provider/model/completion settings. Token estimates and per-user budgets do not change content identity. Actual model and creation time are recorded, but initiating-user token usage is not shared as another user's accounting.

All writes require enabled, owned working generations and use first-writer-wins atomic inserts. Reads are scoped to owned current/working generations. There are no partial vector/summary records, chunks, cache-specific state machines, or new shared reference tables. Summary lookup may pin compatible source text through the existing source API. A cache miss is not authorization for inference; concurrent cache insertion safety does **not** deduplicate external requests.

Hosted summary acceptance rejects output above **8 KiB UTF-8**, as well as empty/malformed text using the existing 4,000-character formatting validator. It never truncates text. Identity metadata is capped at 16 KiB and actual model metadata at 1 KiB, leaving a complete cache row far below D1's row/result limits. The existing 1 MiB aggregate publication-row check remains independent. Prompt version/format validation moved to the platform-neutral summary module, preserving local exports and behavior.

Cleanup deliberately retains cache-key variants at paper/version granularity while any current/working listing needs the paper. Paper vectors additionally survive for active or retained nonexpired frozen votes; summaries do not. This may keep a few old model/input variants longer than strictly necessary, avoiding another exact-key reference graph. Published summary text is an inline copy and remains unchanged even if its cache entry disappears. Private profile rows are deleted in bounded pages with superseded/failed generations.

Tests use fixture vectors, recorded HTML, and real local workerd/D1, including compatible concurrent writes, model/input/prompt/config isolation, private profiles and frozen edits, Unicode byte bounds, interrupted inserts, published-copy independence, and cross-user/feedback expiry. Typechecking and all **146 tests** pass. That storage-only slice added no provider, tokenizer download, Workflow, budget reservation, summary-attempt outcome journal, execution endpoint, or schedule. Paid-effect claims/accounting and featured-paper eligibility must be implemented in the execution path before calls are enabled. End-to-end hosted runtime resource behavior remains unverified.

This cache schema and the preceding generation-table consolidation are **local-only** pending explicit production approval. Do not run fixture seeders or silently reset existing databases.

## Hosted ranking and embedding admission (local-only)

`src/hosted/ranking-runner.ts` supplies an internal `runHostedRanking(db, userId,
generationId, transport, maxRequests = 8)`. Finish freezing the posting batches
first, using `HOSTED_BGE_FINGERPRINT` and `summariesRequested = false`. Persist and
reuse that generation ID on resumption. This is not an HTTP action, scheduler,
Workflow binding, or authorization to call a model.

The runner uses frozen profiles/configuration/votes and shared scoring/selection,
reuses complete scientific vectors and same-user private profile vectors, and
re-embeds incompatible feedback. It returns `paused` after its request allowance,
`waiting` for another generation's shared request, or a terminal `published`,
`failed`, or `stale`. Completed chunks resume without another request, including
mid-paper interruptions. Only complete normalized vectors enter the vector
caches. A completed ranking is staged and atomically published with no summaries;
failures retain the previous publication. Cleanup uses two bounded passes before
and after successful ranking; standalone maintenance retains its 32-pass default.

`src/hosted/bge.ts` packages the verified upstream tokenizer metadata and uses
standalone `@huggingface/tokenizers` 0.2.0, not an ONNX loader. See
[`assets/bge/README.md`](src/hosted/assets/bge/README.md) for exact provenance,
hashes, and licensing. The Workers AI REST adapter explicitly requests **CLS**,
limits batches to eight inputs of at most 512 locally counted tokens including
special tokens, bounds request/response bodies to 1 MiB, and validates 384-dimensional
finite nonzero vectors before normalizing. Profiles alone receive the retrieval
instruction. Long bodies are chunked and their normalized vectors averaged and
renormalized; oversized prefixes are rejected rather than truncated. The full
fingerprint includes provider/model, pooling, tokenizer revision/hashes/library,
preprocessing, chunk aggregation, batch size, and invalidation epoch. Hosted and
local vectors never share a space. Workers AI does not expose pinned provider
weights here; packaged metadata does not prove its internal tokenizer revision.

`embedding_requests` records durable per-generation claims and completed chunk
results (128 KiB result bound). Scientific request keys can be shared; private
profile keys include the owning user. Claim acquisition happens inside the effect
callback, with fresh active-generation/ownership/enabled checks before dispatch
and persistence. Another user's in-flight claim causes waiting, never takeover
or finalization. An unresolved own claim fails the generation **without resend**,
even if a compatible cache entry subsequently appears. A timeout, invalid result,
or lost response follows the same fail-closed policy. Persistence alone gets three
attempts while a validated response remains in memory. The transport has one
60-second attempt and no redirects, retries, or fallback; it does not use Gateway.
Publication rejects unresolved claims, and bounded generation cleanup removes
request rows with unneeded generations.

A later separately admitted generation may try again. **Do not turn a failed run
into an automatic new-generation retry.** The future executor must serialize calls
for one generation, retain its ID across step retries, and implement admission/date
deduplication and deadline/abandoned-owner handling. There is no lease reclaim or
polling loop here. Credentials and an authorized transport must be supplied
explicitly; no current page or production binding invokes this code.

Typechecking and all **161 tests** pass, including real workerd tokenization/D1,
frozen edits, cache/privacy isolation, bounded resumption and long-input chunks,
loopback REST validation, ambiguous/process-loss attempts, transient and permanent
persistence failures, shared-request contention, and stale/disabled workers.
Only static tokenizer metadata/documentation were downloaded: no weights, live
inference, arXiv fetch, remote schema change, deployment, or schedule. Hosted runtime
resource limits and live ranking quality still require a separately approved review.
The subsequent summary-execution slice is described below.

## Hosted summary execution (local-only)

`src/hosted/summary-execution.ts` executes the frozen featured selection against
verified, generation-pinned source text. `runHostedGeneration` in
`src/hosted/ranking-runner.ts` connects ranking, summary execution, and atomic
publication. The existing `runHostedRanking` entry remains ranking-only. Summary
execution requires both frozen summary intent and explicitly supplied execution
adapters; neither configuration edits nor limits alone authorize calls.

One `summary_outcomes` table holds at most six rows per generation: sealed featured
order, pending/claimed/complete state, charged estimated input, a run-budget-stop
marker, and a bounded terminal outcome. There is no separate budget database,
lease system, or shared failure cache. A single conditional SQL update reserves
input and acquires the claim, checking owned/enabled active work, the frozen
per-user run ceiling, and competing compatible requests. Total spent input is the
sum of those reservations. Actual usage is recorded separately when valid, never
used to refund or reset reservations.

- Sequential requests default to one actual summary call per invocation (maximum
  six). Completed outcomes resume without model calls. Another user's in-flight
  request returns `waiting`, without taking it over or changing their accounting.
- Compatible successful cache hits require no reservation and copy no initiating
  user's usage. Exact messages, verified text/extractor, provider/model, prompt
  version, and completion allowance determine compatibility.
- The existing `o200k_base` tokenizer counts the complete prompt with frozen
  framing/headroom settings. This remains an **estimate**, not a verified match
  or hard dollar-spend guarantee. Paper/context failures do not truncate input or
  acquire paid claims. Once the remaining run allowance is insufficient, later
  uncached requests are skipped even if smaller ones would fit; cache hits stay free.
- An own unresolved claim becomes an unavailable terminal outcome without resend
  or refund, even if shared content has since appeared. Provider errors and invalid
  output are terminal individual failures, with generic diagnostics. Successful
  content and the initiating user's outcome commit in one transaction. Only this
  persistence transaction is retried (three attempts) while the response is in
  memory; lost acknowledgements can reconcile the exact saved result.
- Source resolution is an explicit injected adapter, invoked for featured papers
  only. Tests use recorded HTML and the shared extractor in workerd. Missing HTML
  is a zero-charge outcome. Known unavailable source pins are reused by default;
  `retryUnavailableSource` explicitly permits refreshing a pending paper's source,
  not retrying a completed model/budget outcome or altering another user's pin.
- All requested outcomes must be durably terminal and match the candidate before
  publication. Pending/claimed rows fence staging and publication in SQL. Individual
  summary failures can publish with the completed ranking; generation-level failures
  preserve the previous publication. The existing inline copies remain independent
  of later cache removal. Cleanup removes outcomes with unneeded generations, not
  retained current/working reservations.

`src/cloudflare-summary.ts` contains the shared environment-neutral HTTP adapter,
requiring explicit credentials. The standalone `src/cloudflare.ts` remains its Node
convenience wrapper. Transport makes one bounded-response, 120-second HTTP attempt,
rejects redirects, sends `cf-aig-max-attempts: 1`, and supplies no model fallback.
**Gateway/provider-side retry and fallback settings still require independent
verification before activation.** No hosted credentials, production inference/Workflow binding, execution endpoint,
live source downloader, admin execution control, or schedule is enabled.

Typechecking and all **171 tests** pass with local workerd/D1, fixture inference,
recorded HTML, and loopback HTTP transport tests—no Cloudflare account or hosted
D1 access is required. Tests cover frozen settings, per-user budgets, free shared
hits, source refresh, missing credentials, context/paper limits, oversized output,
unknown attempts, shared contention, transaction rollback/lost acknowledgements,
privacy, stale/disabled workers, publication, and cleanup. Parallel fixture asset
preparation now replaces files atomically to avoid concurrent copy races.

## Minimal Workflow wiring and admin status (local-only)

`daily-runs.ts` admits at most one daily attempt per user/intended Eastern date,
then freezes the existing inputs and creates a Workflow with the generation ID as
its instance ID. The caller supplies recorded/prepared batches; no feed downloader
or trigger is enabled. A delayed trigger must supply its original `runDate`, not
silently turn yesterday's delivery into today's work. Unchanged announcement
batches remain no-ops. Later edits still affect only future generations.

One `generation_runs` row per user preserves daily deduplication, the pending
admission/launch reference, deadline, latest outcome, and last successful
publication time through generation cleanup. It does not replace the lifecycle in
`generation_inputs`. Concurrent duplicate deliveries choose one reservation;
process loss before snapshot capture or a failed/unconfirmed launch does **not**
automatically create or launch another generation. Known preparation/launch
failures remain pending until intervention or the next weekday boundary.

`HostedGenerationWorkflow` wraps `runHostedGeneration` in sequential bounded
steps with fresh D1 activity checks **inside** retried callbacks. Only the two
IDs and small status results enter the Workflow journal—not documents, text,
vectors, or digests. Each callback permits four embedding requests and one
summary request. With the existing transport timeouts and at most six HTML
requests, the worst-case network allowance is nine minutes, leaving a minute
within the ten-minute step for SQL/CPU/persistence. Eight-input embedding batches
are unchanged; the standalone internal runner's default allowance is still eight. Step retries retain the same generation and its existing
no-repeat claims/reservations. Shared work permits three five-minute sleeps;
exhaustion fails only the waiter. A 256-step ceiling fails safely rather than
running indefinitely. There are no leases, claim takeovers, watchdogs, automatic
replacement generations, or stranded-launch reconciliation service.

Deadlines are the next weekday's 06:00 America/New_York boundary, including DST.
`expireDailyRun` is a trusted boundary operation that also works for disabled
owners, releasing their working slot without touching the prior publication or
refunding claims. **The future weekday caller must sweep unfinished runs for all
owners, including disabled accounts, before launching enabled users.** It is not
an active cron here. SQL deadline fences independently prevent late effects,
artifact writes, and publication even if that boundary callback is delayed.
Already dispatched requests cannot be unsent; their late responses cannot replace
the previous reading.

The admin page shows only that admin's last successful publication timestamp and
latest daily outcome, including unconfirmed launch failures. Pending work and
unchanged-batch checks do not advance the success time. Publication records success
atomically with the reading-pointer swap; journal completion alone is not success.
Status survives cleanup and adds no execution or recovery controls.

The daily-reader simplification keeps this flow explicit: snapshot admission returns
`captured`, `unchanged`, or `blocked`, without the launcher reinterpreting an absent
snapshot. Adapter setup receives only IDs and summary intent; the runner's validated
snapshot is reused by its summary phase instead of being loaded again at those
entry points. Bounded retention runs once at admission (after pinning the new batch) and after successful
publication, not on every model continuation. One failure transaction handles both
ordinary enabled-owner execution and trusted daily cleanup, preserving their
different authorization rules. `prepareDailyRunStep` is deliberately named as a
mutating lifecycle operation. No new storage or recovery mechanism was added.

`test/hosted-workflow.test.ts` uses native local Workflows/workerd/D1, recorded HTML,
and fixture inference. It exercises duplicate launch, interrupted admission,
lost step/final acknowledgements, bounded shared waiting, disabled owners, DST,
late deliveries/responses, already-ready publication fences, budget conservation,
and admin status/cleanup. Simplification regressions also reject mid-run cleanup,
check boundary-failure rollback, and preserve reusable vectors while admitting a
new batch. Typechecking and all **183 tests** pass without a
Cloudflare account, credentials, or hosted D1. Only the test harness binds the
fixture Workflow; production and local-preview Wrangler configurations still have
no Workflow binding or schedule.

### Pre-deployment review fixes (local-only)

Empty batches now skip all profile and feedback embeddings, even with cold caches
and active votes. Frozen vote metadata is preserved; an empty publication needs
no feedback vectors or summary/source calls.

Summary execution derives its context once from the already validated frozen
inputs and verified pinned text. Cache lookup reuses that context with fresh
owner/pin checks. A text-only source read verifies the extracted-text hash without
loading raw HTML; full source/raw APIs remain available for storage and
re-extraction. Newly saved source results are reused rather than immediately
reloaded. There is no cache-identity or schema change.

Regression tests cover cold empty publication, actual per-Workflow-step request
counts, transport timeout headroom, one text read per cached featured paper,
absence of duplicate snapshot/raw-HTML reads, and disabled/unpinned cache denial.
Typechecking and all **218 tests** pass. Production remains unchanged and disabled.

## Confirmed admin controls (local-only)

`admin-controls.ts` adds native forms separate from **Save**:

- **Rebuild ranking** uses the currently published posting batch (no new feed
  fetch), latest saved interests/configuration and current votes. It includes
  normal featured-summary processing with compatible cache reuse. New embeddings
  and summary misses may incur costs.
- **Regenerate six featured summaries** preserves the published ranking, paper
  order, scores, ranking inputs, private feedback provenance and compatible own
  profile vectors. It freezes the latest saved summary model/tokenizer/limits and
  bypasses summary content hits for this new generation only. Unavailable source
  preconditions may be refreshed through the supplied source adapter. It makes
  no embedding requests. Smaller listings regenerate only their featured papers.

Both actions require an explicit paid-call checkbox and POST, an enabled admin,
Origin/CSRF checks, and a form bound to the session, action, publication, saved
revisions, and last run ID/date. A conditional reservation consumes the form before
capture/launch; duplicate or stale forms return 409, including after failure,
cleanup, or a later daily no-op. Requests always target the authenticated admin;
there is no user selector. Unfinished work is rejected—even a stranded launch—
without cancellation or takeover. Each confirmed action authorizes a fresh
per-generation allowance; earlier spending is never refunded. Per-paper/context
limits still apply, estimates are not dollar caps, and individual missing/error/
budget outcomes may publish as unavailable summaries.

The existing per-user Workflow, claims, budgets, deadline fences and atomic
publication are reused. No new table, queue, recovery loop or retry service was
added. `generation_inputs` records the action and base publication; summary-only
runs additionally freeze a separate summary configuration/revision so changing
models or limits does not mislabel the old ranking's configuration. The admin
editor displays ranking and summary configuration revisions separately. Manual
admission consumes the admin's daily date opportunity without changing anyone
else's admission; further manual runs need fresh confirmation.

Summary regeneration never clears shared caches or another user's claims,
accounting or publication. Same-key cache entries remain first-writer-wins, while
the new private outcome and inline publication hold the regenerated text. Shared
in-flight work follows the existing bounded wait policy. SQL fences recheck admin
role and the base publication as well as activity/deadline; late callbacks cannot
publish after revocation or replacement. Publication validates that summary-only
work has not changed any ranking rows. Generation-level failure leaves the prior
reading intact; no automatic replacement is launched.

`test/hosted-controls.test.ts` exercises real local HTTP/auth, Workflows and D1 with
recorded sources and synthetic inference: confirmation/action/session/role/origin
checks, stale revisions, concurrent/replayed forms, six cache-bypassing requests,
step replay without resend, frozen latest model/budgets, feedback/profile-vector
preservation, shared-claim waiting, pending capture failures, explicit restart,
revocation fencing, and no-op replay protection. Typechecking and all **195 tests**
pass without a Cloudflare account or remote D1. Execution without a Workflow
binding remains disabled. The four new snapshot columns, controls and preceding
local changes have not been deployed.

## Weekday shared ingestion and admission (local-only)

`src/hosted/scheduled.ts` implements the once-weekday pass. The production entry
now has a scheduled handler behind separate execution/schedule switches, both
false in the manifests, with no active cron or Workflow binding. The internal
entry requires an explicit feed transport and Workflow binding. Saving
configuration is not execution authorization.

A future **single** `0 10,11 * * 1-5` UTC cron expression can supply the two DST
candidates. The gate accepts only the event timestamp corresponding to weekday
06:00 America/New_York—not its delivery time. It rejects future events and events
past their next-weekday boundary. Delayed accepted events retain their original
Eastern run date; the displayed posting date still comes from arXiv.

Configure shared feeds in the admin's saved TOML:

```toml
[ingestion]
categories = ["quant-ph", "cond-mat.mes-hall"]
```

Omitting this optional table defaults to `quant-ph`. Names are validated,
normalized and deduplicated, with at most eight entries. Standalone CLI category
flags remain independent. The category list is captured once for the shared
pass; each user's model/ranking documents and votes freeze at that user's
admission, as before. Mid-pass edits never rewrite an admitted snapshot.

The pass first consumes its intended date in one singleton `scheduled_pass` row,
then sweeps expired work for **all** owners, including disabled accounts and
snapshot-less reservations. This sweep happens even if ingestion later fails.
Each configured feed is fetched once, sequentially, with the existing 30-second/
8-MiB bounds and redirects rejected. Any fetch/parse failure, mixed dates, future
announcement or date regression skips all user admission for this pass. There is
no partial batch, stale fallback, same-day retry or feed archive. A valid empty
feed is not a failure; an entirely empty new batch may publish an empty listing
without model calls. Unchanged/holiday batches remain per-user no-ops.

The shared batch goes to every enabled user through existing date/work-slot
admission, with **featured summaries requested for every user**. Disabled state
is checked again at admission/effects. Each user's frozen input-token ceiling is
independent; compatible summary hits are free. Admission/launch failure for one
user does not stop the others. Workflows run independently after launch, with the
existing bounded shared-claim waiting policy. A pass marked complete means
admission finished, not that every generation succeeded.

The singleton retains only the latest consumed date/status and latest validated
batch date (a regression watermark), surviving ordinary retention. Concurrent
or repeated triggers cannot refetch or replace a partially admitted cohort.
Interrupted passes stay consumed until the next date; no lease, takeover,
watchdog, automatic relaunch or generic job machinery was added. The admin page
shows this shared pass separately from the admin's own run, exposing no other
user's status or accounting.

`test/hosted-scheduled.test.ts` exercises real local D1/Workflows, recorded RSS,
synthetic providers and native scheduled-event dispatch. Coverage includes DST,
weekends, duplicates, HTTP/XML/mixed-date failures, delayed/expired events,
unchanged batches, disabled owners and mid-fetch disablement, independent launch
failure, regression/late-response fences, empty batches, scientific cache reuse,
and independent per-user summary ceilings. Typechecking and all **207 tests**
pass; no Cloudflare account, live source/model calls or remote D1 is required.

Production adapter wiring is now implemented locally, disabled by default.
Next: explicitly approved schema inspection, deployment and activation work. Existing consolidated tables plus the manual
snapshot columns and scheduled singleton remain unapplied remotely. Gateway/
provider retry verification and deployed resource validation remain prerequisites
to live inference. Neither Wrangler configuration has been given an active cron
or generation binding.

## Security choices

- Pinned `jose` verifies RS256 signatures and issuer, audience, application-token type, subject/email, expiry, and issue time. Seven days is the maximum accepted session age/duration. Signing keys come only from the configured issuer's bounded JWKS endpoint and are cached for rotation; token-provided key URLs and unverified email headers are not trusted.
- The assertion header takes precedence; a bad assertion cannot fall back to a different valid cookie. Cookie-only requests still undergo the same JWT verification.
- A local HTTP issuer is allowed only alongside a loopback HTTP application origin. There is no skip-auth flag or hardcoded signing key in the Worker. Every request must match `PUBLIC_ORIGIN`, so alternate Worker hostnames cannot bypass the boundary. Proxy/forwarded headers do not choose the issuer or redirect destination.
- Every private request reads the D1 enabled state/role. Private pages, redirects, and errors use `private, no-store`. Public output never depends on login; static paper rendering is reused per publication and audience, with only authorized votes/forms assembled live.
- Forms use a per-user HMAC bound to the JWT session and publication. POSTs require the exact application Origin, a bounded form body, and exactly the expected fields. The vote transaction rechecks enabled state, ownership, current publication, and membership. Repeated desired states do not renew vote timestamps.
- Paper text and interests are escaped; KaTeX trust features remain off. Pages use a restrictive CSP and no browser JavaScript. Credentials, JWTs, and raw authentication errors are not logged or returned.

For immediate removal, **disable the D1 user as well as removing their Access invitation and revoking their Access sessions**. Offline JWT verification cannot discover per-session revocation by itself. Access's [logout endpoint](https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/#log-out-as-a-user) clears its browser cookie and revokes sessions at the edge; Cloudflare documents a 20–30 second propagation delay. Disabling the application user blocks subsequent private requests without waiting for token expiry. The local fixture demonstrates cookie logout, not real Cloudflare revocation.

## Tests

```sh
npm test
npm run typecheck
```

The auth integration checks use real RSA signatures, a loopback JWKS HTTP server, workerd, D1, and local KaTeX assets. They cover identity rejection, provisioning, private ownership/cache isolation, disabled accounts, role spoofing, CSRF/session/publication binding, idempotent voting, and login/logout routing. No real Access application or email service is required. Existing scientific/local tests remain available. The completed feasibility probes have been removed; their architecture findings are retained in `.agents/PLAN.md`.

## Deploy together, after local review

The operator has created the Access application and the `ruminator` D1 database. `wrangler.production.jsonc` contains their non-secret production identifiers and custom domain; `wrangler.hosted.jsonc` remains local-only. The schema through the shared-source slice has been applied successfully to remote D1, without fixture or local data; the subsequent generation-table consolidation, inference caches, embedding-request table, summary-outcome table, and latest-admission/status table are not yet applied. The auth-only Worker is deployed at `https://papers.ribeill.net` (version `4a16bf56-c2e2-4854-b444-aab06cab01a2`). Typechecking and the dry run passed; public reading/assets return 200, login redirects to the reader, and anonymous bare/nested private paths redirect to Access with no-store headers. The Access policy was verified to allow only the operator's email. The operator confirmed real emailed login/private reading. The verified D1 identity was granted the sole admin role by stable user ID. The operator also confirmed the Admin link/page and logout followed by a fresh Access login challenge. Read-only API checks confirm workers.dev and version previews are disabled and the only listed Worker custom domain is `papers.ribeill.net`; both root and `/reader` return 404 at the workers.dev and deployed-version preview hostnames. Enumeration of legacy zone Worker routes returned 403 with the existing token; the operator confirmed in the dashboard that only `papers.ribeill.net` is active. The operator confirmed that disabling the D1 account denies an already logged-in reader. The admin account has been re-enabled, its role preserved, and the operator confirmed restored browser access. Full Access invitation/session revocation remains untested; live cross-user ownership/voting verification requires another invited identity and actual publications. The saved-input baseline seed, frozen-input/publication/provenance tables, indexed source membership, and shared source tables have also been applied, preserving the enabled admin account and configuration revision 1. Production still has zero generations/publications. Typechecking and all 139 tests passed before the latest redeployment; production was verified to have no generations or reading projections before adding indexed source membership. No local source data or fixtures were uploaded. Public/assets responses and private Access challenges were rechecked afterward. No inference or schedules are enabled. Before completing the first auth-only deployment we will:

1. Create/select a real D1 database and apply the current schema explicitly; do not run the fixture seeder remotely.
2. Configure `PUBLIC_ORIGIN` as the chosen HTTPS subdomain and set the real Access team issuer and application audience. Replace the dummy D1 ID. Keep `workers_dev` and preview URLs disabled.
3. Configure an Access email-code application/allowlist and seven-day sessions. Verify **all bare private paths and their descendants**, including the vote endpoint, are covered by the configured application audience. Keep `/` and assets public; do not put an Access challenge in front of the entire site. Resolve any dashboard path/application-audience constraints before opening access.
4. Sign in as the owner, inspect the verified D1 identity, then grant the sole admin role by that stable user ID. Invitation/role management remains manual. Remove access by disabling the user, removing the allowlist entry, and revoking sessions—not by deleting their row and permitting re-provisioning.
5. Check anonymous public reading, real emailed login, private reads/votes, logout, account disabling, cache headers, and alternate-host denial on Cloudflare.

This initial deployment can validate authentication without inference. Real hosted generation and summary costs remain disabled until the subsequent storage/generation slices and their explicit activation review. No Hugo rebuild or personal-site repository change is required.
