import type { SummaryConfig, SummaryProvider, SummaryUsage } from './summaries.ts';
import { SummaryError } from './summaries.ts';

interface CloudflareCredentials {
  accountId?: string;
  apiToken?: string;
  gatewayId?: string;
}

/** One HTTP attempt, no SDK retries or model fallback. Credentials never enter saved results. */
export function createCloudflareSummaryProvider(config: SummaryConfig, {
  credentials = {
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    apiToken: process.env.CLOUDFLARE_API_TOKEN,
    gatewayId: process.env.CLOUDFLARE_GATEWAY_ID,
  },
  fetcher = fetch,
  verbose = false,
  log = console.log,
}: {
  credentials?: CloudflareCredentials;
  fetcher?: typeof fetch;
  verbose?: boolean;
  log?: (message: string) => void;
} = {}): SummaryProvider {
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
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiToken}`,
            'cf-aig-gateway-id': gatewayId,
            'cf-aig-max-attempts': '1',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ model: config.llm.model, messages, max_completion_tokens: maxCompletionTokens }),
          signal: AbortSignal.timeout(120_000),
        });
      } catch {
        throw new SummaryError('api_unavailable', 'Cloudflare request failed or timed out');
      }
      let raw: string;
      try { raw = await response.text(); }
      catch { throw new SummaryError('api_unavailable', 'Cloudflare response could not be read'); }
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
