import { describe, expect, it } from 'vitest';
import { crateMatchesTicket, Jira, parseSearch } from '../src/server/jira';

describe('Jira CLI output', () => {
  it('keeps key, summary and status from a search', () => {
    const out = JSON.stringify({ success: true, total: 1, issues: [{ key: 'TF-1', summary: 'Do it', status: 'To Do', assignee: 'Someone' }] });
    expect(parseSearch(out)).toEqual([{ key: 'TF-1', summary: 'Do it', status: 'To Do' }]);
  });

  it('surfaces CLI errors', () => {
    expect(() => parseSearch(JSON.stringify({ success: false, error: 'Missing environment variables' }))).toThrow(/Missing/);
  });

  it('is only enabled when host, email and token are all set (either naming)', () => {
    expect(new Jira('cli', {}).configured).toBe(false);
    expect(new Jira('cli', { JIRA_HOST: 'h', JIRA_EMAIL: 'e', JIRA_API_TOKEN: 't' }).configured).toBe(true);
    expect(new Jira('cli', { ATLASSIAN_HOST: 'h', ATLASSIAN_EMAIL: 'e' }).configured).toBe(false);
  });
});

describe('matching tickets to sessions', () => {
  it('matches by detected key or by the key in the session name, but not a longer key', () => {
    expect(crateMatchesTicket({ jiraKey: 'TF-735', label: 'warm runners' }, 'TF-735')).toBe(true);
    expect(crateMatchesTicket({ label: 'tf-735 warm runners' }, 'TF-735')).toBe(true);
    expect(crateMatchesTicket({ label: 'x', title: 'fix TF-735' }, 'TF-735')).toBe(true);
    expect(crateMatchesTicket({ label: 'TF-7350 other' }, 'TF-735')).toBe(false);
    expect(crateMatchesTicket({ label: 'XTF-735' }, 'TF-735')).toBe(false);
  });
});
