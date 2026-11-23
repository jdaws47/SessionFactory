import path from 'node:path';
import type { WebSocket } from 'ws';
import type { Crate, FactoryState, HopperReply, HopperTicket, ImportReply, LabelArchiveReply, ResumeReply, ServerMessage, StartedReply } from '../shared/types';
import { CLAUDE_PROJECTS_DIR, CLEAN_ROOT, DIST_DIR, EVENTS_DIR, HOST, PORT, REGISTRY_FILE, REPO_DIR, RUN_DIR } from './config';
import { FactoryServer, HttpError } from './http';
import { handoffBlocker } from './handoff';
import { scanHistory } from './history';
import { EventIngestor } from './ingest';
import { crateMatchesTicket, Jira, JIRA_KEY_RE } from './jira';
import { DEFAULT_JIRA_PROJECTS, snippet } from './labels';
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
const jira = new Jira(path.join(CLEAN_ROOT, '.claude', 'skills', 'vida-jira', 'atlassian_cli.py'));
const allowedHosts = [`127.0.0.1:${PORT}`, `localhost:${PORT}`, '127.0.0.1:5173', 'localhost:5173'];
const app = new FactoryServer(DIST_DIR, allowedHosts);
const clients = new Set<WebSocket>();

function state(): FactoryState {
  const now = Date.now();
  return {
    now,
    crates: registry.view(now, terminals.liveSlots),
    dockOrder: registry.dockOrder(),
    cleanRoot: CLEAN_ROOT,
    stats: { turnsToday: registry.turnsSince(new Date(now).setHours(0, 0, 0, 0)) },
    features: { terminals: terminalsAvailable, jira: jira.configured, jiraHost: jira.configured ? jira.host : undefined },
  };
}

