# ruminator

[![Tests](https://github.com/gribeill/ruminator/actions/workflows/tests.yml/badge.svg)](https://github.com/gribeill/ruminator/actions/workflows/tests.yml)

A small, local arXiv browser to help you find something worth reading—not another backlog to manage. A small ASCII cow keeps you company while you ruminate.

ruminator brings together the latest postings, your research interests, and a little serendipity. You choose when to refresh, what to read, and whether to use AI summaries. It runs on your computer; no account or API key is needed for ordinary browsing.

## Getting started

You need **Node.js 24 or newer**. In your local copy of this repository:

1. Install the dependencies:
   ```sh
   npm install
   ```
2. Edit **[interests.md](interests.md)** to describe your interests. The six included profiles are examples; replace their names, Subjects, and optional Keywords with your own.
3. Fetch the latest `quant-ph` postings and open the local reading service:
   ```sh
   npm start
   ```
4. Open **http://127.0.0.1:3000** in your browser. Stop the service with **Ctrl-C**.

The first run downloads a local embedding model and may take a little longer. Later runs reuse it. Ordinary ranking runs locally and makes no paid API calls.

For other arXiv categories, use `npm start -- --categories quant-ph,cs.ET`.

## Reading and returning

- **Selected:** four papers close to your interests.
- **Adjacent:** one paper exploring a nearby topic.
- **Wildcard:** one chance discovery.
- **Other postings:** every remaining paper, with expandable abstracts and links.

Open an abstract, follow a PDF/arXiv link, or use **+ / −** to say “more / less relevant to me.” Click a selected vote again to clear it. Votes guide future listings; they do not judge scientific quality or reorder the page you are reading. Scores are experimental relevance measures, not probabilities.

There is **one current listing**, not a history or unread queue. Save papers you want to keep in your own bibliography or notebook. A new listing replaces the old one only when it is ready; refresh your browser to see it. The latest arXiv announcement can be a few days old around weekends and holidays.

On later visits:

```sh
npm run serve     # Read the saved listing, without fetching or running models
npm run generate  # Check for a new batch and prepare it, then exit
```

You can leave the reading service running while generating. Repeated generation of the same batch leaves your listing unchanged. If generation is interrupted, run it again to resume. Nothing runs on a schedule.

See **[commands.md](commands.md)** for offline use, deliberate rebuilding, summaries, and all command options.

## Make it yours

**[interests.md](interests.md)** holds your research profiles:

```markdown
## My research area {#my-research-area}

### Subjects
- Questions and topics I want to follow

### Keywords
- a specific phrase; an alternative name
```

Names and Subjects describe semantic interests. Keywords are optional explicit phrases; semicolons group alternative names. Keep each `{#id}` unique and stable when renaming or moving a profile. Positive/negative example sections are placeholders, not ranking inputs.

**[config.toml](config.toml)** controls ranking weights and optional summary settings. Changes to interests and ranking settings affect future listings, not an already-published one. To try changes on the current batch, see [rebuilding a listing](commands.md#rebuild-the-current-batch).

## Optional AI summaries

Summaries are off by default. Enabling them sends featured papers' available arXiv HTML text through Cloudflare AI Gateway and **may incur charges**. They supplement abstracts and papers, not replace reading them; summaries can be wrong and some papers have no usable HTML.

See [summary setup and commands](commands.md#optional-ai-summaries) for credentials, token estimates, and explicit request controls. No model calls happen while browsing.

## Hosted version preview

Invite-only hosted reading is in development. Run `npm run dev:hosted` to try the public/private pages with local example accounts—no Cloudflare setup, email, or model calls. This preview is separate from your normal local data. See [the hosted guide](hosted.md) for what works and what remains before deployment.

## Local data and development

Working data lives in `data/`: feed/text caches, the current listing and votes, and downloaded model assets. This is not an archive. Votes expire during generation after 365 days without an explicit change. Keep data you value before deleting databases; see [storage and resets](commands.md#storage-and-resets).

For development, run `npm test` and `npm run typecheck`. Tests use local fixtures and make no external API or model calls. The [development plan](.agents/PLAN.md) records architecture and implementation decisions; [commands.md](commands.md#development-checks) covers optional model checks.
