// Copyright 2026 Guilhem Ribeill
// SPDX-License-Identifier: Apache-2.0

import { createRemoteJWKSet, customFetch, jwtVerify } from 'jose';
import { readResponseText } from '../http-body.ts';

export interface AuthSettings {
  origin: string;
  issuer: string;
  audience: string;
  local: boolean;
}
export interface Identity { issuer: string; subject: string; email: string; session: string }
export const SESSION_SECONDS = 7 * 24 * 60 * 60;

const loopback = (url: URL) => url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);

/** A local issuer is allowed only with a loopback HTTP app. Such settings fail
 * origin checks on any deployed hostname; there is no skip-verification mode.
 */
export function authSettings(env: { PUBLIC_ORIGIN: string; ACCESS_ISSUER: string; ACCESS_AUDIENCE: string }): AuthSettings {
  const origin = new URL(env.PUBLIC_ORIGIN);
  const issuer = new URL(env.ACCESS_ISSUER);
  for (const url of [origin, issuer]) {
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Expected an origin, not a URL path');
  }
  const local = loopback(origin) && loopback(issuer);
  if (!local && (origin.protocol !== 'https:' || issuer.protocol !== 'https:' || issuer.port ||
      !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(issuer.hostname))) throw new Error('Invalid Access origin configuration');
  if (!env.ACCESS_AUDIENCE?.trim()) throw new Error('Missing Access audience');
  return { origin: origin.origin, issuer: issuer.origin, audience: env.ACCESS_AUDIENCE, local };
}

export async function sha256(text: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), b => b.toString(16).padStart(2, '0')).join('');
}

/** Use trusted JWKS and standard JOSE validation, never a token's jku or an email header.
 * Cache rotating keys, not user authorization: enabled/role are checked in D1 each time.
 */
export function accessVerifier(settings: AuthSettings) {
  const keys = createRemoteJWKSet(new URL('/cdn-cgi/access/certs', settings.issuer), {
    timeoutDuration: 5000,
    [customFetch]: async (url, init) => {
      const response = await fetch(url, init);
      if (response.status !== 200) { await response.body?.cancel(); throw new Error('Access keys unavailable'); }
      return new Response(await readResponseText(response, 64 * 1024), { headers: { 'Content-Type': 'application/json' } });
    },
  });
  return async (request: Request): Promise<Identity | undefined> => {
    // Prefer the assertion. An invalid header must never fall back to a different cookie.
    const cookies = (request.headers.get('cookie') ?? '').split(';').map(c => c.trim()).filter(c => c.startsWith('CF_Authorization='));
    const token = request.headers.get('Cf-Access-Jwt-Assertion') ?? (cookies.length === 1 ? cookies[0].slice('CF_Authorization='.length) : '');
    if (!token || token.length > 16 * 1024) return undefined;
    try {
      const { payload } = await jwtVerify(token, keys, {
        algorithms: ['RS256'], issuer: settings.issuer, audience: settings.audience,
        requiredClaims: ['iss', 'aud', 'sub', 'email', 'iat', 'exp', 'type'],
        maxTokenAge: SESSION_SECONDS, clockTolerance: 5,
      });
      if (payload.type !== 'app' || typeof payload.sub !== 'string' || !payload.sub.trim() || payload.sub.length > 255 ||
          typeof payload.email !== 'string' || payload.email.length > 254 || !/^[^\s@<>]+@[^\s@<>]+$/.test(payload.email) ||
          payload.exp! - payload.iat! > SESSION_SECONDS + 5) return undefined;
      return { issuer: settings.issuer, subject: payload.sub, email: payload.email.toLowerCase(), session: await sha256(token) };
    } catch {
      return undefined; // Never return/log a JWT, raw provider error, or key-fetch URL.
    }
  };
}

async function csrfKey(secret: string) {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
const formMessage = (user: string, session: string, publication: string) => new TextEncoder().encode(JSON.stringify([user, session, publication]));

/** Bind forms to identity, login session, and a scope string: publication ID for
 * votes, or namespaced editor action/revision. No extra cookie/session store.
 */
export async function formToken(secret: string, user: string, session: string, publication: string): Promise<string> {
  const signature = await crypto.subtle.sign('HMAC', await csrfKey(secret), formMessage(user, session, publication));
  return Array.from(new Uint8Array(signature), b => b.toString(16).padStart(2, '0')).join('');
}

export async function verifyFormToken(token: string, secret: string, user: string, session: string, publication: string): Promise<boolean> {
  if (!/^[a-f0-9]{64}$/.test(token)) return false;
  const bytes = Uint8Array.from(token.match(/../g)!, hex => parseInt(hex, 16));
  return crypto.subtle.verify('HMAC', await csrfKey(secret), bytes, formMessage(user, session, publication));
}
