import { readFileSync, readdirSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { Digest } from './digest.ts';
import { renderDigest } from './render.ts';

/** Serve a saved snapshot on loopback only; no external calls on page requests. */
export function createDigestServer(digest: Digest): Server {
  const html = renderDigest(digest);
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
  return createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
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
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Not found');
      return;
    }
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; style-src 'self' 'unsafe-inline'; font-src 'self'; base-uri 'none'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(request.method === 'HEAD' ? undefined : html);
  });
}
