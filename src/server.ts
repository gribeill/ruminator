import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Paper } from './arxiv.ts';
import type { Digest } from './digest.ts';
import { paperAnchor, type Votes, type VoteValue } from './feedback.ts';
import { renderDigest } from './render.ts';

export interface VoteStore {
  read(): Votes;
  write(paper: Paper, value: VoteValue): void;
}

/** Limit local form submissions without buffering unbounded request bodies. */
function readForm(request: IncomingMessage): Promise<URLSearchParams> {
  return new Promise((resolve, reject) => {
    let body = '', bytes = 0;
    request.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 2048) { reject(new Error('Vote form too large')); return; }
      body += chunk.toString('utf8');
    });
    request.on('end', () => resolve(new URLSearchParams(body)));
    request.on('error', reject);
  });
}

/** Saved digest data never changes; only current vote controls are rendered afresh.
 * Vote handlers persist state only: page requests never load models or rank papers.
 */
export function createDigestServer(digest: Digest, votes?: VoteStore): Server {
  const html = renderDigest(digest);
  const csrfToken = randomBytes(32).toString('hex');
  const byId = new Map(digest.papers.map(paper => [paper.id, paper]));
  // Serve installed assets locally so math also works without internet or a CDN.
  const dist = new URL('.', import.meta.resolve('katex'));
  const assets = new Map([
    ['/assets/katex/katex.min.css', {
      body: readFileSync(new URL('katex.min.css', dist)), type: 'text/css; charset=utf-8',
    }],
    ...readdirSync(new URL('fonts/', dist)).map(name => [
      `/assets/katex/fonts/${name}`, {
        body: readFileSync(new URL(`fonts/${name}`, dist)),
        type: name.endsWith('.woff2') ? 'font/woff2' : name.endsWith('.woff') ? 'font/woff' : 'font/ttf',
      },
    ] as const),
  ]);
  const server = createServer((request, response) => {
    const send = (status: number, message: string) => {
      response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(message);
    };
    const handle = async () => {
      const port = (server.address() as AddressInfo).port;
      const host = request.headers.host;
      // Prevent DNS rebinding from exposing local controls under an attacker hostname.
      if (!host || ![`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(host)) {
        send(403, 'Loopback host required'); return;
      }
      const path = new URL(request.url ?? '/', 'http://localhost').pathname;
      if (path === '/vote' && request.method === 'POST' && votes) {
        if (request.headers.origin && request.headers.origin !== `http://${host}`) { send(403, 'Invalid origin'); return; }
        if (!/^application\/x-www-form-urlencoded(?:;|$)/i.test(request.headers['content-type'] ?? '')) {
          send(415, 'Expected a vote form'); return;
        }
        let form: URLSearchParams;
        try { form = await readForm(request); }
        catch { send(413, 'Vote form could not be read or is too large'); return; }
        if (form.get('token') !== csrfToken) { send(403, 'Invalid form token'); return; }
        if ([...form.keys()].length !== 3 || ['paper', 'value', 'token'].some(key => form.getAll(key).length !== 1)) {
          send(400, 'Invalid vote form'); return;
        }
        const paper = byId.get(form.get('paper') ?? '');
        const value = form.get('value');
        if (!paper || !['-1', '0', '1'].includes(value ?? '')) { send(400, 'Invalid paper or vote'); return; }
        votes.write(paper, Number(value) as VoteValue);
        response.writeHead(303, { Location: `/#${encodeURIComponent(paperAnchor(paper.id))}`, 'Cache-Control': 'no-store' });
        response.end();
        return;
      }
      const asset = assets.get(path);
      if (asset && (request.method === 'GET' || request.method === 'HEAD')) {
        response.writeHead(200, {
          'Content-Type': asset.type, 'Cache-Control': 'public, max-age=3600',
          'X-Content-Type-Options': 'nosniff',
        });
        response.end(request.method === 'HEAD' ? undefined : asset.body);
        return;
      }
      if (path !== '/' || (request.method !== 'GET' && request.method !== 'HEAD')) {
        send(404, 'Not found'); return;
      }
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'none'; style-src 'self' 'unsafe-inline'; font-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
        'X-Content-Type-Options': 'nosniff',
      });
      const page = votes ? renderDigest(digest, { votes: votes.read(), csrfToken }) : html;
      response.end(request.method === 'HEAD' ? undefined : page);
    };
    void handle().catch(() => { if (!response.headersSent) send(500, 'Local request failed'); else response.end(); });
  });
  return server;
}
