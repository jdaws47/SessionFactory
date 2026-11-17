import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { JiraTicket } from '../shared/types';

const run = promisify(execFile);

export const JIRA_KEY_RE = /^[A-Z][A-Z0-9]+-\d+$/;
export const ASSIGNED_JQL = 'assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC';

export function parseSearch(stdout: string): JiraTicket[] {
  const data = JSON.parse(stdout) as { success?: boolean; error?: string; issues?: JiraTicket[] };
  if (data.success === false) throw new Error(data.error ?? 'Jira search failed');
  return (data.issues ?? []).map(({ key, summary, status }) => ({ key, summary, status }));
}

/**
 * Read-only Jira access through the existing vida-jira CLI in clean-room/.claude/skills.
 * Uses whatever ATLASSIAN_* or JIRA_* variables the server was started with; it never transitions,
 * comments on, or edits tickets.
 */
export class Jira {
  private assignedCache?: { at: number; tickets: JiraTicket[] };

  constructor(
    private readonly cli: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  get configured(): boolean {
    const has = (a: string, b: string) => !!(this.env[a] || this.env[b]);
    return has('ATLASSIAN_HOST', 'JIRA_HOST') && has('ATLASSIAN_EMAIL', 'JIRA_EMAIL') && has('ATLASSIAN_API_TOKEN', 'JIRA_API_TOKEN');
  }

  get host(): string | undefined {
    return (this.env.ATLASSIAN_HOST || this.env.JIRA_HOST)?.replace(/\/$/, '');
  }

  private async search(jql: string, max = 50): Promise<JiraTicket[]> {
    const { stdout } = await run('python3', [this.cli, '--format', 'json', 'search', jql, '--max-results', String(max)], {
      env: this.env,
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
    }).catch((err: { stdout?: string; message: string }) => {
      if (err.stdout) return { stdout: err.stdout };
      throw err;
    });
    return parseSearch(stdout);
  }

  async assigned(force = false): Promise<JiraTicket[]> {
    if (!force && this.assignedCache && Date.now() - this.assignedCache.at < 60_000) return this.assignedCache.tickets;
    const tickets = await this.search(ASSIGNED_JQL);
    this.assignedCache = { at: Date.now(), tickets };
    return tickets;
  }

  /** Current status and resolution for the given keys (unknown keys are simply absent). */
  async statuses(keys: string[]): Promise<Map<string, { status: string; resolved: boolean }>> {
    const valid = [...new Set(keys.filter((k) => JIRA_KEY_RE.test(k)))];
    const out = new Map<string, { status: string; resolved: boolean }>();
    const lookup = async (keys: string[]) => {
      const list = keys.join(', ');
      const [all, open] = await Promise.all([this.search(`key in (${list})`), this.search(`key in (${list}) AND resolution = Unresolved`)]);
      const openKeys = new Set(open.map((t) => t.key));
      for (const t of all) out.set(t.key, { status: t.status, resolved: !openKeys.has(t.key) });
    };
    for (let i = 0; i < valid.length; i += 50) {
      const chunk = valid.slice(i, i + 50);
      // Jira rejects the whole JQL when one key no longer exists, so fall back to one key at a time.
      await lookup(chunk).catch(() => Promise.all(chunk.map((k) => lookup([k]).catch(() => undefined))));
    }
    return out;
  }
}

/** Does this crate belong to the ticket? By its link, or the key appearing in its session name. */
export function crateMatchesTicket(c: { jiraKey?: string; title?: string }, key: string): boolean {
  if (c.jiraKey === key) return true;
  const word = new RegExp(`(^|[^A-Za-z0-9-])${key}([^0-9]|$)`, 'i');
  return !!c.title && word.test(c.title);
}
