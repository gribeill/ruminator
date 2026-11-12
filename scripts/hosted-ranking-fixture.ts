// Copyright 2026 Guilhem Ribeill
// SPDX-License-Identifier: Apache-2.0

// Local test Worker ONLY. Never a production entry point or provider adapter.
import app from '../src/hosted/worker.ts';
import type { HostedEnv } from '../src/hosted/app.ts';
import { runHostedRanking } from '../src/hosted/ranking-runner.ts';
import { embeddingChunks, embeddingTokenCount } from '../src/hosted/bge.ts';
let calls = 0;
export default {
  async fetch(request: Request, env: HostedEnv): Promise<Response> {
    if (new URL(request.url).pathname !== '/__fixture/rank') return app.fetch(request, env);
    const { userId, generationId, maxRequests = 8, fail = false } = await request.json() as {
      userId: string; generationId: string; maxRequests?: number; fail?: boolean;
    };
    const before = calls;
    const status = await runHostedRanking(env.DB, userId, generationId, async texts => {
      calls++;
      if (fail) throw new Error('Recorded provider failure');
      if (texts.some(t => embeddingTokenCount(t) > 512)) throw new Error('Fixture token overflow');
      return { shape: [texts.length, 384], pooling: 'cls', data: texts.map(() => [2, ...Array(383).fill(0)]) };
    }, maxRequests);
    return Response.json({ status, calls: calls - before,
      tokenizerCheck: embeddingChunks({ kind: 'paper', title: 'Quantum science', text: 'experiment '.repeat(600) }).map(embeddingTokenCount) });
  },
};
