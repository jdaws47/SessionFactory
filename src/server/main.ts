import path from 'node:path';
import type { WebSocket } from 'ws';
import type { Crate, FactoryState } from '../shared/types';
import { CLEAN_ROOT, DIST_DIR, EVENTS_DIR, HOST, PORT, REGISTRY_FILE, REPO_DIR, RUN_DIR } from './config';
import { FactoryServer, HttpError } from './http';
import { EventIngestor } from './ingest';
import { snippet } from './labels';
import { Registry } from './registry';
import { claudeCommand, newSlot, SLOT_RE, Terminals } from './terminals';

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
const terminalsAvailable = await Terminals.available();
const terminals = new Terminals(path.join(RUN_DIR, 'tmux.sock'), path.join(REPO_DIR, 'tmux.conf'), CLEAN_ROOT);
const allowedHosts = [`127.0.0.1:${PORT}`, `localhost:${PORT}`, '127.0.0.1:5173', 'localhost:5173'];
const app = new FactoryServer(DIST_DIR, allowedHosts);
const clients = new Set<WebSocket>();

function state(): FactoryState {
  const now = Date.now();
  return {
    now,
    crates: registry.view(now, terminals.liveSlots),
    cleanRoot: CLEAN_ROOT,
    features: { terminals: terminalsAvailable, jira: false },
  };
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

function crateOr404(id: string): Crate {
  const crate = registry.get(id);
  if (!crate) throw new HttpError(404, 'no such crate');
  return crate;
}

function requireTerminals(): void {
  if (!terminalsAvailable) throw new HttpError(501, 'tmux is not installed');
}

function liveTerminal(c: Crate): boolean {
  return !!c.slot && terminals.liveSlots.has(c.slot);
}

/** Starts a fresh factory terminal for a new crate. */
async function startNew(opts: { label?: string; jiraKey?: string; prompt?: string }): Promise<{ crateId: string; slot: string }> {
  requireTerminals();
  const slot = newSlot();
  const crate = registry.preregister(slot, { label: opts.label, jiraKey: opts.jiraKey }, Date.now());
  await terminals.start(slot, claudeCommand(CLEAN_ROOT, { prompt: opts.prompt }));
  broadcast();
  return { crateId: crate.id, slot };
}

app.route('GET', '/api/state', () => state());

app.route('POST', '/api/crates/:id/archive', async (body, { id }) => {
  const crate = crateOr404(id);
  if (body.endSession && crate.slot && liveTerminal(crate)) await terminals.kill(crate.slot);
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

app.route('POST', '/api/terminals', (body) =>
  startNew({ label: body.label ? String(body.label) : undefined, prompt: body.prompt ? String(body.prompt) : undefined }),
);

/** Resume a crate's conversation in a new factory terminal. Refused while it still runs elsewhere. */
app.route('POST', '/api/crates/:id/resume', async (_b, { id }) => {
  requireTerminals();
  const crate = crateOr404(id);
  if (liveTerminal(crate)) return { slot: crate.slot };
  if (crate.pid && crate.zone !== 'storage' && isAlive(crate.pid)) {
    throw new HttpError(409, 'This session is still running in another terminal.');
  }
  const sessionId = crate.sessionIds[crate.sessionIds.length - 1];
  if (!sessionId) throw new HttpError(409, 'This crate has no session to resume yet.');
  const slot = newSlot();
  if (crate.archived) registry.unarchive(id, Date.now());
  registry.attachSlot(id, slot);
  await terminals.start(slot, claudeCommand(CLEAN_ROOT, { resume: sessionId }));
  broadcast();
  return { slot };
});

/** Start a fresh session under the same label, primed with what the old one last said. */
app.route('POST', '/api/crates/:id/continue', async (_b, { id }) => {
  const crate = crateOr404(id);
  const parts = [`Continuing work on ${crate.jiraKey && crate.jiraKey !== crate.label ? `${crate.label} (${crate.jiraKey})` : crate.label}.`];
  if (crate.lastMessage) parts.push(`The previous session ended with: "${snippet(crate.lastMessage, 500)}"`);
  return startNew({ label: crate.labelSource === 'manual' || crate.title ? crate.label : undefined, jiraKey: crate.jiraKey, prompt: parts.join(' ') });
});

app.socket('/ws', (ws) => {
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));
  ws.send(JSON.stringify({ type: 'state', state: state() }));
});

app.socket('/ws/term/:slot', (ws, { slot }, query) => {
  if (!terminalsAvailable || !SLOT_RE.test(slot) || !terminals.liveSlots.has(slot)) {
    ws.close(4004, 'no such terminal');
    return;
  }
  const cols = Math.min(500, Math.max(20, Number(query.get('cols')) || 120));
  const rows = Math.min(200, Math.max(5, Number(query.get('rows')) || 32));
  const term = terminals.attach(slot, cols, rows);
  term.onData((d) => ws.readyState === ws.OPEN && ws.send(d));
  term.onExit(() => ws.close());
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.t === 'i' && typeof msg.d === 'string') term.write(msg.d);
      else if (msg.t === 'r') term.resize(Math.max(20, Math.min(500, msg.c | 0)), Math.max(5, Math.min(200, msg.r | 0)));
    } catch {
      // ignore malformed frames
    }
  });
  ws.on('close', () => term.kill());
});

registry.onChange(broadcast);
ingestor.start();
await terminals.refresh();
const liveness = setInterval(() => registry.checkLiveness(isAlive, Date.now()), 5000);
const slotWatch = setInterval(() => void terminals.refresh().then((changed) => changed && broadcast()), 2000);
const tick = setInterval(broadcast, 30_000);

await app.listen(PORT, HOST);
console.log(`Session Factory running at http://${HOST}:${PORT}${terminalsAvailable ? '' : ' (tmux not found: terminals disabled)'}`);

function shutdown(): void {
  clearInterval(liveness);
  clearInterval(slotWatch);
  clearInterval(tick);
  ingestor.stop();
  registry.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
