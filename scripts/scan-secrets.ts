// Copyright 2026 Guilhem Ribeill
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// Scan the current Git-visible files, not history or ignored local credentials/data.
// A tracked .env is still scanned, even if it also matches .gitignore.
const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
  { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
const snapshot = mkdtempSync(join(tmpdir(), 'ruminator-secrets-'));
try {
  for (const file of new Set(files)) {
    const source = join(root, file), target = join(snapshot, file);
    let info;
    try { info = lstatSync(source); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; // Deleted working-tree file.
      throw error;
    }
    if (!info.isFile() && !info.isSymbolicLink()) continue; // Do not traverse submodules.
    mkdirSync(dirname(target), { recursive: true });
    // Git publishes a symlink's target name, not the external file's contents.
    if (info.isSymbolicLink()) writeFileSync(target, readlinkSync(source));
    else copyFileSync(source, target);
  }
  const result = spawnSync('gitleaks', ['dir', '--redact', '--no-banner', '--verbose', snapshot], { stdio: 'inherit', cwd: snapshot });
  if (result.error) {
    console.error('Could not run Gitleaks. Install the Gitleaks CLI and ensure it is on PATH (see commands.md).');
  }
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(snapshot, { recursive: true, force: true });
}
