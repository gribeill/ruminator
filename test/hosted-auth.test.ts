// Copyright 2026 Guilhem Ribeill
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseHTML } from 'linkedom';
import { fixtureDigest, publishFixture, startHostedFixture } from '../scripts/hosted-fixtures.ts';
import { authSettings, SESSION_SECONDS } from '../src/hosted/auth.ts';
import { DEFAULT_INTERESTS } from '../src/hosted/default-interests.ts';
import { parseProfiles } from '../src/profile-text.ts';
import { readReading, readUserVotes, saveUserVote } from '../src/hosted/reading-store.ts';

test('hosted auth configuration refuses remote development issuers and noncanonical origins', () => {
  const valid = { PUBLIC_ORIGIN: 'https://papers.example.test', ACCESS_ISSUER: 'https://team.cloudflareaccess.com', ACCESS_AUDIENCE: 'app-aud' };
  assert.equal(authSettings(valid).local, false);
  for (const change of [
    { PUBLIC_ORIGIN: 'http://papers.example.test' }, { PUBLIC_ORIGIN: 'https://papers.example.test/path' },
    { ACCESS_ISSUER: 'https://attacker.test' },
    { ACCESS_ISSUER: 'http://127.0.0.1:9999' }, { ACCESS_AUDIENCE: '' },
  ]) assert.throws(() => authSettings({ ...valid, ...change }));
});

