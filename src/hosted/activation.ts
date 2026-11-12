// Copyright 2026 Guilhem Ribeill
// SPDX-License-Identifier: Apache-2.0

/** Deployment settings/secrets only, never saved TOML or request parameters. */
export interface ExecutionSettings {
  HOSTED_EXECUTION_ENABLED?: string;
  HOSTED_SCHEDULE_ENABLED?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_GATEWAY_ID?: string;
}

export function executionEnabled(settings: ExecutionSettings): boolean {
  return settings.HOSTED_EXECUTION_ENABLED === 'true';
}

/** Fail before admission/claims, including summary credentials before embeddings.
 * This validates configuration presence/shape, not external permissions or retry policy.
 */
export function requireExecution(settings: ExecutionSettings): void {
  if (!executionEnabled(settings)) throw new Error('Hosted execution is disabled');
  if (!/^[a-f0-9]{32}$/i.test(settings.CLOUDFLARE_ACCOUNT_ID ?? '') ||
      !settings.CLOUDFLARE_API_TOKEN?.trim() || /[\r\n]/.test(settings.CLOUDFLARE_API_TOKEN) ||
      !/^[a-zA-Z0-9_-]{1,64}$/.test(settings.CLOUDFLARE_GATEWAY_ID ?? '')) {
    throw new Error('Hosted execution credentials are missing or invalid');
  }
}
