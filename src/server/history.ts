import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { findJiraKey, isWithin } from './labels';
import { isSyntheticPrompt } from './machine';

/** Metadata of a past Claude Code session. Conversation text is read only to spot a Jira key and is never kept. */
export interface PastSession {
  sessionId: string;
  cwd: string;
  title?: string;
  jiraKey?: string;
  startedAt: number;
  endedAt: number;
}

function promptText(record: { message?: { content?: unknown } }): string | undefined {
  const content = record.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const text = content.find((b) => b && typeof b === 'object' && (b as { type?: string }).type === 'text') as { text?: string } | undefined;
    return text?.text;
  }
  return undefined;
}

/** Reads one transcript (.jsonl) line by line and keeps only session metadata. */
export async function readSession(file: string, jiraProjects: string[]): Promise<PastSession | null> {
  let sessionId = path.basename(file, '.jsonl');
  let cwd: string | undefined;
  let title: string | undefined;
  let jiraKey: string | undefined;
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
    if (!jiraKey && r.type === 'user' && !r.isMeta && !r.isSidechain) {
      const text = promptText(r);
      if (text && !isSyntheticPrompt(text)) jiraKey = findJiraKey(text, jiraProjects);
    }
  }
  if (!cwd || !Number.isFinite(startedAt)) return null;
  return { sessionId, cwd, title, jiraKey: jiraKey ?? findJiraKey(title, jiraProjects), startedAt, endedAt };
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
