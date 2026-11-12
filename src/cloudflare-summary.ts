/**
 * Copyright 2026 Guilhem Ribeill
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { SummaryError, type SummaryConfig, type SummaryProvider, type SummaryUsage } from './summary-content.ts';
import { readResponseText, ResponseTooLargeError } from './http-body.ts';

export const MAX_SUMMARY_RESPONSE_BYTES = 1024 * 1024;
export const SUMMARY_REQUEST_TIMEOUT_MS = 120_000;

export interface CloudflareCredentials {
  accountId?: string;
  apiToken?: string;
  gatewayId?: string;
}

/** One HTTP attempt, no SDK retries or model fallback. Credentials never enter saved results. */
export function createCloudflareSummaryProvider(config: SummaryConfig, {
  credentials,
  fetcher = fetch,
  verbose = false,
  log = console.log,
}: {
  credentials: CloudflareCredentials;
  fetcher?: typeof fetch;
  verbose?: boolean;
  log?: (message: string) => void;
}): SummaryProvider {
  const { accountId, apiToken, gatewayId } = credentials;
  if (!accountId || !apiToken || !gatewayId) {
    throw new SummaryError('api_unavailable', 'Missing Cloudflare account, token, or gateway configuration');
  }
  if (config.llm.provider !== 'cloudflare') throw new Error('Unsupported summary provider');
  return {
    async summarize(messages, maxCompletionTokens) {
      let response: Response;
      try {
        response = await fetcher(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/v1/chat/completions`, {
          // Workers does not support redirect:'error'. Reject returned 3xx below,
          // without forwarding credentials/body or attempting a second request.
          method: 'POST', redirect: 'manual',
          headers: {
            Authorization: `Bearer ${apiToken}`,
            'cf-aig-gateway-id': gatewayId,
            'cf-aig-max-attempts': '1',
            // Application caches own reuse; forced regeneration must not hit a
            // second response cache at the Gateway. Verify deployed policy too.
            'cf-aig-skip-cache': 'true',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ model: config.llm.model, messages, max_completion_tokens: maxCompletionTokens }),
          signal: AbortSignal.timeout(SUMMARY_REQUEST_TIMEOUT_MS),
        });
      } catch {
        throw new SummaryError('api_unavailable', 'Cloudflare request failed or timed out');
      }
      let raw: string;
      try { raw = await readResponseText(response, MAX_SUMMARY_RESPONSE_BYTES); }
      catch (error) {
        if (error instanceof ResponseTooLargeError) throw new SummaryError('summarization_error', 'Cloudflare response exceeds the 1 MiB size limit');
        throw new SummaryError('api_unavailable', 'Cloudflare response could not be read');
      }
      if (verbose) {
        const paper = messages.find(m => m.role === 'user')?.content.split('\n', 1)[0] ?? 'paper';
        // Full response only, never request headers or environment. Redact credentials
        // defensively even if an upstream error unexpectedly echoes them.
        let safe = raw;
        for (const secret of [apiToken, accountId, gatewayId]) safe = safe.replaceAll(secret, '[REDACTED]');
        log(`Model response for ${paper} (HTTP ${response.status}):\n${safe}`);
      }
      if (!response.ok) {
        const unavailable = [401, 402, 403, 404, 408, 429].includes(response.status) || response.status >= 500;
        throw new SummaryError(unavailable ? 'api_unavailable' : 'summarization_error', `Cloudflare returned HTTP ${response.status}`);
      }
      let data;
      try { data = JSON.parse(raw); }
      catch { throw new SummaryError('summarization_error', 'Cloudflare returned invalid JSON'); }
      const usage: SummaryUsage | undefined = data.usage && Number.isSafeInteger(data.usage.prompt_tokens) && data.usage.prompt_tokens >= 0
        && Number.isSafeInteger(data.usage.completion_tokens) && data.usage.completion_tokens >= 0 ? {
          inputTokens: data.usage.prompt_tokens,
          outputTokens: data.usage.completion_tokens,
          ...(Number.isSafeInteger(data.usage.completion_tokens_details?.reasoning_tokens)
            ? { reasoningTokens: data.usage.completion_tokens_details.reasoning_tokens } : {}),
        } : undefined;
      const choice = data.choices?.[0];
      if (choice?.finish_reason === 'length') throw new SummaryError('token_budget', 'Completion token allowance exhausted', usage);
      if (choice?.finish_reason !== 'stop' || choice.message?.refusal || typeof choice.message?.content !== 'string') {
        throw new SummaryError('summarization_error', 'Model returned a refusal, invalid output, or incomplete response', usage);
      }
      return { summary: choice.message.content, model: typeof data.model === 'string' ? data.model : undefined, usage };
    },
  };
}