test('hosted auth: real RSA/JWKS and workerd/D1 enforce public, owner, role, session, and publication boundaries', { timeout: 120_000 }, async t => {
  const fixture = await startHostedFixture();
  const { origin, access, worker, db, owner, friend } = fixture;
  try {
    const ownerToken = await access.token('owner@example.test');
    const friendToken = await access.token('friend@example.test');
    const request = (path: string, token?: string, init: { method?: string; body?: string; headers?: HeadersInit } = {}) => worker.fetch(origin + path, {
      redirect: 'manual', ...init, headers: { ...(token ? { 'Cf-Access-Jwt-Assertion': token } : {}), ...Object.fromEntries(new Headers(init.headers)) },
    });
    const scalar = async (sql: string, ...values: string[]) => (await db.prepare(sql).bind(...values).raw<[number]>())[0][0];
    const form = async (token: string) => {
      const html = await (await request('/reader', token)).text();
      const element = parseHTML(html).document.querySelector('form.vote-controls')!;
      return new URLSearchParams({ paper: element.querySelector('input[name="paper"]')!.getAttribute('value')!,
        token: element.querySelector('input[name="token"]')!.getAttribute('value')!, value: '1' });
    };
    const post = (token: string, body: URLSearchParams | string, headers: Record<string, string> = {}, path = '/reader/vote') =>
      request(path, token, { method: 'POST', body: String(body), headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded', ...headers } });
    let publicHTML = '';

    await t.test('public output ignores login and private data; static math assets stay local', async () => {
      const anonymous = await request('/');
      assert.equal(anonymous.status, 200);
      assert.match(anonymous.headers.get('cache-control')!, /^public/);
      publicHTML = await anonymous.text();
      assert.match(publicHTML, /Admin fixture/);
      assert.match(publicHTML, /AI summary/);
      assert.match(publicHTML, /class="katex/);
      assert.doesNotMatch(publicHTML, /<form class="vote-controls"|name="token"|Friend private|ADMIN_PRIVATE_MARKER|example\.test/);
      assert.equal(await (await request('/', friendToken)).text(), publicHTML);
      assert.equal(await (await request('/', ownerToken)).text(), publicHTML);
      for (const path of ['/assets/katex/katex.min.css', '/assets/katex/fonts/KaTeX_Main-Regular.woff2']) {
        const asset = await request(path);
        assert.equal(asset.status, 200);
        assert.match(asset.headers.get('cache-control')!, /^public/);
      }
      assert.equal((await request('/.env')).status, 404);
      assert.equal((await request('/reader/vote', undefined, { method: 'POST', headers: { Origin: origin } })).status, 401);
    });

    await t.test('signed app identity is required; forged, wrong-app, expired, and service identities fail closed', async () => {
      assert.equal((await request('/reader')).status, 401);
      assert.equal((await request('/reader', undefined, { headers: { 'Cf-Access-Authenticated-User-Email': 'owner@example.test' } })).status, 401);
      const now = Math.floor(Date.now() / 1000);
      const tokens = await Promise.all([
        access.token('friend@example.test', { aud: 'another-app' }), access.token('friend@example.test', { iss: 'https://evil.test' }),
        access.token('friend@example.test', { exp: now - 60 }), access.token('friend@example.test', { exp: now + SESSION_SECONDS + 3600 }),
        access.token('friend@example.test', { type: 'org' }), access.token('friend@example.test', { email: undefined, sub: '' }),
      ]);
      const pieces = friendToken.split('.');
      tokens.push(`${pieces[0]}.${pieces[1]}.${pieces[2][0] === 'A' ? 'B' : 'A'}${pieces[2].slice(1)}`);
      tokens.push(Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url') + '.' + pieces[1] + '.');
      for (const token of tokens) {
        const denied = await request('/reader', token);
        assert.equal(denied.status, 401);
        assert.match(denied.headers.get('cache-control')!, /no-store/);
        assert.doesNotMatch(await denied.text(), /Friend private|Admin fixture|eyJ/);
      }
      assert.equal((await request('/reader', 'invalid', { headers: { Cookie: `CF_Authorization=${friendToken}` } })).status, 401);
      assert.equal((await request('/reader', undefined, { headers: { Cookie: `CF_Authorization=${friendToken}` } })).status, 200);
      assert.equal(await scalar('SELECT count(*) FROM users'), 2);
    });

    await t.test('private reads are scoped and never cacheable; alternate hosts and admin role claims cannot bypass checks', async () => {
      const reader = await request('/reader', friendToken);
      assert.equal(reader.status, 200);
      assert.match(reader.headers.get('cache-control')!, /private, no-store/);
      const html = await reader.text();
      assert.match(html, /Friend private fixture/);
      assert.doesNotMatch(html, /Admin fixture|ADMIN_PRIVATE_MARKER/);
      assert.match(html, /action="\/reader\/vote"/);
      assert.equal(await (await request(`/reader?user_id=${owner.id}`, friendToken)).text(), html);
      const ownerListing = (await readReading(db, owner.id))!;
      await assert.rejects(db.prepare('UPDATE current_readings SET listing_id = ? WHERE user_id = ?')
        .bind(ownerListing.generationId, friend.id).run(), /FOREIGN KEY/);
      assert.ok(!html.includes(friendToken));
      const ownerHTML = await (await request('/reader', ownerToken)).text();
      assert.match(ownerHTML, /Admin fixture/);
      assert.doesNotMatch(ownerHTML, /Friend private|friend@example\.test/);
      const fakeAdmin = await access.token('friend@example.test', { role: 'admin', user_id: owner.id });
      assert.equal((await request('/admin', fakeAdmin)).status, 403);
      assert.equal((await post(fakeAdmin, '', {}, '/admin/regenerate')).status, 403);
      assert.equal((await request('/admin', ownerToken)).status, 200);
      assert.equal((await worker.fetch('http://alternate.workers.dev/reader', { headers: { 'Cf-Access-Jwt-Assertion': friendToken } })).status, 403);
    });

    await t.test('first login creates a stable regular account with valid defaults, without copying a listing or starting inference', async () => {
      const token = await access.token('new@example.test', { role: 'admin' });
      const pending = await request('/reader', token);
      assert.equal(pending.status, 200);
      const waiting = await pending.text();
      assert.match(waiting, /next scheduled update/);
      assert.doesNotMatch(waiting, /Admin fixture|Friend private/);
      const user = await db.prepare("SELECT * FROM users WHERE email = 'new@example.test'").first<{ id: string; interests: string; role: string; enabled: number }>();
      assert.equal(user!.role, 'user');
      assert.equal(user!.enabled, 1);
      assert.equal(user!.interests, DEFAULT_INTERESTS);
      assert.equal(parseProfiles(user!.interests).length, 6);
      assert.equal(await readReading(db, user!.id), undefined);
      const interests = await (await request('/interests', token)).text();
      assert.match(interests, /Qubit hardware/);
      assert.doesNotMatch(interests, /ADMIN_PRIVATE_MARKER/);
      await db.prepare('UPDATE users SET interests = interests || ? WHERE id = ?').bind('\n<!-- User edit -->\n<script>unsafe()</script>', user!.id).run();
      await request('/reader', await access.token('new@example.test', { jti: 'new-session' }));
      const same = await db.prepare("SELECT id, interests FROM users WHERE email = 'new@example.test'").first<{ id: string; interests: string }>();
      assert.equal(same!.id, user!.id);
      assert.match(same!.interests, /User edit/);
      const edited = await (await request('/interests', token)).text();
      assert.match(edited, /&lt;script&gt;unsafe\(\)&lt;\/script&gt;/);
      assert.doesNotMatch(edited, /<script>/);
      assert.equal(await scalar('SELECT count(*) FROM users'), 3);
    });

    await t.test('votes are user-owned, explicit, idempotent, and cannot modify either saved ranking or public output', async () => {
      const before = await readReading(db, friend.id);
      const body = await form(friendToken);
      assert.equal((await post(friendToken, body)).status, 303);
      assert.equal((await readUserVotes(db, friend.id))[body.get('paper')!], 1);
      assert.deepEqual(await readUserVotes(db, owner.id), {});
      await db.prepare('UPDATE user_votes SET changed_at = ? WHERE user_id = ?').bind('2026-01-01T00:00:00Z', friend.id).run();
      assert.equal((await post(friendToken, body)).status, 303);
      assert.equal((await db.prepare('SELECT changed_at FROM user_votes WHERE user_id = ?').bind(friend.id).first<{ changed_at: string }>())!.changed_at, '2026-01-01T00:00:00Z');
      body.set('value', '-1');
      assert.equal((await post(friendToken, body)).status, 303);
      assert.equal((await readUserVotes(db, friend.id))[body.get('paper')!], -1);
      body.set('value', '0');
      assert.equal((await post(friendToken, body)).status, 303);
      assert.deepEqual(await readUserVotes(db, friend.id), {});
      assert.deepEqual(await readReading(db, friend.id), before);
      assert.equal(await (await request('/')).text(), publicHTML);
    });

    await t.test('vote forms enforce identity/session/origin/publication binding and bounded valid inputs', async () => {
      const body = await form(friendToken);
      const before = await readUserVotes(db, friend.id);
      assert.equal((await post(ownerToken, body)).status, 403); // Same arXiv ID exists in both listings.
      assert.equal((await post(await access.token('friend@example.test', { jti: 'different-login' }), body)).status, 403);
      assert.equal((await post(friendToken, body, { Origin: 'https://evil.test' })).status, 403);
      assert.equal((await post(friendToken, body, { 'Content-Type': 'text/plain' })).status, 415);
      assert.equal((await post(friendToken, 'token=' + 'x'.repeat(3000))).status, 413);
      assert.equal((await post(friendToken, body.toString() + '&value=1')).status, 400);
      const unknown = new URLSearchParams(body); unknown.set('paper', '2611.99999');
      assert.equal((await post(friendToken, unknown)).status, 409);
      const old = (await readReading(db, friend.id))!;
      await publishFixture(db, friend.id, fixtureDigest('Replacement private fixture'));
      assert.equal((await post(friendToken, body)).status, 403);
      assert.equal(await saveUserVote(db, friend.id, old.generationId, body.get('paper')!, 1), false);
      assert.deepEqual(await readUserVotes(db, friend.id), before);
      assert.deepEqual(await readUserVotes(db, owner.id), {});
    });

    await t.test('disabled or remapped identities cannot re-provision themselves or use an existing session to vote', async () => {
      const body = await form(friendToken);
      const current = (await readReading(db, friend.id))!;
      await db.prepare('UPDATE users SET enabled = 0 WHERE id = ?').bind(friend.id).run();
      assert.equal((await request('/reader', friendToken)).status, 403);
      assert.equal((await post(friendToken, body)).status, 403);
      assert.equal(await saveUserVote(db, friend.id, current.generationId, body.get('paper')!, 1), false);
      assert.equal((await request('/reader', await access.token('friend@example.test', { sub: 'another-identity' }))).status, 403);
      assert.equal(await scalar('SELECT enabled FROM users WHERE id = ?', friend.id), 0);
      assert.equal(await scalar("SELECT count(*) FROM users WHERE email = 'friend@example.test'"), 1);
    });

    await t.test('login/logout redirect only to configured destinations', async () => {
      const login = await request('/login?next=https://evil.test');
      assert.equal(login.status, 303);
      const destination = new URL(login.headers.get('location')!);
      assert.equal(destination.origin, access.issuer);
      assert.equal(destination.searchParams.get('redirect_url'), origin + '/reader');
      const logout = await request('/logout');
      assert.equal(logout.status, 303);
      assert.equal(logout.headers.get('location'), access.issuer + '/cdn-cgi/access/logout');
    });
  } finally {
    await fixture.close();
  }
});
