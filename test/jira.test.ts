import { describe, expect, it } from 'vitest';
import { Jira, parseSearch } from '../src/server/jira';

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
