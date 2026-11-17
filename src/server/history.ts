import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { findJiraKey, isWithin } from './labels';

/** Metadata of a past Claude Code session. Conversation text is never read for content or kept. */
export interface PastSession {
  sessionId: string;
  cwd: string;
  title?: string;
  jiraKey?: string;
  startedAt: number;
  endedAt: number;
}

/** Reads one transcript (.jsonl) line by line and keeps only session metadata. */
export async function readSession(file: string, jiraProjects: string[]): Promise<PastSession | null> {
  let sessionId = path.basename(file, '.jsonl');
  let cwd: string | undefined;
  let title: string | undefined;
  let startedAt = Infinity;
  let endedAt = 0;

  const lines = readline.createInterface({ input: fs.createReadStream(file, 'utf8'), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line) continue;
    let r: Record<string, any>;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof r.sessionId === 'string') sessionId = r.sessionId;
    if (r.type === 'custom-title' && typeof r.customTitle === 'string') title = r.customTitle;
    if (!cwd && typeof r.cwd === 'string') cwd = r.cwd;
    if (typeof r.timestamp === 'string') {
      const t = Date.parse(r.timestamp);
      if (Number.isFinite(t)) {
        startedAt = Math.min(startedAt, t);
        endedAt = Math.max(endedAt, t);
      }
    }
  }
  if (!cwd || !Number.isFinite(startedAt)) return null;
  return { sessionId, cwd, title, jiraKey: findJiraKey(title, jiraProjects), startedAt, endedAt };
}

/** Past sessions run inside clean-room, from the transcripts in ~/.claude/projects (top-level files only). */
export async function scanHistory(projectsDir: string, cleanRoot: string, jiraProjects: string[]): Promise<PastSession[]> {
  if (!fs.existsSync(projectsDir)) return [];
  const out: PastSession[] = [];
  for (const dir of fs.readdirSync(projectsDir, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const full = path.join(projectsDir, dir.name);
    for (const f of fs.readdirSync(full)) {
      if (!f.endsWith('.jsonl')) continue;
      const session = await readSession(path.join(full, f), jiraProjects).catch(() => null);
      if (session && isWithin(session.cwd, cleanRoot)) out.push(session);
    }
  }
  return out;
}
