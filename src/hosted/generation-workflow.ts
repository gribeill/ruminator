// Copyright 2026 Guilhem Ribeill
// SPDX-License-Identifier: Apache-2.0

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import type { D1Database } from '@cloudflare/workers-types';
import { prepareDailyRunStep, failDailyRun, type GenerationReference } from './daily-runs.ts';
import { runHostedGeneration, type RankingRunResult, type GenerationAdapterContext, type GenerationAdapters } from './ranking-runner.ts';

import { WORKFLOW_EMBEDDING_REQUESTS, WORKFLOW_SUMMARY_REQUESTS, WORKFLOW_STEP_MINUTES } from './workflow-limits.ts';

// A daily reader can tolerate minutes of waiting or a failed run. No leases,
// takeover, watchdog, or automatic new-generation recovery is needed.
export const SHARED_WAIT_RETRIES = 3;
export const MAX_GENERATION_STEPS = 256;

/** A concrete entry supplies explicitly authorized adapters. Production wiring
 * remains disabled by default; local tests supply fixture transports only.
 */
export abstract class HostedGenerationWorkflow<Env extends { DB: D1Database }>
  extends WorkflowEntrypoint<Env, GenerationReference> {
  protected abstract adapters(context: GenerationAdapterContext): GenerationAdapters;

  protected async execute(ref: GenerationReference): Promise<RankingRunResult> {
    return runHostedGeneration(this.env.DB, ref.userId, ref.generationId, inputs => {
      const adapters = this.adapters(inputs);
      return { embedding: adapters.embedding,
        summaries: adapters.summaries ? { ...adapters.summaries, maxRequests: WORKFLOW_SUMMARY_REQUESTS } : undefined };
    }, WORKFLOW_EMBEDDING_REQUESTS);
  }

  async run(event: WorkflowEvent<GenerationReference>, step: WorkflowStep): Promise<RankingRunResult> {
    const ref = event.payload;
    if (event.instanceId !== ref.generationId || typeof ref.userId !== 'string' || !ref.userId) {
      throw new Error('Invalid generation Workflow reference');
    }
    const fail = (reason: 'run' | 'waiting') => step.do('record-failure', {
      retries: { limit: 2, delay: '1 second', backoff: 'constant' }, timeout: '1 minute',
    }, async () => {
      await failDailyRun(this.env.DB, ref, reason);
      return 'failed' as const;
    });
    let waits = 0;
    try {
      for (let index = 0; index < MAX_GENERATION_STEPS; index++) {
        const result = await step.do(`generation-${index}`, {
          retries: { limit: 2, delay: '1 second', backoff: 'constant' }, timeout: `${WORKFLOW_STEP_MINUTES} minutes`,
        }, async () => {
          // Never journal a reusable "permission to dispatch". These checks,
          // and the runner's durable claims, are inside the retried callback.
          if (!await prepareDailyRunStep(this.env.DB, ref)) {
            const completed = await this.env.DB.prepare("SELECT 1 FROM generation_inputs WHERE id = ? AND user_id = ? AND state = 'published'")
              .bind(ref.generationId, ref.userId).first();
            return completed ? 'published' as const : 'stale' as const;
          }
          const result = await this.execute(ref);
          if (result === 'stale' && await prepareDailyRunStep(this.env.DB, ref)) await failDailyRun(this.env.DB, ref, 'run');
          return result;
        });
        if (result === 'published' || result === 'stale') return result;
        // Usually already closed by the runner. The trusted daily path also
        // closes an account disabled during execution (ordinary failure cannot).
        if (result === 'failed') return await fail('run');
        if (result === 'waiting') {
          if (waits++ >= SHARED_WAIT_RETRIES) {
            return await fail('waiting');
          }
          await step.sleep(`shared-wait-${waits}`, '5 minutes');
        }
      }
      return await fail('run');
    } catch {
      // A storage outage can also prevent recording failure. Leave the admitted
      // run for explicit intervention/the next boundary, never re-admit it.
      return await fail('run');
    }
  }
}
