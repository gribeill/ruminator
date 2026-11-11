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

export interface Profile {
  id: string;
  title: string;
  subjects: string[];
  /** One keyword/phrase group per bullet; semicolons separate aliases. */
  keywords?: string[];
}

function bullets(text: string, heading: string): string[] {
  const section = text.split(/^###[ \t]+/m).find(part => part.split('\n')[0].trim() === heading);
  return section?.split('\n').slice(1)
    .map(line => line.match(/^\s*[-*]\s+(.+)/)?.[1]?.trim()).filter((s): s is string => !!s) ?? [];
}

/** Stable heading IDs decouple profile identity from file order and display names. */
export function parseProfiles(markdown: string): Profile[] {
  const text = markdown.replace(/\r\n?/g, '\n').replace(/<!--[\s\S]*?-->/g, '');
  const sections = text.split(/^##[ \t]+/m).slice(1);
  if (!sections.length) throw new Error('No research profiles; use ## Name {#stable-id} headings');
  const seen = new Set<string>();
  const profiles = sections.map(section => {
    const heading = section.split('\n')[0].trim();
    const match = /^(.+?)\s+\{#([a-z0-9]+(?:-[a-z0-9]+)*)\}$/.exec(heading);
    if (!match) throw new Error(`Profile heading needs a title and {#stable-id}: ${heading}`);
    const [, title, id] = match;
    if (seen.has(id)) throw new Error(`Duplicate profile ID: ${id}`);
    seen.add(id);
    const subjects = bullets(section, 'Subjects');
    const keywords = bullets(section, 'Keywords')
      .map(group => group.split(';').map(alias => alias.trim()).filter(Boolean).join('; ')).filter(Boolean);
    if (!subjects.length) throw new Error(`Profile ${id} needs ### Subjects bullets`);
    return { id, title: title.trim(), subjects, keywords };
  });
  // Document order is for editing convenience, not a hidden ranking preference.
  return profiles.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

