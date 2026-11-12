// Copyright 2026 Guilhem Ribeill
// SPDX-License-Identifier: Apache-2.0

// TEST ONLY: real production composition, with transport replaced by recorded
// responses. There is deliberately no fallback to global fetch.
import app from '../src/hosted/worker.ts';
import { GenerationWorkflow } from '../src/hosted/production-workflow.ts';
import { scheduledExecution } from '../src/hosted/execution.ts';
import type { HostedEnv } from '../src/hosted/app.ts';
import type { GenerationReference } from '../src/hosted/daily-runs.ts';
import type { ScheduledController } from '@cloudflare/workers-types';
import { embeddingHash } from '../src/hosted/embedding-requests.ts';

type Env = HostedEnv & { FIXTURE_HTML: string };
function transport(env: Env): typeof fetch {
  return async (input, init) => {
    // Validate with the actual workerd Request constructor before returning a
    // recording: plain fetch stubs otherwise hide unsupported request options.
    const request = new Request(input, init);
    const url = new URL(request.url), headers = request.headers;
    if (request.redirect !== 'manual' || !init?.signal) throw new Error('Missing transport bounds');
    const kind = url.hostname === 'rss.arxiv.org' ? 'feed' : url.hostname === 'arxiv.org' ? 'html'
      : url.hostname === 'api.cloudflare.com' && url.pathname.endsWith('/chat/completions') ? 'summary'
      : url.hostname === 'api.cloudflare.com' && url.pathname.includes('/ai/run/') ? 'embedding' : undefined;
    if (!kind) throw new Error('Unrecorded transport');
    const key = await embeddingHash([url.href, init?.body ?? '']);
    await env.DB.prepare(`INSERT INTO fixture_transport (kind, key, calls) VALUES (?,?,1)
      ON CONFLICT (kind,key) DO UPDATE SET calls = calls + 1`).bind(kind, key).run();
    if (kind === 'feed') {
      const row = await env.DB.prepare("SELECT value FROM fixture_settings WHERE key = 'rss'").first<{ value: string }>();
      return new Response(row!.value);
    }
    if (kind === 'html') {
      if (headers.has('Authorization') || !/^\/html\/\d{4}\.\d{4,5}v\d+$/.test(url.pathname)) throw new Error('Unsafe HTML request');
      return new Response(env.FIXTURE_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
    if (headers.get('Authorization') !== 'Bearer fixture-only-token' || init?.method !== 'POST') throw new Error('Wrong provider credentials');
    const body = JSON.parse(String(init.body));
    if (kind === 'embedding') {
      if (body.pooling !== 'cls' || !Array.isArray(body.text)) throw new Error('Wrong embedding payload');
      return Response.json({ success: true, result: { shape: [body.text.length, 384], pooling: 'cls',
        data: body.text.map(() => [1, ...Array(383).fill(0)]) } });
    }
    if (headers.get('cf-aig-max-attempts') !== '1' || headers.get('cf-aig-skip-cache') !== 'true' || headers.get('cf-aig-gateway-id') !== 'fixture-only' ||
        body.model !== 'openai/gpt-6-luna' || !body.max_completion_tokens || body.messages.length !== 2) throw new Error('Wrong summary payload');
    return Response.json({ model: 'fixture/actual-model', usage: { prompt_tokens: 42, completion_tokens: 20 },
      choices: [{ finish_reason: 'stop', message: { content: 'Recorded experiments measured the device response. Analysis resolved the correlation signal.' } }] });
  };
}

export class FixtureProductionWorkflow extends GenerationWorkflow {
  protected transport(): typeof fetch { return transport(this.env as Env); }
  protected async execute(ref: GenerationReference) {
    if (await this.env.DB.prepare("SELECT 1 FROM fixture_settings WHERE key = 'disable' AND value = '1'").first()) {
      this.env.HOSTED_EXECUTION_ENABLED = 'false'; // Simulate disablement before a continuation.
    }
    const result = await super.execute(ref);
    const fault = await this.env.DB.prepare(`UPDATE fixture_settings SET value = '0' WHERE key = 'lose_ack' AND value = '1'
      AND EXISTS (SELECT 1 FROM summary_outcomes WHERE generation_id = ? AND state = 'complete' AND charged_input > 0)`)
      .bind(ref.generationId).run();
    if (fault.meta.changes) throw new Error('Fixture lost acknowledgement after real adapter result');
    return result;
  }
}
export default {
  ...app,
  async scheduled(event: ScheduledController, env: Env) {
    await scheduledExecution({ ...env, HOSTED_SCHEDULE_ENABLED: 'true' }, event.scheduledTime, transport(env), () => new Date(event.scheduledTime));
  },
};
