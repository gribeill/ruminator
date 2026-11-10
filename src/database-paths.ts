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

import { existsSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';

/** Resolve existing ancestors too, so aliases are detected before creating either DB. */
function canonicalPath(path: string): string {
  try { return realpathSync.native(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  // A dangling file/directory symlink may point at a not-yet-created database.
  let target: string | undefined;
  try { target = readlinkSync(path); }
  catch (error) {
    if (!['ENOENT', 'EINVAL'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
  }
  if (target !== undefined) return canonicalPath(isAbsolute(target) ? target : `${dirname(path)}/${target}`);
  return join(canonicalPath(dirname(path)), basename(path));
}

/** Keep source and application schemas separate, including symlinks and hard links. */
export function assertSeparateDatabasePaths(appPath: string, papersPath: string): void {
  // Do not lexically resolve '..' first: its meaning can depend on a symlink.
  const samePath = canonicalPath(appPath) === canonicalPath(papersPath);
  let sameFile = false;
  if (existsSync(appPath) && existsSync(papersPath)) {
    const app = statSync(appPath), papers = statSync(papersPath);
    sameFile = app.dev === papers.dev && app.ino === papers.ino;
  }
  if (samePath || sameFile) throw new Error('Application and paper databases must be separate files');
}
