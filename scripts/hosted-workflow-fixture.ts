// Copyright 2026 Guilhem Ribeill
// SPDX-License-Identifier: Apache-2.0

// LOCAL TEST ENTRY ONLY. Recorded feeds and synthetic inference; no live transport.
import app from '../src/hosted/worker.ts';
import { createHostedApp, type HostedEnv } from '../src/hosted/app.ts';
import { HostedGenerationWorkflow } from '../src/hosted/generation-workflow.ts';
import type { GenerationAdapterContext } from '../src/hosted/ranking-runner.ts';
import type { Paper } from '../src/arxiv.ts';
import type { SummaryConfig } from '../src/summary-content.ts';
import type { GenerationReference } from '../src/hosted/daily-runs.ts';
import { embeddingHash } from '../src/hosted/embedding-requests.ts';
import { extractArxivHtml } from '../src/html-extraction.ts';
import { HTML_EXTRACTOR } from '../src/fulltext-types.ts';
import { runScheduledPass } from '../src/hosted/scheduled.ts';
import type { ScheduledController } from '@cloudflare/workers-types';

export class FixtureGenerationWorkflow extends HostedGenerationWorkflow<HostedEnv & { FIXTURE_HTML: string }> {
  protected adapters(inputs: GenerationAdapterContext) {
    if (Object.keys(inputs).sort().join(',') !== 'id,summariesRequested,userId') throw new Error('Adapter received a full snapshot');
    const record = async (kind: string, input: unknown) => {
      await this.env.DB.prepare(`INSERT INTO fixture_calls (generation_id, kind, request_key, calls) VALUES (?, ?, ?, 1)
        ON CONFLICT (generation_id, kind, request_key) DO UPDATE SET calls = calls + 1`)
        .bind(inputs.id, kind, await embeddingHash(input)).run();
    };
    return {
      embedding: async (texts: readonly string[]) => {
        await record('embedding', texts);
        return { shape: [texts.length, 384], pooling: 'cls', data: texts.map(() => [1, ...Array(383).fill(0)]) };
      },
      summaries: inputs.summariesRequested ? {
        loadSource: async (paper: Paper) => ({ html: this.env.FIXTURE_HTML,
          result: { paperId: paper.id, version: paper.version, status: 'available' as const, extractor: HTML_EXTRACTOR,
            sourceUrl: `https://arxiv.org/html/${paper.id}v${paper.version}`, checkedAt: '2030-01-01T00:00:00Z',
            text: extractArxivHtml(this.env.FIXTURE_HTML) } }),
        createProvider: (config: SummaryConfig) => ({ summarize: async (messages: readonly { role: string; content: string }[]) => {
          await record('summary', messages);
          return { summary: `Recorded experiments measured the quantum device response. Analysis resolved the correlation signal in fixture run ${inputs.id}.`,
            model: config.llm.model, usage: { inputTokens: 42, outputTokens: 20 } };
        } }),
      } : undefined,
    };
  }
  protected async execute(ref: GenerationReference) {
    await this.env.DB.prepare(`INSERT INTO fixture_calls (generation_id, kind, request_key, calls) VALUES (?, 'step', 'step', 1)
      ON CONFLICT (generation_id, kind, request_key) DO UPDATE SET calls = calls + 1`).bind(ref.generationId).run();
    const result = await super.execute(ref);
    // Real effects/SQL have finished, but the Workflow step result is lost once.
    const fault = await this.env.DB.prepare("UPDATE fixture_faults SET consumed = 1 WHERE generation_id = ? AND consumed = 0 AND (after_publish = 0 OR ? = 'published')")
      .bind(ref.generationId, result).run();
    if (fault.meta.changes) throw new Error('Fixture lost step acknowledgement');
    return result;
  }
}
function feedTransport(env: HostedEnv): typeof fetch {
  return async input => {
    const category = decodeURIComponent(new URL(String(input)).pathname.split('/').at(-1)!);
    const row = await env.DB.prepare('UPDATE fixture_feeds SET calls = calls + 1 WHERE category = ? RETURNING xml, status')
      .bind(category).first<{ xml: string; status: number }>();
    if (!row) throw new Error('Unrecorded fixture feed');
    return new Response(row.xml, { status: row.status });
  };
}
let fixtureApp: ReturnType<typeof createHostedApp> | undefined;
export default {
  ...app,
  async fetch(request: Request, env: HostedEnv) {
    fixtureApp ??= createHostedApp(env, feedTransport(env));
    return fixtureApp(request);
  },
  // Only test code installs this handler. Feed responses and time are recorded
  // fixtures, and the Workflow class above cannot make live model calls.
  async scheduled(event: ScheduledController, env: HostedEnv) {
    if (!env.GENERATION) throw new Error('Missing fixture Workflow');
    await runScheduledPass(env.DB, env.GENERATION, event.scheduledTime, feedTransport(env), () => new Date(event.scheduledTime));
  },
};
