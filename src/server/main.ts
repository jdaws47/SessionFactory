import type { WebSocket } from 'ws';
import type { FactoryState } from '../shared/types';
import { CLEAN_ROOT, DIST_DIR, EVENTS_DIR, HOST, PORT, REGISTRY_FILE } from './config';
import { FactoryServer, HttpError } from './http';
import { EventIngestor } from './ingest';
import { Registry } from './registry';

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const registry = new Registry(REGISTRY_FILE, CLEAN_ROOT);
const ingestor = new EventIngestor(EVENTS_DIR, registry);
const allowedHosts = [`127.0.0.1:${PORT}`, `localhost:${PORT}`, '127.0.0.1:5173', 'localhost:5173'];
const app = new FactoryServer(DIST_DIR, allowedHosts);
const clients = new Set<WebSocket>();

function state(): FactoryState {
  const now = Date.now();
  return { now, crates: registry.view(now), cleanRoot: CLEAN_ROOT, features: { terminals: false, jira: false } };
}

let broadcastTimer: NodeJS.Timeout | undefined;
function broadcast(): void {
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(() => {
    broadcastTimer = undefined;
    const msg = JSON.stringify({ type: 'state', state: state() });
    for (const ws of clients) ws.send(msg);
  }, 80);
}

function crateOr404(id: string) {
  const crate = registry.get(id);
  if (!crate) throw new HttpError(404, 'no such crate');
  return crate;
}

app.route('GET', '/api/state', () => state());
app.route('POST', '/api/crates/:id/archive', (_b, { id }) => {
  crateOr404(id);
  registry.archive(id, Date.now());
});
app.route('POST', '/api/crates/:id/unarchive', (_b, { id }) => {
  crateOr404(id);
  registry.unarchive(id, Date.now());
});
app.route('POST', '/api/crates/:id/label', (body, { id }) => {
  crateOr404(id);
  registry.setLabel(id, String(body.label ?? ''));
});
app.route('POST', '/api/crates/:id/dismiss-returned', (_b, { id }) => {
  crateOr404(id);
  registry.dismissReturned(id);
});
app.route('POST', '/api/labels/archive', (body) => ({ archived: registry.archiveLabel(String(body.label ?? ''), Date.now()) }));

app.socket('/ws', (ws) => {
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));
  ws.send(JSON.stringify({ type: 'state', state: state() }));
});

registry.onChange(broadcast);
ingestor.start();
const liveness = setInterval(() => registry.checkLiveness(isAlive, Date.now()), 5000);
const tick = setInterval(broadcast, 30_000);

await app.listen(PORT, HOST);
console.log(`Session Factory running at http://${HOST}:${PORT}`);

function shutdown(): void {
  clearInterval(liveness);
  clearInterval(tick);
  ingestor.stop();
  registry.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
