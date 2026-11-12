// Copyright 2026 Guilhem Ribeill
// SPDX-License-Identifier: Apache-2.0

import { createHostedApp, type HostedEnv } from './app.ts';
import type { ScheduledController } from '@cloudflare/workers-types';
import { scheduledExecution } from './execution.ts';
import { uiText } from '../ui-text.ts';
export { GenerationWorkflow } from './production-workflow.ts';

let app: ReturnType<typeof createHostedApp> | undefined;
export default {
  async scheduled(event: ScheduledController, env: HostedEnv): Promise<void> {
    await scheduledExecution(env, event.scheduledTime, fetch);
  },
  async fetch(request: Request, env: HostedEnv): Promise<Response> {
    try {
      app ??= createHostedApp(env);
      return await app(request);
    } catch {
      return new Response(uiText('errors.hosted_configuration'), { status: 500, headers: { 'Cache-Control': 'private, no-store' } });
    }
  },
};
