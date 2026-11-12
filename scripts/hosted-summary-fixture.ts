// Copyright 2026 Guilhem Ribeill
// SPDX-License-Identifier: Apache-2.0

// LOCAL TEST WORKER ONLY. All inference responses and source HTML are fixtures.
import app from '../src/hosted/worker.ts';
import type { HostedEnv } from '../src/hosted/app.ts';
import { runHostedGeneration } from '../src/hosted/ranking-runner.ts';
import { createCloudflareSummaryProvider } from '../src/cloudflare-summary.ts';
import { extractArxivHtml } from '../src/html-extraction.ts';
import { HTML_EXTRACTOR } from '../src/fulltext-types.ts';

export default {
  async fetch(request: Request, env: HostedEnv): Promise<Response> {
    if (new URL(request.url).pathname !== '/__fixture/summaries') return app.fetch(request, env);
    const { userId, generationId, html, extractor = HTML_EXTRACTOR, maxRequests = 1, invalid = false } = await request.json() as {
      userId: string; generationId: string; html: string; extractor?: string; maxRequests?: number; invalid?: boolean;
    };
    let embeddings = 0, summaries = 0, sources = 0;
    const models: string[] = [];
    const status = await runHostedGeneration(env.DB, userId, generationId, { embedding: async texts => {
      embeddings++;
      return { shape: [texts.length, 384], pooling: 'cls', data: texts.map(() => [1, ...Array(383).fill(0)]) };
    }, summaries: {
      extractor, maxRequests,
      async loadSource(paper) {
        sources++;
        const text = extractArxivHtml(html);
        const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), b => b.toString(16).padStart(2, '0')).join('');
        return { html, result: { paperId: paper.id, version: paper.version, status: 'available',
          sourceUrl: `https://arxiv.org/html/${paper.id}v${paper.version}`, checkedAt: '2030-01-01T00:00:00Z',
          extractor, text, contentHash: hash } };
      },
      createProvider: config => createCloudflareSummaryProvider(config, {
        credentials: { accountId: 'fixture-account', gatewayId: 'fixture-gateway', apiToken: 'fixture-token' },
        async fetcher(_url, init) {
          summaries++;
          if (init?.redirect !== 'error' || new Headers(init.headers).get('cf-aig-max-attempts') !== '1') throw new Error('Unsafe fixture transport');
          const body = JSON.parse(String(init.body)); models.push(body.model);
          return Response.json({ model: body.model, usage: { prompt_tokens: 42, completion_tokens: 20 },
            choices: [{ finish_reason: 'stop', message: { content: invalid ? '界'.repeat(3000) :
              'Recorded experiments measured the coherent response of coupled quantum devices. The analysis resolved the reported correlation signal without invoking a live model.' } }] });
        },
      }),
    } }, 16);
    return Response.json({ status, embeddings, summaries, sources, models });
  },
};
