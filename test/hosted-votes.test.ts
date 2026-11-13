// Copyright 2026 Guilhem Ribeill
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { parseHTML } from 'linkedom';
import { createDigest } from '../src/digest.ts';
import { renderDigest, voteButtonStates } from '../src/render.ts';
import { uiText } from '../src/ui-text.ts';

const script = readFileSync(new URL('../src/hosted/assets/votes.js', import.meta.url), 'utf8');

test('vote script enhances real forms, confirms before updating, and preserves state on failures', async () => {
  const digest = createDigest([{ category: 'quant-ph', date: '2026-11-13', sourceUrl: 'fixture',
    papers: ['2611.00001', '2611.00002'].map(id => ({ id, version: 1, title: id, abstract: 'Fixture.', categories: ['quant-ph'] })) }]);
  const voting = { votes: {}, csrfToken: 'fixture-csrf', action: '/reader/vote' };
  assert.doesNotMatch(renderDigest(digest, voting), /data-enhanced-votes|<script/); // Local mode stays native.
  const { document, window } = parseHTML(renderDigest(digest, { ...voting, enhance: true }));
  const forms = [...document.querySelectorAll('form.vote-controls')], form = forms[0];
  const buttons = [...form.querySelectorAll('button')], status = form.querySelector('[role="status"]')!;
  // linkedom supplies the DOM/events; only the browser FormData(form) constructor needs a shim.
  class BrowserFormData extends Map<string, string> {
    constructor(form: Element) {
      super([...form.querySelectorAll('input[name]')].map(input => [input.getAttribute('name')!, input.getAttribute('value')!]));
    }
  }
  const calls: { url: string; init: RequestInit }[] = [];
  let respond!: (response: unknown) => void, reject!: (error: Error) => void;
  const fetcher = (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Promise((resolve, fail) => { respond = resolve; reject = fail; });
  };
  const context = { document, fetch: fetcher, FormData: BrowserFormData, URLSearchParams, AbortController, setTimeout, clearTimeout,
    window: { fetch: fetcher, FormData: BrowserFormData, URLSearchParams, AbortController } };
  runInNewContext(script, context);
  const submit = (submitter?: Element) => {
    const event = new window.Event('submit', { bubbles: true, cancelable: true });
    if (submitter) Object.defineProperty(event, 'submitter', { value: submitter });
    form.dispatchEvent(event);
    return event;
  };
  const flush = () => new Promise(resolve => setImmediate(resolve));
  const confirm = async (value: -1 | 0 | 1) => {
    respond(new Response(JSON.stringify({ paper: form.querySelector('input[name="paper"]')!.getAttribute('value'), value,
      buttons: voteButtonStates(value) }), { headers: { 'Content-Type': 'application/json' } }));
    await flush();
  };

  assert.equal(submit().defaultPrevented, false); // Missing submitter support keeps ordinary submission.
  assert.equal(submit(buttons[0]).defaultPrevented, true);
  assert.ok(buttons.every(button => button.disabled));
  assert.equal(forms[1].querySelector('button')!.disabled, false);
  assert.equal(buttons[0].getAttribute('aria-pressed'), 'false');
  assert.equal(status.textContent, uiText('votes.saving'));
  submit(buttons[1]);
  assert.equal(calls.length, 1); // Busy paper cannot dispatch again.
  assert.equal(calls[0].url, '/reader/vote');
  assert.equal(new URLSearchParams(calls[0].init.body as URLSearchParams).get('value'), '1');
  assert.equal(calls[0].init.redirect, 'manual');
  await confirm(1);
  assert.equal(buttons[0].getAttribute('aria-pressed'), 'true');
  assert.equal(buttons[0].getAttribute('value'), '0');
  assert.equal(buttons[0].getAttribute('aria-label'), uiText('votes.clear_up'));
  assert.ok(buttons.every(button => !button.disabled));
  submit(buttons[0]);
  assert.equal(new URLSearchParams(calls[1].init.body as URLSearchParams).get('value'), '0');
  await confirm(0);
  assert.equal(buttons[0].getAttribute('aria-pressed'), 'false');

  for (const [response, message] of [
    [new Response('', { status: 403 }), 'votes.stale'],
    [{ type: 'opaqueredirect', status: 0 }, 'votes.login'],
    [new Response('<html>Access challenge</html>'), 'votes.failed'],
  ] as const) {
    submit(buttons[0]); respond(response); await flush();
    assert.equal(status.textContent, uiText(message));
    assert.equal(buttons[0].getAttribute('aria-pressed'), 'false');
    assert.ok(buttons.every(button => !button.disabled));
  }
  submit(buttons[0]); reject(new Error('network interrupted')); await flush();
  assert.equal(status.textContent, uiText('votes.failed'));
  assert.equal(calls.length, 6); // Exactly one attempt per explicit click, never automatic fallback/retry.
});
