// Copyright 2026 Guilhem Ribeill
// SPDX-License-Identifier: Apache-2.0

import { cpSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Copy only local KaTeX CSS/fonts, never the repository, credentials, or model cache. */
export function prepareHostedAssets(): void {
  const dist = fileURLToPath(new URL('.', import.meta.resolve('katex')));
  const target = resolve('.wrangler/hosted-assets/assets/katex');
  mkdirSync(join(target, 'fonts'), { recursive: true });
  // Test files start fixtures concurrently. Stage outside the served tree and
  // atomically replace files, avoiding cp's competing unlink/overwrite operations.
  const staging = mkdtempSync(resolve('.wrangler/asset-stage-'));
  try {
    cpSync(join(dist, 'katex.min.css'), join(staging, 'katex.min.css'));
    cpSync(join(dist, 'fonts'), join(staging, 'fonts'), { recursive: true });
    for (const file of ['katex.min.css', ...readdirSync(join(staging, 'fonts')).map(name => `fonts/${name}`)]) {
      renameSync(join(staging, file), join(target, file));
    }
  } finally { rmSync(staging, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) prepareHostedAssets();
