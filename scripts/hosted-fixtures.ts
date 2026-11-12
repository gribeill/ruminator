// Copyright 2026 Guilhem Ribeill
// SPDX-License-Identifier: Apache-2.0

// LOCAL TEST SUPPORT ONLY. No fixture key or account is bundled into the hosted Worker.
import assert from 'node:assert/strict';
import { freezeGenerationInputs } from '../src/hosted/generation-inputs.ts';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdirSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import type { D1Database, Workflow } from '@cloudflare/workers-types';
import { parseFeed } from '../src/arxiv.ts';
import { createDigest, type Digest } from '../src/digest.ts';
import { rankPapers } from '../src/ranking.ts';
import { parseProfiles } from '../src/profile-text.ts';
import type { SemanticScores } from '../src/semantic-types.ts';
import { SESSION_SECONDS, type Identity } from '../src/hosted/auth.ts';
import { DEFAULT_INTERESTS } from '../src/hosted/default-interests.ts';
import { provisionUser, type ReadingMetadata } from '../src/hosted/reading-store.ts';
import type { HostedEnv } from '../src/hosted/app.ts';
import { initializeSavedConfig } from '../src/hosted/saved-inputs.ts';
import { prepareHostedAssets } from './hosted-assets.ts';

/** Fixture setup expects a snapshot, not a blocked/unchanged admission. */
export async function freezeFixtureInputs(...args: Parameters<typeof freezeGenerationInputs>) {
  const result = await freezeGenerationInputs(...args);
  assert.ok(result.status === 'captured', 'Fixture admission must capture a snapshot');
  return result.inputs;
}

export const FIXTURE_AUDIENCE = 'ruminator-local-fixture';
export const FIXTURE_EMAILS = ['owner@example.test', 'friend@example.test', 'new@example.test'];

export async function fixtureAccess() {
  const pair = await generateKeyPair('RS256');
  const jwk = { ...await exportJWK(pair.publicKey), kid: 'local-fixture', alg: 'RS256' };
  let issuer = '', publicOrigin = '';
  const subject = (email: string) => `fixture-${email.split('@')[0]}`;
  const token = async (email: string, overrides: JWTPayload = {}) => {
    if (!FIXTURE_EMAILS.includes(email)) throw new Error('Not invited by the fixture identity provider');
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ iss: issuer, aud: FIXTURE_AUDIENCE, sub: subject(email), email, type: 'app',
      iat: now, exp: now + SESSION_SECONDS, ...overrides }).setProtectedHeader({ alg: 'RS256', kid: jwk.kid }).sign(pair.privateKey);
  };
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', issuer);
      if (url.pathname === '/cdn-cgi/access/certs') {
        response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ keys: [jwk] }));
      } else if (url.pathname === '/login' && publicOrigin) {
        const email = url.searchParams.get('email');
        if (email && !FIXTURE_EMAILS.includes(email)) { response.writeHead(403).end('Not invited'); return; }
        if (!email) {
          response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(
            '<!doctype html><title>Local fixture login</title><h1>Local fixture login — not Cloudflare</h1><p>No email is sent. Choose an example account:</p>' +
            FIXTURE_EMAILS.map(address => `<p><a href="/login?email=${encodeURIComponent(address)}">${address}</a></p>`).join(''));
        } else {
          response.writeHead(303, {
            // HTTP is permitted only for this loopback fixture. Real Access owns its Secure cookies.
            'Set-Cookie': `CF_Authorization=${await token(email)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_SECONDS}`,
            Location: publicOrigin + '/reader', 'Cache-Control': 'no-store',
          }).end();
        }
      } else if (url.pathname === '/cdn-cgi/access/logout' && publicOrigin) {
        response.writeHead(303, { 'Set-Cookie': 'CF_Authorization=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0', Location: publicOrigin + '/', 'Cache-Control': 'no-store' }).end();
      } else response.writeHead(404).end('Not found');
    })().catch(() => { response.writeHead(500).end('Fixture request failed'); });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    issuer, token, subject,
    setPublicOrigin(origin: string) {
      const url = new URL(origin);
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw new Error('Fixture login requires loopback');
      publicOrigin = url.origin;
    },
    identity: (email: string): Identity => ({ issuer, subject: subject(email), email, session: 'fixture' }),
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}

export async function initializeHostedFixture(db: D1Database): Promise<void> {
  // This fixture schema has only simple CREATE statements, not a migration runner.
  const ddl = readFileSync('schema/hosted.sql', 'utf8').replace(/^[ \t]*--.*$/gm, '').split(';').filter(sql => sql.trim());
  await db.batch(ddl.map(sql => db.prepare(sql)));
}

/** Saved deterministic scores, not model calls or a claim about scientific relevance. */
export function fixtureDigest(label: string): Digest {
  const batch = parseFeed(readFileSync('test/fixtures/quant-ph.xml', 'utf8'), 'quant-ph');
  const digest = createDigest([{ ...batch, papers: batch.papers.map(paper => ({ ...paper, title: `${label} — ${paper.title}` })) }]);
  const profiles = parseProfiles(DEFAULT_INTERESTS);
  const semantic: SemanticScores = {
    fingerprint: 'fixture-only', normalization: 'cosine-affine-v1', profiles,
    papers: Object.fromEntries(digest.papers.map((paper, index) => [paper.id, {
      score: 0.75 + index * 0.01, cosine: 0.5 + index * 0.02, profileId: profiles[0].id,
      similarities: Object.fromEntries(profiles.map(profile => [profile.id, 0.5 + index * 0.02])),
    }])),
  };
  digest.semantic = semantic;
  digest.ranking = rankPapers(digest, semantic, Object.fromEntries(digest.papers.map((paper, i) => [paper.id, [Math.cos(i), Math.sin(i)]])));
  const paper = digest.ranking.featured[0];
  digest.summaries = { [paper.id]: { paperId: paper.id, version: 1, status: 'available',
    createdAt: '2026-11-10T00:00:00Z', summary: `${label} synthetic summary with $F = 0.99$. No model was called.` } };
  return digest;
}

