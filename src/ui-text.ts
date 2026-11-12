// Copyright 2026 Guilhem Ribeill
// SPDX-License-Identifier: Apache-2.0

import source from '#ui-text-source';
import { parse } from 'smol-toml';
import { escapeHtml } from './math.ts';

/** These are available data slots, not a second set of copy/defaults. */
const fields: Record<string, readonly string[]> = {
  'shared.page_title': ['title', 'app_name'],
  'footer.copyright': ['year'],
  'reading.title': ['app_name', 'date'],
  'reading.paper_count': ['count'],
  'reading.other_postings': ['count'],
  'reading.arxiv': ['id'],
  'summary.unavailable': ['reason'],
  'editor.saved_revision': ['revision'],
  'editor.base_revision': ['revision'],
  'editor.published': ['revision'],
  'editor.published_config': ['revision', 'summary_revision'],
  'editor.working': ['revision'],
  'editor.working_summary': ['revision'],
  'controls.summary_description': ['input_limit'],
  'controls.limits': ['model', 'input_limit', 'completion_limit'],
  'populate.description': ['categories'],
  'populate.limits': ['model', 'input_limit'],
  'status.utc_time': ['time'],
  'status.failure': ['date', 'reason'],
  'status.pending': ['date'],
  'status.unchanged': ['date'],
  'status.completed': ['date'],
  'status.shared': ['date', 'message'],
  'validation.profile_heading': ['heading'],
  'validation.duplicate_profile': ['id'],
  'validation.profile_subjects': ['id'],
  'validation.missing_table': ['path'],
  'validation.unknown_key': ['path'],
  'validation.missing_key': ['path'],
  'validation.embedding': ['key'],
  'validation.syntax': ['detail'],
};
const slot = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
type Values = Record<string, string | number>;

/** Parse once at process/bundle startup. No HTML templates, fallbacks, locales,
 * runtime file fetching or recursive substitution of untrusted dynamic values. */
export function createUiText(toml: string) {
  const entries = new Map<string, string>();
  for (const [section, table] of Object.entries(parse(toml))) {
    if (!table || typeof table !== 'object' || Array.isArray(table)) throw new Error(`UI text section expected: ${section}`);
    for (const [name, value] of Object.entries(table)) {
      const key = `${section}.${name}`;
      if (typeof value !== 'string') throw new Error(`UI text must be a string: ${key}`);
      for (const match of value.matchAll(slot)) {
        if (!fields[key]?.includes(match[1])) throw new Error(`Unsupported UI placeholder: ${key}.{${match[1]}}`);
      }
      entries.set(key, value);
    }
  }
  for (const key of Object.keys(fields)) if (!entries.has(key)) throw new Error(`Missing UI text: ${key}`);
  const text = (key: string, values: Values = {}): string => {
    const template = entries.get(key);
    if (template === undefined) throw new Error(`Missing UI text: ${key}`);
    return template.replace(slot, (_match, name: string) => {
      if (!Object.hasOwn(values, name)) throw new Error(`Missing UI value: ${key}.{${name}}`);
      return String(values[name]);
    });
  };
  // Escape the whole result, including repository copy and substituted values.
  return { text, html: (key: string, values?: Values) => escapeHtml(text(key, values)) };
}

/** Plain text for response bodies; HTML text is always escaped. */
export const { text: uiText, html: uiHtml } = createUiText(source);
