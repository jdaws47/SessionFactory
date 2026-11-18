import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { FactoryServer } from '../src/server/http';

const PORT = 45000 + Math.floor(Math.random() * 1000);
const HOST = `127.0.0.1:${PORT}`;
const STATIC = path.join(import.meta.dirname, '.tmp', 'http-static');
let server: FactoryServer | undefined;

async function start(): Promise<FactoryServer> {
  fs.mkdirSync(STATIC, { recursive: true });
  fs.writeFileSync(path.join(STATIC, 'index.html'), 'ok');
  server = new FactoryServer(STATIC, [HOST]);
  server.route('GET', '/api/ping', () => ({ pong: true }));
  server.socket('/ws/term/:slot', (ws) => ws.send('hi'));
  await server.listen(PORT, '127.0.0.1');
  return server;
}

function get(urlPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path: urlPath, headers: { host: HOST } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    }).on('error', reject);
  });
}

afterEach(() => new Promise<void>((resolve) => (server ? server.server.close(() => resolve()) : resolve())));

describe('localhost server hardening', () => {
  it('a malformed URL is refused instead of crashing the server', async () => {
    await start();
    expect(await get('/%E0')).toBe(400);
    expect(await get('/api/ping/%E0')).toBe(404);
    expect(await get('/api/ping')).toBe(200);
  });

  it('a websocket from another origin, or with a malformed path, or sending a bad frame, never crashes it', async () => {
    await start();
    const refused = (url: string, origin?: string) =>
      new Promise<boolean>((resolve) => {
        const ws = new WebSocket(url, { headers: { host: HOST, ...(origin ? { origin } : {}) } });
        ws.on('open', () => resolve(false));
        ws.on('error', () => resolve(true));
      });
    expect(await refused(`ws://127.0.0.1:${PORT}/ws/term/%E0`, 'http://evil.example')).toBe(true);
    expect(await refused(`ws://127.0.0.1:${PORT}/ws/term/%E0`)).toBe(true);
    // A raw frame with a reserved opcode: a protocol error on the server's socket.
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/term/sf-1`, { headers: { host: HOST } });
    await new Promise((resolve) => ws.on('open', resolve));
    (ws as unknown as { _socket: { write(b: Buffer): void } })._socket.write(Buffer.from([0x83, 0x80, 0, 0, 0, 0]));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await get('/api/ping')).toBe(200);
  });
});
