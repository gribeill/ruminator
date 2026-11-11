// Copyright 2026 Guilhem Ribeill
// SPDX-License-Identifier: Apache-2.0

import { createHostedApp, type HostedEnv } from './app.ts';

let app: ReturnType<typeof createHostedApp> | undefined;
export default {
  async fetch(request: Request, env: HostedEnv): Promise<Response> {
    try {
      app ??= createHostedApp(env);
      return await app(request);
    } catch {
      return new Response('Hosted application is not configured', { status: 500, headers: { 'Cache-Control': 'private, no-store' } });
    }
  },
};
