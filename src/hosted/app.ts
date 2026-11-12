// Copyright 2026 Guilhem Ribeill
// SPDX-License-Identifier: Apache-2.0

import type { D1Database, Workflow } from '@cloudflare/workers-types';
import { brandStyles, createDigestRenderer, footerStyles, renderBrand, renderFooter, type CowNavigation } from '../render.ts';
import { escapeHtml } from '../math.ts';
import { paperAnchor, type VoteValue } from '../feedback.ts';
import { readResponseText } from '../http-body.ts';
import { accessVerifier, authSettings, formToken, verifyFormToken } from './auth.ts';
import { provisionUser, readPublicReading, readReading, readUserVotes, saveUserVote, ReadingUnavailableError, type User, type ReadingPublication } from './reading-store.ts';

import { adminAction, adminControls } from './admin-controls.ts';
import type { GenerationReference } from './daily-runs.ts';
import { documentEditor } from './editors.ts';
import { requireExecution, type ExecutionSettings } from './activation.ts';

export interface HostedEnv extends ExecutionSettings {
  DB: D1Database;
  GENERATION?: Workflow<GenerationReference>;
  PUBLIC_ORIGIN: string;
  ACCESS_ISSUER: string;
  ACCESS_AUDIENCE: string;
  ASSETS: { fetch(url: string, init?: { method: string }): Promise<Response> };
}
interface ReplyOptions {
  publicPage?: boolean;
  html?: boolean;
  headers?: Record<string, string>;
}
const publicLinks: CowNavigation = { links: [{ href: '/login', label: 'Login' }] };
const privateLinks = (user: User): CowNavigation => ({ email: user.email, links: [
  { href: '/logout', label: 'Logout' }, { href: '/interests', label: 'Interests' },
  ...(user.role === 'admin' ? [{ href: '/admin', label: 'Admin' }] : []),
] });

