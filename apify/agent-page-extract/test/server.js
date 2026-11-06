import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

const routes = {
  '/robots.txt': ['text/plain', 'robots.txt'],
  '/docs': ['text/html', 'docs.html'],
  '/docs/next': ['text/html', 'next.html'],
  '/docs/deep': ['text/html', 'deep.html'],
  '/secret': ['text/html', 'secret.html'],
  '/short': ['text/html', 'short.html'],
  '/app': ['text/html', 'shell.html'],
  '/challenge': ['text/html', 'challenge.html'],
};

export function startFixtureServer() {
  const hits = new Map();
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    hits.set(url.pathname, (hits.get(url.pathname) || 0) + 1);
    const route = routes[url.pathname];
    if (!route) {
      response.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><html><head><title>Not found</title></head><body><p>Missing page.</p></body></html>');
      return;
    }
    const body = await readFile(path.join(fixturesDir, route[1]));
    response.writeHead(200, { 'content-type': `${route[0]}; charset=utf-8` });
    response.end(body);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        origin: `http://127.0.0.1:${port}`,
        hits,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}