let broadcastTimer: NodeJS.Timeout | undefined;
function broadcast(): void {
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(() => {
    broadcastTimer = undefined;
    const msg = JSON.stringify({ type: 'state', state: state() } satisfies ServerMessage);
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

/** Whether a crate's factory terminal is running, checked with tmux at the moment it matters. */
async function liveTerminal(c: Crate): Promise<boolean> {
  if (!c.slot) return false;
  await terminals.refresh();
  return terminals.liveSlots.has(c.slot);
}

/**
 * Factory terminals close by themselves when their claude exits (the shell runs `; exit`). When a crate with a
 * terminal moves to storage, check tmux once, shortly after, so the crate stops offering its terminal.
 */
const closing = new Set<string>();
function noticeEndedTerminals(): void {
  for (const c of registry.all()) {
    if (c.zone !== 'storage' || !c.slot || !terminals.liveSlots.has(c.slot) || closing.has(c.slot)) continue;
    const slot = c.slot;
    closing.add(slot);
    setTimeout(() => {
      void terminals.refresh().then((changed) => {
        if (!terminals.liveSlots.has(slot)) closing.delete(slot);
        if (changed) broadcast();
      });
    }, 3000);
  }
}

/** Starts a fresh factory terminal for a new crate; a name becomes the Claude session's name (--name). */
async function startNew(opts: { name?: string; prompt?: string }): Promise<StartedReply> {
  requireTerminals();
  const slot = newSlot();
  const crate = registry.preregister(slot, { name: opts.name }, Date.now());
  await terminals.start(slot, claudeCommand(CLEAN_ROOT, { name: opts.name, prompt: opts.prompt }));
  broadcast();
  return { crateId: crate.id, slot };
}

app.route('GET', '/api/state', () => state());

/** Ends a crate's factory terminal (clean /exit when Claude is idle) and moves the crate to storage. */
async function endSession(crate: Crate): Promise<void> {
  if (!crate.slot || !(await liveTerminal(crate))) return;
  // /exit only once Claude itself is running and idle; before its first hook, scrub-in may still own the terminal.
  const claudeIdle = crate.sessionIds.length > 0 && (crate.zone === 'dock' || crate.zone === 'intake');
  await terminals.end(crate.slot, claudeIdle);
  registry.markEnded(crate.id, Date.now());
  broadcast();
}

app.route('POST', '/api/crates/:id/end', async (_b, { id }) => {
  const crate = crateOr404(id);
  if (!(await liveTerminal(crate))) throw new HttpError(409, 'This crate has no factory terminal to end.');
  await endSession(crate);
});

app.route('POST', '/api/crates/:id/archive', async (body, { id }) => {
  const crate = crateOr404(id);
  // Archive first so the crate heads straight for freight; ending the session (which waits for /exit) follows.
  registry.archive(id, Date.now());
  broadcast();
  if (body.endSession) await endSession(crate);
});
app.route('POST', '/api/crates/:id/unarchive', (_b, { id }) => {
  crateOr404(id);
  registry.unarchive(id, Date.now());
});
/** Renames the Claude session itself (/rename in its factory terminal); the crate follows the session name. */
app.route('POST', '/api/crates/:id/rename', async (body, { id }) => {
  const crate = crateOr404(id);
  const name = String(body.name ?? '').replace(/\s+/g, ' ').trim();
  if (!name) throw new HttpError(400, 'A name is needed.');
  if (!(await liveTerminal(crate))) throw new HttpError(409, 'This session runs outside the factory: rename it in its own terminal with /rename.');
  if (!crate.sessionIds.length) throw new HttpError(409, "Claude hasn't started in this terminal yet; rename it once it has.");
  if (crate.zone !== 'dock' && crate.zone !== 'intake') throw new HttpError(409, 'Claude is busy in this session; rename it once it is waiting for you.');
  await terminals.sendLine(crate.slot!, `/rename ${name}`);
  registry.setTitle(id, name);
});
app.route('POST', '/api/crates/:id/unlink-jira', (_b, { id }) => {
  crateOr404(id);
  registry.unlinkJira(id);
});
app.route('POST', '/api/crates/:id/dismiss-returned', (_b, { id }) => {
  crateOr404(id);
  registry.dismissReturned(id);
});
app.route('POST', '/api/labels/archive', (body): LabelArchiveReply => ({ archived: registry.archiveLabel(String(body.label ?? ''), Date.now()) }));

app.route('POST', '/api/terminals', (body) =>
  startNew({ name: body.label ? String(body.label).trim() : undefined, prompt: body.prompt ? String(body.prompt) : undefined }),
);

/** Resume (or move) a crate's conversation into a new factory terminal. Refused while it may still be open elsewhere. */
app.route('POST', '/api/crates/:id/resume', async (_b, { id }): Promise<ResumeReply> => {
  requireTerminals();
  const crate = crateOr404(id);
  if (await liveTerminal(crate)) return { slot: crate.slot };
  // liveTerminal() was just checked above, so a crate with a slot here has lost its factory terminal.
  const blocked = handoffBlocker(crate, isAlive, { factoryTerminalGone: !!crate.slot });
  if (blocked) throw new HttpError(409, blocked);
  const sessionId = crate.sessionIds[crate.sessionIds.length - 1];
  const slot = newSlot();
  if (crate.archived) registry.unarchive(id, Date.now());
  registry.attachSlot(id, slot);
  registry.markResuming(id, Date.now());
  await terminals.start(slot, claudeCommand(CLEAN_ROOT, { resume: sessionId }));
  broadcast();
  return { slot };
});

/** Start a fresh session under the same name, primed with what the old one last said. */
app.route('POST', '/api/crates/:id/continue', async (_b, { id }) => {
  const crate = crateOr404(id);
  const parts = [`Continuing work on ${crate.label}.`];
  if (crate.lastMessage) parts.push(`The previous session ended with: "${snippet(crate.lastMessage, 500)}"`);
  return startNew({ name: crate.title ?? (crate.labelSource === 'manual' ? crate.label : undefined), prompt: parts.join(' ') });
});

function requireJira(): void {
  if (!jira.configured) throw new HttpError(501, 'Jira is not configured: start the server from a shell that has run scrub-in (JIRA_* variables).');
}

app.route('GET', '/api/jira/assigned', async (_b, _p, query): Promise<HopperReply> => {
  requireJira();
  const tickets = await jira.assigned(query.get('refresh') === '1');
  const crates = registry.all();
  return {
    tickets: tickets.map((t): HopperTicket => {
      const matching = crates.filter((c) => crateMatchesTicket(c, t.key));
      const live = matching.filter((c) => !c.archived).sort((a, b) => b.updatedAt - a.updatedAt)[0];
      const archived = matching.filter((c) => c.archived).sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0))[0];
      return { ...t, liveCrateId: live?.id, archivedCrateId: live ? undefined : archived?.id };
    }),
  };
});

/** Turn a Jira ticket into a crate: a factory terminal primed with the ticket. */
app.route('POST', '/api/jira/:key/start', async (_b, { key }) => {
  requireJira();
  if (!JIRA_KEY_RE.test(key)) throw new HttpError(400, 'not a Jira key');
  const ticket = (await jira.assigned()).find((t) => t.key === key);
  const prompt = `Let's work on ${key}${ticket ? `: ${ticket.summary}` : ''}. Start by pulling up the ticket with /vida-jira ${key}.`;
  return startNew({ name: key, prompt });
});

/** Read-only status poll; drives the "ready to ship" and "returned" markers. Never archives anything. */
async function pollJira(): Promise<void> {
  if (!jira.configured) return;
  const crates = registry.all().filter((c) => c.jiraKey);
  if (!crates.length) return;
  try {
    const statuses = await jira.statuses(crates.map((c) => c.jiraKey!));
    const now = Date.now();
    for (const c of crates) {
      const st = statuses.get(c.jiraKey!);
      if (st) registry.setJira(c.id, st, now);
    }
  } catch (err) {
    console.warn(`Jira poll failed: ${(err as Error).message}`);
  }
}

/** Brings sessions from before the factory existed (or run without hooks) into the Warehouse. Reads ~/.claude only. */
async function importHistory(): Promise<ImportReply> {
  const sessions = await scanHistory(CLAUDE_PROJECTS_DIR, CLEAN_ROOT, DEFAULT_JIRA_PROJECTS);
  const added = registry.importPast(sessions, Date.now() - 30 * 60_000);
  return { added, scanned: sessions.length };
}

app.route('POST', '/api/history/import', () => importHistory());

app.socket('/ws', async (ws) => {
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));
  // A page (re)load catches up: any hook event a watcher missed, and terminals closed while nobody was looking.
  ingestor.drain();
  await terminals.refresh();
  ws.send(JSON.stringify({ type: 'state', state: state() } satisfies ServerMessage));
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
  term.onExit(() => {
    ws.close();
    void terminals.refresh().then((changed) => changed && broadcast());
  });
  ws.on('message', (raw) => {
    try {
      // A TermFrame, unless something else is talking to the socket: check before use.
      const msg = JSON.parse(raw.toString()) as Partial<Record<'t' | 'd' | 'c' | 'r', unknown>>;
      if (msg.t === 'i' && typeof msg.d === 'string') term.write(msg.d);
      else if (msg.t === 'r') term.resize(Math.max(20, Math.min(500, Number(msg.c) | 0)), Math.max(5, Math.min(200, Number(msg.r) | 0)));
    } catch {
      // ignore malformed frames
    }
  });
  ws.on('close', () => term.kill());
});

