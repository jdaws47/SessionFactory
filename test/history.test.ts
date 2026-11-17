import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { readSession, scanHistory } from '../src/server/history';
import { Registry } from '../src/server/registry';
import { CLEAN_ROOT } from './helpers';

const TMP = path.join(import.meta.dirname, '.tmp', 'history');
const PROJECTS = path.join(TMP, 'projects');
const PROJECTS_LIST = ['TF', 'PORT'];

function transcript(name: string, records: unknown[]): string {
  const dir = path.join(PROJECTS, '-work-clean-room');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.jsonl`);
  fs.writeFileSync(file, records.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n'));
  return file;
}

beforeEach(() => fs.rmSync(TMP, { recursive: true, force: true }));

describe('reading past sessions', () => {
  it('keeps metadata only: id, cwd, latest custom title, time span, and a Jira key from the first real prompt', async () => {
    const file = transcript('s-1', [
      { type: 'user', sessionId: 's-1', cwd: `${CLEAN_ROOT}/cerebrum`, timestamp: '2026-11-01T10:00:00Z', message: { content: '<task-notification>TF-9</task-notification>' } },
      { type: 'user', sessionId: 's-1', cwd: `${CLEAN_ROOT}/cerebrum`, timestamp: '2026-11-01T10:01:00Z', message: { content: [{ type: 'text', text: 'pick up TF-735 please' }] } },
      { type: 'custom-title', sessionId: 's-1', customTitle: 'old' },
      { type: 'custom-title', sessionId: 's-1', customTitle: 'warm runners' },
      { type: 'assistant', sessionId: 's-1', timestamp: '2026-11-01T12:00:00Z', message: { content: 'secret reply' } },
      'not json',
    ]);
    const s = await readSession(file, PROJECTS_LIST);
    expect(s).toEqual({
      sessionId: 's-1',
      cwd: `${CLEAN_ROOT}/cerebrum`,
      title: 'warm runners',
      jiraKey: 'TF-735',
      startedAt: Date.parse('2026-11-01T10:00:00Z'),
      endedAt: Date.parse('2026-11-01T12:00:00Z'),
    });
    expect(JSON.stringify(s)).not.toContain('secret');
  });

  it('only returns sessions that ran inside clean-room', async () => {
    transcript('in', [{ type: 'user', cwd: CLEAN_ROOT, timestamp: '2026-11-01T10:00:00Z', message: { content: 'hi' } }]);
    transcript('out', [{ type: 'user', cwd: '/somewhere/else', timestamp: '2026-11-01T10:00:00Z', message: { content: 'hi' } }]);
    const found = await scanHistory(PROJECTS, CLEAN_ROOT, PROJECTS_LIST);
    expect(found.map((s) => s.sessionId)).toEqual(['in']);
  });
});

describe('importing into the warehouse', () => {
  it('adds unknown, quiet sessions as archived crates and skips known or recently active ones', () => {
    const reg = new Registry(path.join(TMP, 'registry.json'), CLEAN_ROOT);
    reg.ingest({ at: 1, sessionId: 'known', cwd: CLEAN_ROOT, kind: 'start' });
    const base = { cwd: CLEAN_ROOT, startedAt: 100, endedAt: 200 };
    const added = reg.importPast(
      [
        { ...base, sessionId: 'known' },
        { ...base, sessionId: 'old', title: 'flaky-qa-tests' },
        { ...base, sessionId: 'busy', endedAt: 5_000 },
      ],
      1_000,
    );
    expect(added).toBe(1);
    const imported = reg.all().find((c) => c.sessionIds.includes('old'))!;
    expect(imported).toMatchObject({ archived: true, zone: 'storage', label: 'flaky-qa-tests' });
    expect(reg.importPast([{ ...base, sessionId: 'old' }], 1_000)).toBe(0);
    reg.close();
  });
});