/** Fixture writer only. The application itself exposes no publishing endpoint. */
export async function publishFixture(db: D1Database, userId: string, digest: Digest): Promise<string> {
  const id = crypto.randomUUID();
  const meta: ReadingMetadata = { date: digest.date, categories: digest.categories, featuredIds: digest.featuredIds, paperCount: digest.papers.length };
  if (digest.semantic) { const { papers, ...semantic } = digest.semantic; meta.semantic = semantic; }
  if (digest.ranking) { const { scores, remainingIds, feedbackSnapshot, ...ranking } = digest.ranking; meta.ranking = ranking; }
  const order = digest.ranking ? [...digest.ranking.featured.map(p => p.id), ...digest.ranking.remainingIds] : digest.papers.map(p => p.id);
  const json = (value: unknown) => value === undefined ? null : JSON.stringify(value);
  await db.batch([
    db.prepare('INSERT INTO reading_listings VALUES (?, ?, ?)').bind(id, userId, JSON.stringify(meta)),
    ...order.map((paperId, ordinal) => db.prepare('INSERT INTO reading_papers VALUES (?, ?, ?, ?, ?, ?, ?)').bind(id, ordinal, paperId,
      json(digest.papers.find(p => p.id === paperId)), json(digest.semantic?.papers[paperId]), json(digest.ranking?.scores[paperId]), json(digest.summaries?.[paperId]))),
    db.prepare('INSERT INTO current_readings VALUES (?, ?) ON CONFLICT (user_id) DO UPDATE SET listing_id = excluded.listing_id').bind(userId, id),
  ]);
  return id;
}

export async function seedHostedFixture(db: D1Database, access: Awaited<ReturnType<typeof fixtureAccess>>) {
  await initializeHostedFixture(db);
  await initializeSavedConfig(db, readFileSync('config.toml', 'utf8'));
  const owner = (await provisionUser(db, access.identity(FIXTURE_EMAILS[0])))!;
  const friend = (await provisionUser(db, access.identity(FIXTURE_EMAILS[1])))!;
  await db.prepare("UPDATE users SET role = 'admin', interests = interests || '\n<!-- ADMIN_PRIVATE_MARKER -->' WHERE id = ?").bind(owner.id).run();
  await publishFixture(db, owner.id, fixtureDigest('Admin fixture'));
  await publishFixture(db, friend.id, fixtureDigest('Friend private fixture'));
  return { owner, friend };
}

/** The same ephemeral workerd/D1 setup for browser previews and auth tests. */
export async function startHostedFixture(testMain?: string, workflowClass?: string) {
  process.env.WRANGLER_SEND_METRICS = 'false';
  process.env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV = 'false';
  process.env.XDG_CONFIG_HOME = resolve('.wrangler/config');
  mkdirSync('.wrangler/logs', { recursive: true });
  process.env.WRANGLER_LOG_PATH = resolve('.wrangler/logs/hosted-fixture.log');
  prepareHostedAssets();
  const access = await fixtureAccess();
  const { createTestHarness } = await import('wrangler');
  let origin = 'http://127.0.0.1:8787';
  const workerConfig = () => {
    const settings = { PUBLIC_ORIGIN: origin, ACCESS_ISSUER: access.issuer, ACCESS_AUDIENCE: FIXTURE_AUDIENCE };
    if (testMain) return { config: {
      name: 'ruminator-test', main: resolve(testMain), compatibility_date: '2026-01-01',
      workers_dev: false, preview_urls: false, vars: { ...settings,
        ...(workflowClass ? { FIXTURE_HTML: readFileSync('test/fixtures/paper-unsectioned.html', 'utf8'),
          HOSTED_EXECUTION_ENABLED: 'true', HOSTED_SCHEDULE_ENABLED: 'false',
          CLOUDFLARE_ACCOUNT_ID: '0'.repeat(32), CLOUDFLARE_API_TOKEN: 'fixture-only-token', CLOUDFLARE_GATEWAY_ID: 'fixture-only' } : {}) },
      assets: { directory: resolve('.wrangler/hosted-assets'), binding: 'ASSETS', run_worker_first: true },
      ...(workflowClass ? { workflows: [{ binding: 'GENERATION', name: 'fixture-generation', class_name: workflowClass }] } : {}),
      d1_databases: [{ binding: 'DB', database_name: 'ruminator-test', database_id: '00000000-0000-0000-0000-000000000000', remote: false }],
    } };
    return { configPath: resolve('wrangler.hosted.jsonc'), vars: settings, secrets: settings };
  };
  const harness = createTestHarness({ workers: [workerConfig()] });
  const close = async () => {
    try { await harness.close(); } finally { await access.close(); }
  };
  try {
    const { url } = await harness.listen();
    url.hostname = '127.0.0.1';
    origin = url.origin;
    access.setPublicOrigin(origin);
    await harness.update({ workers: [workerConfig()] });
    const worker = harness.getWorker<HostedEnv & { GENERATION: Workflow<{ userId: string; generationId: string }> }>();
    const { DB: db } = await worker.getEnv();
    const users = await seedHostedFixture(db, access);
    return { origin, access, worker, db, ...users, close };
  } catch (error) {
    await close();
    throw error;
  }
}
