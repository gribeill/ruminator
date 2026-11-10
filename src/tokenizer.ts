import { countTokens } from 'gpt-tokenizer/encoding/o200k_base';
import { validateTokenizer, type TokenizerConfig } from './config.ts';

export interface TextMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Count all text without truncation; framing/headroom are estimates, not model guarantees.
 * Callers must supply the complete prompt, including instructions and paper text.
 * Output/reasoning reservations and run-budget enforcement belong to the summary request loop.
 */
export function estimatePromptTokens(messages: readonly TextMessage[], config: TokenizerConfig): {
  textTokens: number;
  estimatedInputTokens: number;
  encoding: 'o200k_base';
  approximate: true;
} {
  validateTokenizer(config);
  // Source text resembling special tokens is ordinary data, never chat control syntax.
  const textTokens = messages.reduce((sum, message) => sum + countTokens(message.content, { disallowedSpecial: new Set() }), 0);
  const estimatedInputTokens = Math.ceil(textTokens * config.safety_multiplier)
    + messages.length * config.message_overhead + config.request_overhead;
  if (!Number.isSafeInteger(estimatedInputTokens)) throw new Error('Token estimate exceeds safe integer range');
  return { textTokens, estimatedInputTokens, encoding: config.encoding, approximate: true };
}
