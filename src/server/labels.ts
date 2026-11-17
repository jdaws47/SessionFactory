import path from 'node:path';
import type { Crate } from '../shared/types';

export const DEFAULT_JIRA_PROJECTS = (process.env.SF_JIRA_PROJECTS ?? 'PORT,TF,BIOBK,VIDA,DQI')
  .split(',')
  .map((p) => p.trim().toUpperCase())
  .filter(Boolean);

export function findJiraKey(text: string | undefined, projects: string[]): string | undefined {
  if (!text) return undefined;
  for (const m of text.matchAll(/\b([A-Z][A-Z0-9]+)-(\d+)\b/g)) {
    if (projects.includes(m[1])) return `${m[1]}-${m[2]}`;
  }
  return undefined;
}

/** Top-level folder under clean-room the session runs in, or "clean-room" for the root. */
export function repoOf(cwd: string, cleanRoot: string): string {
  const rel = path.relative(cleanRoot, cwd);
  return rel === '' ? path.basename(cleanRoot) : rel.split(path.sep)[0];
}

export function isWithin(cwd: string, cleanRoot: string): boolean {
  const rel = path.relative(cleanRoot, path.resolve(cwd));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function snippet(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Recomputes the label in place. Priority: manual > session name (/rename, --name) > Jira key > automatic.
 * The Jira key comes only from the session name.
 */
export function refreshLabel(crate: Crate, projects: string[] = DEFAULT_JIRA_PROJECTS): void {
  // A crate is linked to a ticket only by its session name (sessions started from a ticket are named after it).
  const key = crate.jiraUnlinked ? undefined : findJiraKey(crate.title, projects);
  // Ticket status belongs to the linked ticket; drop it when the link changes or goes away.
  if (key !== crate.jiraKey) crate.jira = undefined;
  crate.jiraKey = key;
  if (crate.labelSource === 'manual') return;
  if (crate.title) {
    crate.label = crate.title;
    crate.labelSource = 'auto';
  } else if (crate.jiraKey) {
    crate.label = crate.jiraKey;
    crate.labelSource = 'jira';
  } else {
    crate.labelSource = 'auto';
    crate.label = crate.firstPrompt ? `${crate.repo}: ${snippet(crate.firstPrompt, 32)}` : `${crate.repo} session`;
  }
}
