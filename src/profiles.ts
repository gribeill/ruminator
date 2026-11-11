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

import { readFileSync } from 'node:fs';
import { parseProfiles, type Profile } from './profile-text.ts';

export * from './profile-text.ts';

/** Hosted editors parse the same document without depending on local files. */
export function loadProfiles(path = 'interests.md'): Profile[] {
  return parseProfiles(readFileSync(path, 'utf8'));
}
