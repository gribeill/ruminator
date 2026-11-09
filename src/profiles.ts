import { readdirSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';

export interface Profile {
  id: string;
  title: string;
  subjects: string[];
}

/** Only explicit positive subjects belong in the initial embedding query. */
export function parseProfile(markdown: string, id: string): Profile {
  const text = markdown.replace(/<!--[\s\S]*?-->/g, '');
  const title = text.match(/^#\s+(.+)$/m)?.[1]?.trim();
  const section = text.split(/^##[ \t]+/m).find(part => /^Subjects[ \t]*\r?\n/.test(part));
  const subjects = section?.split('\n').slice(1)
    .map(line => line.match(/^\s*[-*]\s+(.+)/)?.[1]?.trim()).filter((s): s is string => !!s) ?? [];
  if (!title || !subjects.length) throw new Error(`Profile ${id} needs a title and Subjects bullets`);
  return { id, title, subjects };
}

export function loadProfiles(directory = 'profiles'): Profile[] {
  const files = readdirSync(directory).filter(name => name.endsWith('.md') && name.toLowerCase() !== 'readme.md').sort();
  if (!files.length) throw new Error(`No research profiles in ${directory}`);
  return files.map(file => parseProfile(readFileSync(join(directory, file), 'utf8'), basename(file, '.md')));
}
