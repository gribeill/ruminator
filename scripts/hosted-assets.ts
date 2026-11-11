// Copyright 2026 Guilhem Ribeill
// SPDX-License-Identifier: Apache-2.0

import { cpSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Copy only local KaTeX CSS/fonts, never the repository, credentials, or model cache. */
export function prepareHostedAssets(): void {
  const dist = fileURLToPath(new URL('.', import.meta.resolve('katex')));
  const target = resolve('.wrangler/hosted-assets/assets/katex');
  mkdirSync(target, { recursive: true });
  cpSync(join(dist, 'katex.min.css'), join(target, 'katex.min.css'));
  cpSync(join(dist, 'fonts'), join(target, 'fonts'), { recursive: true });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) prepareHostedAssets();
