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

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encode, decode } from 'gpt-tokenizer/encoding/o200k_base';
import { loadConfig } from '../src/config.ts';
import { estimatePromptTokens } from '../src/tokenizer.ts';

const config = loadConfig().tokenizer;

test('local tokenizer counts known text, instructions, framing, and configured headroom', () => {
  const messages = [{ role: 'system' as const, content: 'Summarize faithfully.' }, { role: 'user' as const, content: 'Hello, world!' }];
  assert.equal(encode(messages[1].content).length, 4);
  const estimate = estimatePromptTokens(messages, config);
  const raw = messages.reduce((sum, m) => sum + encode(m.content).length, 0);
  assert.equal(estimate.textTokens, raw);
  assert.equal(estimate.estimatedInputTokens, Math.ceil(raw * 1.2) + 2 * 32 + 64);
  assert.equal(estimate.encoding, 'o200k_base');
  assert.equal(estimate.approximate, true);
  assert.equal(estimatePromptTokens([], config).estimatedInputTokens, 64);
  const exactTextOnly = { ...config, safety_multiplier: 1, message_overhead: 0, request_overhead: 0 };
  assert.equal(estimatePromptTokens(messages, exactTextOnly).estimatedInputTokens, raw);
});

test('scientific text, Unicode, and control-like literals are counted fully as data', () => {
  const text = String.raw`Results: $\alpha = 0.99 \pm 0.01$. 超伝導 qubits 🐄. <|endoftext|>`;
  const fullText = text.repeat(1000);
  const ids = encode(fullText, { disallowedSpecial: new Set() });
  assert.equal(decode(ids), fullText);
  const result = estimatePromptTokens([{ role: 'user', content: fullText }], config);
  assert.equal(result.textTokens, ids.length);
  assert.ok(result.estimatedInputTokens > result.textTokens);
  assert.ok(result.textTokens > 512); // No embedding-style context truncation.
  assert.throws(() => estimatePromptTokens([], { ...config, safety_multiplier: NaN }), /multiplier/);
});
