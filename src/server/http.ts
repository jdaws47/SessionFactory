import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';

type Params = Record<string, string>;
export type Handler = (body: any, params: Params, query: URLSearchParams) => unknown | Promise<unknown>;
export type SocketHandler = (ws: WebSocket, params: Params, query: URLSearchParams) => void;

interface Route<H> {
  method: string;
  parts: string[];
  handler: H;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.wav': 'audio/wav',
  '.json': 'application/json',
};

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function match(parts: string[], url: string): Params | null {
  const segs = url.split('/').filter(Boolean);
  if (segs.length !== parts.length) return null;
  const params: Params = {};
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].startsWith(':')) params[parts[i].slice(1)] = decodeURIComponent(segs[i]);
    else if (parts[i] !== segs[i]) return null;
  }
  return params;
}

/**
 * Minimal localhost-only HTTP + websocket server. Every request must carry a localhost Host header
 * and, when present, a localhost Origin, so other web pages cannot drive the factory.
 */
export class FactoryServer {
  private routes: Route<Handler>[] = [];
  private sockets: Route<SocketHandler>[] = [];
  private wss = new WebSocketServer({ noServer: true });
  readonly server: http.Server;

  constructor(
    private readonly staticDir: string,
    private readonly allowedHosts: string[],
  ) {
    this.server = http.createServer((req, res) => void this.handle(req, res));
    this.server.on('upgrade', (req, socket, head) => this.upgrade(req, socket, head));
  }

  route(method: string, pattern: string, handler: Handler): void {
    this.routes.push({ method, parts: pattern.split('/').filter(Boolean), handler });
  }

  socket(pattern: string, handler: SocketHandler): void {
    this.sockets.push({ method: 'GET', parts: pattern.split('/').filter(Boolean), handler });
  }

  listen(port: number, host: string): Promise<void> {
    return new Promise((resolve) => this.server.listen(port, host, resolve));
  }

  private allowed(req: http.IncomingMessage): boolean {
    const host = req.headers.host ?? '';
    if (!this.allowedHosts.includes(host)) return false;
    const origin = req.headers.origin;
    return !origin || this.allowedHosts.some((h) => origin === `http://${h}`);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!this.allowed(req)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname.startsWith('/api/')) return this.api(req, res, url);
    this.serveStatic(url.pathname, res);
  }

  private async api(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    for (const r of this.routes) {
      if (r.method !== req.method) continue;
      const params = match(r.parts, url.pathname);
      if (!params) continue;
      try {
        let body: unknown = undefined;
        if (req.method !== 'GET') {
          const chunks: Buffer[] = [];
          for await (const c of req) chunks.push(c as Buffer);
          const text = Buffer.concat(chunks).toString('utf8');
          body = text ? JSON.parse(text) : {};
        }
        const result = await r.handler(body ?? {}, params, url.searchParams);
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result ?? { ok: true }));
      } catch (err) {
        const status = err instanceof HttpError ? err.status : 500;
        res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ error: (err as Error).message }));
      }
      return;
    }
    res.writeHead(404).end('not found');
  }

  private serveStatic(pathname: string, res: http.ServerResponse): void {
    const root = path.resolve(this.staticDir);
    let file = path.resolve(root, `.${decodeURIComponent(pathname)}`);
    if (!file.startsWith(root + path.sep) && file !== root) {
      res.writeHead(404).end();
      return;
    }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, 'index.html');
    if (!fs.existsSync(file)) {
      res.writeHead(503).end('Front end not built yet: run `npm run build`.');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  }

  private upgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const route = this.sockets.map((r) => ({ r, params: match(r.parts, url.pathname) })).find((x) => x.params);
    if (!route || !this.allowed(req)) {
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => route.r.handler(ws, route.params!, url.searchParams));
  }
}
