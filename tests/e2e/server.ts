import http from 'node:http';
import type { AddressInfo } from 'node:net';

const page = (cookie: string) => `<!doctype html><html><head><title>Test</title>
<script>window.__early = document.cookie;</script></head>
<body><pre id="server">${cookie.replace(/</g, '&lt;')}</pre></body></html>`;

/** Minimal app: /login?u=NAME signs in (HttpOnly sid + readable ui cookie), / echoes the Cookie header. */
export function startServer(): Promise<{ port: number; close: () => void }> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const cookie = req.headers.cookie ?? '';
    if (url.pathname === '/login') {
      const u = url.searchParams.get('u') ?? 'anon';
      res.setHeader('Set-Cookie', [`sid=${u}; Path=/; HttpOnly`, `ui=${u}; Path=/`]);
      const next = url.searchParams.get('next');
      if (next) {
        res.writeHead(302, { Location: next });
        res.end();
        return;
      }
      res.setHeader('content-type', 'text/plain');
      res.end('ok');
      return;
    }
    if (url.pathname === '/whoami') {
      res.setHeader('content-type', 'text/plain');
      res.end(cookie);
      return;
    }
    res.setHeader('content-type', 'text/html');
    res.end(page(cookie));
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ port: (server.address() as AddressInfo).port, close: () => server.close() })),
  );
}