/** Ends crates whose Claude has gone, unless their factory terminal still runs one (see Registry.checkLiveness). */
async function checkLiveness(): Promise<void> {
  const running = new Map<string, number>();
  for (const c of registry.all()) {
    if (!c.slot || !c.pid || c.zone === 'storage' || isAlive(c.pid) || !terminals.liveSlots.has(c.slot)) continue;
    const pid = await terminals.claudePid(c.slot);
    if (pid) running.set(c.slot, pid);
  }
  registry.checkLiveness(isAlive, Date.now(), running);
}

registry.onChange(() => {
  broadcast();
  noticeEndedTerminals();
});
ingestor.start();
await terminals.refresh();
// No hook fires when a session dies without ending (crash, terminal closed), so this one check stays a poll.
const liveness = setInterval(() => void checkLiveness(), 60_000);
const jiraPoll = setInterval(() => void pollJira(), 5 * 60_000);
setTimeout(() => void pollJira(), 5000);

await app.listen(PORT, HOST);
void importHistory()
  .then(({ added }) => added && console.log(`  imported ${added} past session(s) into the Warehouse`))
  .catch((err) => console.warn(`  history import failed: ${(err as Error).message}`));
console.log(`Session Factory running at http://${HOST}:${PORT}`);
if (!terminalsAvailable) console.log('  tmux not found: factory terminals disabled');
if (!jira.configured) console.log('  Jira not configured (no JIRA_*/ATLASSIAN_* env): run scrub-in in this shell first to enable the ticket hopper');

function shutdown(): void {
  clearInterval(liveness);
  clearInterval(jiraPoll);
  ingestor.stop();
  registry.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
