// Local fixture site server for the QA test matrix.
//
// Exists so the test matrix never touches production. By default it mirrors the
// committed working tree exactly, the way GitHub Pages serves it, so a "healthy
// fixture" run exercises the real pages, the real assets and the real sitemap.
// Individual cases then inject exactly one defect through the overrides map:
//
//   overrides.set('/about/', null)                 -> force a 404
//   overrides.set('/about/', { status: 301, ... }) -> force a redirect
//   overrides.set('/sitemap.xml', { body })        -> serve mutated bytes
//   overrides.set('/x/', (hit) => hit < 2 ? null : undefined)
//                                                  -> stale for two hits, then
//                                                     the committed bytes, which
//                                                     is how a CDN edge catching
//                                                     up is simulated
//
// It also records every request method it actually receives. That turns "the
// browser is GET/HEAD only" into something a test can prove from the server
// side — if interception ever regressed, a POST would show up here.
//
// Bound to loopback only, and it never writes to the working tree.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.xml': 'application/xml',
  '.txt': 'text/plain; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

function contentTypeFor(filePath) {
  return CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

/** Resolve a request route to a file inside `root`, refusing traversal. */
function resolveOnDisk(root, route) {
  const relative = route.endsWith('/') ? `${route.slice(1)}index.html` : route.slice(1);
  const resolved = path.resolve(root, relative);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) return null;
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return null;
  return resolved;
}

export function startFixtureServer(overrides = new Map(), { root } = {}) {
  if (!root) throw new Error('qa-fixture-server: a root directory is required');
  const received = [];
  const hits = new Map();
  const server = http.createServer((request, response) => {
    let route;
    try {
      route = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
    } catch {
      response.writeHead(400).end();
      return;
    }

    const notFound = () => {
      response.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><title>404</title><h1>Not found</h1>');
    };

    received.push({ method: request.method, url: request.url });

    if (overrides.has(route)) {
      const raw = overrides.get(route);
      const hit = hits.get(route) ?? 0;
      hits.set(route, hit + 1);
      // A function override is evaluated per request, so a case can model an
      // edge that is stale now and correct a moment later. Returning undefined
      // hands the route back to the on-disk (correct) bytes.
      const entry = typeof raw === 'function' ? raw(hit) : raw;
      if (entry === null) {
        notFound();
        return;
      }
      if (entry !== undefined) {
        const headers = { 'content-type': entry.contentType ?? 'text/html; charset=utf-8', ...(entry.headers ?? {}) };
        if (entry.location) headers.location = entry.location;
        response.writeHead(entry.status ?? 200, headers);
        response.end(entry.status >= 300 && entry.status < 400 ? '' : entry.body ?? '');
        return;
      }
    }

    const file = resolveOnDisk(root, route);
    if (!file) {
      notFound();
      return;
    }
    let body = fs.readFileSync(file);
    // The committed sitemap hardcodes the production origin; rewriting it to
    // the fixture origin lets the sitemap/public-route agreement check run
    // locally without editing the committed file.
    if (file.endsWith('.xml') && request.headers.host) {
      body = Buffer.from(String(body).replaceAll('https://aprasa.org', `http://${request.headers.host}`));
    }
    response.writeHead(200, { 'content-type': contentTypeFor(file) });
    response.end(body);
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        origin: `http://127.0.0.1:${port}`,
        overrides,
        received,
        methodsReceived: () => [...new Set(received.map((entry) => entry.method))],
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

/** Read the committed bytes a route serves, for cases that mutate a real file. */
export function readRouteBytes(root, route) {
  const file = resolveOnDisk(root, route);
  return file ? fs.readFileSync(file) : null;
}
