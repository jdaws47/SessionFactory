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

/** Recomputes an automatic label in place; manual and Jira labels stay put. */
export function refreshLabel(crate: Crate, projects: string[] = DEFAULT_JIRA_PROJECTS): void {
  if (crate.labelSource === 'manual') return;
  const key = crate.jiraKey ?? findJiraKey(crate.title, projects) ?? findJiraKey(crate.firstPrompt, projects);
  if (key) {
    crate.jiraKey = key;
    crate.label = key;
    crate.labelSource = 'jira';
    return;
  }
  crate.labelSource = 'auto';
  if (crate.title) crate.label = crate.title;
  else if (crate.firstPrompt) crate.label = `${crate.repo}: ${snippet(crate.firstPrompt, 32)}`;
  else crate.label = `${crate.repo} session`;
}
