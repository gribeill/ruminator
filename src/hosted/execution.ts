// Copyright 2026 Guilhem Ribeill
// SPDX-License-Identifier: Apache-2.0

import type { HostedEnv } from './app.ts';
import type { GenerationAdapterContext, GenerationAdapters } from './ranking-runner.ts';
import { requireExecution, executionEnabled } from './activation.ts';
import { workersAiEmbeddings } from './bge.ts';
import { createCloudflareSummaryProvider } from '../cloudflare-summary.ts';
import { loadHostedSource } from './html-source.ts';
import { readSourceHtml } from './source-store.ts';
import { runScheduledPass } from './scheduled.ts';

/** Construction does not call a provider. The runner owns durable admission,
 * per-user budgets and fresh SQL fences; this layer only supplies transports.
 * Injection is internal/test-only, never configurable URLs in saved documents.
 */
export function productionAdapters(env: HostedEnv, context: GenerationAdapterContext,
  fetcher: typeof fetch): GenerationAdapters {
  requireExecution(env);
  const guarded: typeof fetch = (input, init) => { requireExecution(env); return fetcher(input, init); };
  return {
    embedding: workersAiEmbeddings(env.CLOUDFLARE_ACCOUNT_ID!, env.CLOUDFLARE_API_TOKEN!, guarded),
    summaries: context.summariesRequested ? {
      retryUnavailableSource: true,
      loadSource: async paper => {
        requireExecution(env);
        const raw = await readSourceHtml(env.DB, context.userId, context.id, paper);
        return loadHostedSource(paper, guarded, raw?.html);
      },
      createProvider: config => {
        requireExecution(env);
        return createCloudflareSummaryProvider(config, { credentials: {
          accountId: env.CLOUDFLARE_ACCOUNT_ID, apiToken: env.CLOUDFLARE_API_TOKEN, gatewayId: env.CLOUDFLARE_GATEWAY_ID,
        }, fetcher: guarded });
      },
    } : undefined,
  };
}

/** Separate standing schedule authorization from manually confirmed execution.
 * Off means no SQL, feeds or generation; a binding alone cannot activate work.
 */
export async function scheduledExecution(env: HostedEnv, scheduledTime: number, fetcher: typeof fetch,
  clock?: () => Date) {
  if (!executionEnabled(env) || env.HOSTED_SCHEDULE_ENABLED !== 'true' || !env.GENERATION) return { status: 'disabled' as const };
  requireExecution(env);
  return runScheduledPass(env.DB, env.GENERATION, scheduledTime, (input, init) => {
    requireExecution(env);
    if (env.HOSTED_SCHEDULE_ENABLED !== 'true') throw new Error('Hosted schedule is disabled');
    return fetcher(input, init);
  }, clock);
}
