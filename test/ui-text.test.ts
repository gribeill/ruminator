// Copyright 2026 Guilhem Ribeill
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { parseHTML } from 'linkedom';
import { createUiText, uiText, uiHtml } from '../src/ui-text.ts';
import { createDigest } from '../src/digest.ts';
import { createDigestServer } from '../src/server.ts';
import { startHostedFixture } from '../scripts/hosted-fixtures.ts';
import { parseProfiles } from '../src/profile-text.ts';
import { DocumentError } from '../src/document-error.ts';

const source = readFileSync('ui_text.toml', 'utf8');

test('UI text validates strings and declared placeholders without fallback copy', () => {
  assert.equal(uiText('shared.name'), 'ruminator');
  assert.throws(() => createUiText(source + '\n[bad]\nvalue = 123\n'), /must be a string/);
  assert.throws(() => createUiText('bad = "text"\n' + source), /UI text section expected/);
  assert.throws(() => createUiText(source.replace('Save"', 'Save {unknown}"')), /Unsupported UI placeholder/);
  assert.throws(() => createUiText(source.replace('Save"', 'Save {Title1}"')), /Unsupported UI placeholder/);
  assert.throws(() => createUiText(source.replace('page_title = "{title} · {app_name}"\n', '')), /Missing UI text: shared.page_title/);
  assert.throws(() => uiText('not.a.key'), /Missing UI text/);
  assert.throws(() => uiText('reading.title', { date: '2030-01-01' }), /Missing UI value.*app_name/);
});

test('repository edits and dynamic values are plain text, escaped once and never recursively templated', () => {
  const edited = createUiText(source.replace('Save"', '<b>Keep edits & continue</b>"')
    .replace('Editor base revision {revision}.', '<em>Revision {revision}</em>'));
  assert.equal(edited.text('editor.save'), '<b>Keep edits & continue</b>');
  assert.equal(edited.html('editor.save'), '&lt;b&gt;Keep edits &amp; continue&lt;/b&gt;');
  assert.equal(edited.html('editor.base_revision', { revision: '{revision}<script>' }),
    '&lt;em&gt;Revision {revision}&lt;script&gt;&lt;/em&gt;');
  assert.equal(uiHtml('reading.arxiv', { id: '\"><img src=x>' }), 'arXiv:&quot;&gt;&lt;img src=x&gt;');
  const withoutSlot = createUiText(source.replace('Other postings ({count})', 'More papers'));
  assert.equal(withoutSlot.text('reading.other_postings'), 'More papers'); // Editors may omit data slots.
});

test('browser validation copy is editable without changing CLI/library diagnostics', () => {
  const edited = createUiText(source.replace('No research profiles; use ## Name {#stable-id} headings', 'Add a profile heading first.'));
  assert.throws(() => parseProfiles(''), (error: unknown) => {
    assert.ok(error instanceof DocumentError);
    assert.equal(error.message, 'No research profiles; use ## Name {#stable-id} headings');
    assert.equal(edited.text(`validation.${error.code}`, error.values), 'Add a profile heading first.');
    return true;
  });
});

test('the same catalogue renders in the actual Node server and bundled workerd pages', { timeout: 120000 }, async () => {
  const digest = createDigest([{ category: 'quant-ph', date: '2030-01-01', sourceUrl: 'fixture', papers: [
    { id: '2601.00001', version: 1, title: 'Literal {title} <script>', abstract: 'Scientific content.', categories: ['quant-ph'] },
  ] }]);
  const local = createDigestServer(digest, { read: () => ({}), write: () => assert.fail('GET cannot vote') });
  local.listen(0, '127.0.0.1'); await once(local, 'listening');
  const fixture = await startHostedFixture();
  try {
    const response = await fetch(`http://127.0.0.1:${(local.address() as AddressInfo).port}/`);
    const html = await response.text(), doc = parseHTML(html).document;
    assert.equal(doc.querySelector('h1')!.textContent, uiText('shared.name'));
    assert.equal(doc.querySelector('button')!.getAttribute('aria-label'), uiText('votes.more'));
    assert.equal(doc.querySelector('details.featured-abstract summary')!.textContent, uiText('reading.abstract'));
    assert.match(html, /Literal \{title\} &lt;script&gt;/);
    const token = await fixture.access.token('owner@example.test');
    for (const path of ['/', '/reader', '/admin', '/interests']) {
      const response = await fixture.worker.fetch(fixture.origin + path, { headers: { 'Cf-Access-Jwt-Assertion': token } });
      assert.equal(response.status, 200);
      const doc = parseHTML(await response.text()).document;
      assert.equal(doc.querySelector('h1')!.textContent, uiText('shared.name'));
      if (path === '/admin') {
        assert.equal(doc.querySelector('h2')!.textContent, uiText('editor.config_title'));
        assert.equal(doc.querySelector('button')!.textContent, uiText('editor.save'));
        assert.ok(doc.querySelector('main')!.textContent.includes(uiText('editor.base_revision', { revision: 1 })));
      }
    }
    assert.equal(await fixture.db.prepare('SELECT 1 FROM generation_inputs').first(), null);
  } finally {
    await fixture.close();
    local.closeAllConnections();
    await new Promise<void>(resolve => local.close(() => resolve()));
  }
});
