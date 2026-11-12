// Copyright 2026 Guilhem Ribeill
// SPDX-License-Identifier: Apache-2.0

import type { HostedEnv } from './app.ts';
import { HostedGenerationWorkflow } from './generation-workflow.ts';
import type { GenerationAdapterContext } from './ranking-runner.ts';
import type { GenerationReference } from './daily-runs.ts';
import { productionAdapters } from './execution.ts';
import { requireExecution } from './activation.ts';

/** Exported for later deployment wiring, but neither manifest binds this class.
 * The shared Workflow continues to own journals, claims and lifecycle handling.
 */
export class GenerationWorkflow extends HostedGenerationWorkflow<HostedEnv> {
  protected transport(): typeof fetch { return fetch; }

  protected adapters(context: GenerationAdapterContext) {
    return productionAdapters(this.env, context, this.transport());
  }

  protected async execute(ref: GenerationReference) {
    // Check on every continuation, including ready/cache-only publication paths.
    requireExecution(this.env);
    return super.execute(ref);
  }
}