function page(title: string, body: string, navigation: CowNavigation): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · ruminator</title><style>body{max-width:800px;margin:auto;padding:1em;line-height:1.5;font-family:Optima,Candara,Calibri,Arial,sans-serif}pre{white-space:pre-wrap;overflow-wrap:anywhere}textarea{display:block;box-sizing:border-box;width:100%;font:inherit;font-family:monospace}label{display:block}button{font:inherit}${brandStyles}${footerStyles}</style></head>
<body><header>${renderBrand(navigation)}</header>
<main><h2>${escapeHtml(title)}</h2>${body}</main>${renderFooter()}</body></html>`;
}

/** Reading and authorized mutations. Execution controls require an explicitly
 * supplied Workflow binding; production/preview configurations do not enable it.
 */
export function createHostedApp(env: HostedEnv) {
  const execution = () => {
    if (!env.GENERATION) return undefined;
    try { requireExecution(env); return env.GENERATION; } catch { return undefined; }
  };
  const settings = authSettings(env);
  const verify = accessVerifier(settings);
  const renderers = new Map<string, { identity: string; render: ReturnType<typeof createDigestRenderer> }>();
  function renderer(publication: ReadingPublication, user?: User) {
    const key = user ? `user:${user.id}` : 'public';
    const identity = JSON.stringify([publication.generationId, user?.role, user?.email]);
    let cached = renderers.get(key);
    if (!cached || cached.identity !== identity) {
      cached = { identity, render: createDigestRenderer(publication.digest, user ? privateLinks(user) : publicLinks) };
      renderers.set(key, cached);
    }
    return cached.render;
  }
  return async (request: Request): Promise<Response> => {
    const head = request.method === 'HEAD';
    // Private/no-store is the default; public reading opts in explicitly.
    const reply = (status: number, body: string, options: ReplyOptions = {}) => new Response(head ? null : body, {
      status, headers: {
        'Content-Type': options.html ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8',
        'Cache-Control': options.publicPage ? 'public, max-age=0, must-revalidate' : 'private, no-store',
        ...(options.publicPage ? {} : { Vary: 'Cookie, Cf-Access-Jwt-Assertion' }),
        'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'none'; style-src 'self' 'unsafe-inline'; font-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
        ...options.headers,
      },
    });
    try {
      const url = new URL(request.url);
      // Request.url is the platform's routed origin; Host/forwarded headers can be
      // rewritten by proxies and must not select an identity provider or redirect.
      if (url.origin !== settings.origin) return reply(403, 'Unexpected application origin');
      const path = url.pathname;
      const read = ['GET', 'HEAD'].includes(request.method);
      if (/^\/assets\/katex\/(?:katex\.min\.css|fonts\/[A-Za-z0-9_.-]+\.(?:woff2?|ttf))$/.test(path) && read) {
        const asset = await env.ASSETS.fetch(request.url, { method: request.method });
        return new Response(asset.body, { status: asset.status, headers: {
          'Content-Type': asset.headers.get('content-type') ?? 'application/octet-stream',
          'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff',
        } });
      }
      if (path === '/') {
        if (!read) return reply(405, 'Reading only', { headers: { Allow: 'GET, HEAD' } });
        // Deliberately ignore every login cookie/header here. Public output is always the admin's.
        const publication = await readPublicReading(env.DB);
        return reply(200, head ? '' : publication ? renderer(publication)() : page('Public listing', '<p>No listing has been published yet.</p>', publicLinks), { publicPage: true, html: true });
      }
      if (['/login', '/logout'].includes(path) && read) {
        const destination = path === '/login'
          ? settings.local ? `${settings.issuer}/login?redirect_url=${encodeURIComponent(settings.origin + '/reader')}` : settings.origin + '/reader'
          : (settings.local ? settings.issuer : settings.origin) + '/cdn-cgi/access/logout';
        return reply(303, '', { headers: { Location: destination } });
      }
      const privateRoute = ['/reader', '/interests', '/admin'].some(prefix => path === prefix || path.startsWith(prefix + '/'));
      if (!privateRoute) return reply(404, 'Not found');
      if (request.method === 'POST' && request.headers.get('origin') !== settings.origin) return reply(403, 'Invalid origin');
      const identity = await verify(request);
      if (!identity) return reply(401, page('Log in', '<p>A valid invited-user session is required.</p>', publicLinks), { html: true });
      const user = await provisionUser(env.DB, identity);
      if (!user) return reply(403, 'Account disabled or identity requires operator review');
      if ((path === '/admin' || path.startsWith('/admin/')) && user.role !== 'admin') return reply(403, 'Admin access required');
      if (path === '/reader/vote' && request.method === 'POST') {
        if (!/^application\/x-www-form-urlencoded(?:;|$)/i.test(request.headers.get('content-type') ?? '')) return reply(415, 'Expected a vote form');
        let form: URLSearchParams;
        try { form = new URLSearchParams(await readResponseText(request, 2048)); }
        catch { return reply(413, 'Vote form could not be read or is too large'); }
        if ([...form.keys()].length !== 3 || ['paper', 'value', 'token'].some(key => form.getAll(key).length !== 1) ||
            !['-1', '0', '1'].includes(form.get('value') ?? '')) return reply(400, 'Invalid vote form');
        const publication = await readReading(env.DB, user.id); // Re-read after body arrival.
        if (!publication || !await verifyFormToken(form.get('token')!, user.csrf_secret, user.id, identity.session, publication.generationId)) {
          return reply(403, 'Invalid or outdated form; reload your reader');
        }
        if (!await saveUserVote(env.DB, user.id, publication.generationId, form.get('paper')!, Number(form.get('value')) as VoteValue)) {
          return reply(409, 'Listing changed or account unavailable; reload your reader');
        }
        return reply(303, '', { headers: { Location: `/reader#${encodeURIComponent(paperAnchor(form.get('paper')!))}` } });
      }
      if ((path === '/admin/rebuild' || path === '/admin/summaries') && request.method === 'POST') {
        const result = await adminAction(request, env.DB, user, identity.session, path === '/admin/rebuild' ? 'rebuild' : 'summaries', execution());
        return reply(result.status, result.location ? '' : page('Generation controls', result.body, privateLinks(user)),
          { html: true, ...(result.location ? { headers: { Location: result.location } } : {}) });
      }
      if ((path === '/interests' || path === '/admin') && (read || request.method === 'POST')) {
        const result = await documentEditor(request, env.DB, user, identity.session, path === '/interests' ? 'interests' : 'config');
        const controls = path === '/admin' && read && !head ? await adminControls(env.DB, user, identity.session, !!execution()) : '';
        return reply(result.status, result.location ? '' : page(path === '/interests' ? 'Your interests' : 'Admin configuration', result.body + controls, privateLinks(user)),
          { html: true, ...(result.location ? { headers: { Location: result.location } } : {}) });
      }
      if (!read) return reply(405, 'This operation is not available', { headers: { Allow: path === '/interests' || path === '/admin' ? 'GET, HEAD, POST' : 'GET, HEAD' } });
      if (path === '/reader') {
        const publication = await readReading(env.DB, user.id);
        if (head) return reply(200, '', { html: true });
        const body = publication ? renderer(publication, user)({ votes: await readUserVotes(env.DB, user.id),
          csrfToken: await formToken(user.csrf_secret, user.id, identity.session, publication.generationId), action: '/reader/vote' })
          : page('Your reader', '<p>Your listing will be prepared at the next scheduled update. You can review your default interests in the meantime.</p>', privateLinks(user));
        return reply(200, body, { html: true });
      }
      return reply(404, 'Not found');
    } catch (error) {
      if (error instanceof ReadingUnavailableError) return reply(503, error.message, { headers: { 'Retry-After': '1' } });
      return reply(500, 'Hosted request failed'); // No JWTs, private paper text, or credentials in errors/logs.
    }
  };
}
