// Copyright 2026 Guilhem Ribeill
// SPDX-License-Identifier: Apache-2.0

// Standalone Node convenience wrapper. Hosted callers use the neutral adapter
// with explicitly supplied secret bindings, never process.env or verbose logs.
import { createCloudflareSummaryProvider as explicitProvider } from './cloudflare-summary.ts';
import type { SummaryConfig, SummaryProvider } from './summary-content.ts';
export { MAX_SUMMARY_RESPONSE_BYTES } from './cloudflare-summary.ts';

export function createCloudflareSummaryProvider(config: SummaryConfig,
  options: Partial<Parameters<typeof explicitProvider>[1]> = {}): SummaryProvider {
  return explicitProvider(config, { ...options, credentials: options.credentials ?? {
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    apiToken: process.env.CLOUDFLARE_API_TOKEN,
    gatewayId: process.env.CLOUDFLARE_GATEWAY_ID,
  } });
}
