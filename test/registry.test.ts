import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Registry } from '../src/server/registry';
import { CLEAN_ROOT, ev } from './helpers';

const TMP = path.join(import.meta.dirname, '.tmp', 'registry');
const FILE = path.join(TMP, 'registry.json');
const DAY = 24 * 3600 * 1000;

let reg: Registry;

beforeEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  reg = new Registry(FILE, CLEAN_ROOT);
});

afterEach(() => reg.close());

describe('session linking', () => {
  it('ignores sessions outside clean-room', () => {
    expect(reg.ingest(ev({ kind: 'start', cwd: '/home/someone/elsewhere' }))).toBe(false);
    expect(reg.ingest(ev({ kind: 'start', cwd: '/work/clean-room-other' }))).toBe(false);
    expect(reg.all()).toHaveLength(0);
  });

  it('keeps one crate per session id', () => {
    reg.ingest(ev({ kind: 'start', sessionId: 'a' }));
    reg.ingest(ev({ kind: 'prompt', sessionId: 'a', prompt: 'x' }));
    reg.ingest(ev({ kind: 'start', sessionId: 'b' }));
    expect(reg.all()).toHaveLength(2);
  });

  it('/clear in the same process continues the same crate', () => {
    reg.ingest(ev({ kind: 'prompt', sessionId: 'a', pid: 42, prompt: 'x' }));
    reg.ingest(ev({ kind: 'end', sessionId: 'a', pid: 42, reason: 'clear' }));
    reg.ingest(ev({ kind: 'start', sessionId: 'b', pid: 42, source: 'clear' }));
    expect(reg.all()).toHaveLength(1);
    expect(reg.all()[0].sessionIds).toEqual(['a', 'b']);
  });

  it('links events from a factory terminal slot to its pre-registered crate', () => {
    const crate = reg.preregister('sf-1', { label: 'PORT-9', jiraKey: 'PORT-9' }, 1000);
    reg.ingest(ev({ kind: 'start', sessionId: 'z', slot: 'sf-1' }));
    expect(reg.all()).toHaveLength(1);
    expect(reg.get(crate.id)?.sessionIds).toEqual(['z']);
    expect(reg.get(crate.id)?.label).toBe('PORT-9');
  });
});

describe('factory terminals started outside the app', () => {
  it('a session from an unknown slot gets a crate that remembers the slot', () => {
    reg.ingest(ev({ kind: 'start', sessionId: 'q', slot: 'sf-abc123' }));
    expect(reg.findBySlot('sf-abc123')?.sessionIds).toEqual(['q']);
  });
});

describe('persistence and lifecycle', () => {
  it('counts finished turns, not pauses on background work, and keeps the count across restarts', () => {
    reg.ingest(ev({ kind: 'stop', sessionId: 'a' }));
    reg.ingest(ev({ kind: 'stop', sessionId: 'a', waitingOn: 'shell' }));
    reg.ingest(ev({ kind: 'stop', sessionId: 'b' }));
    reg.close();
    reg = new Registry(FILE, CLEAN_ROOT);
    expect(reg.turnsSince(0)).toBe(2);
  });

  it('crates survive a restart', () => {
    reg.ingest(ev({ kind: 'prompt', sessionId: 'a', prompt: 'x' }));
    reg.close();
    reg = new Registry(FILE, CLEAN_ROOT);
    expect(reg.all()).toHaveLength(1);
    expect(reg.all()[0].zone).toBe('working');
  });

  it('a dead process moves its crate to storage and keeps it', () => {
    reg.ingest(ev({ kind: 'prompt', sessionId: 'a', pid: 42, prompt: 'x' }));
    const id = reg.all()[0].id;
    reg.checkLiveness(() => false, 5000);
    expect(reg.get(id)?.zone).toBe('storage');
    expect(reg.get(id)?.archived).toBe(false);
  });

  it('a session ended from the factory goes to storage even without a known process', () => {
    reg.ingest(ev({ kind: 'prompt', sessionId: 'a', prompt: 'x' }));
    const id = reg.all()[0].id;
    reg.markEnded(id, 9);
    expect(reg.get(id)).toMatchObject({ zone: 'storage', endedAt: 9, archived: false });
  });

  it('a resumed session heads for the dock straight away and its old process no longer counts', () => {
    reg.ingest(ev({ kind: 'prompt', sessionId: 'a', pid: 42, prompt: 'x' }));
    reg.ingest(ev({ kind: 'end', sessionId: 'a', pid: 42 }));
    const id = reg.all()[0].id;
    reg.archive(id, 1);
    reg.unarchive(id, 2);
    reg.markResuming(id, 3);
    reg.checkLiveness(() => false, 4);
    expect(reg.get(id)).toMatchObject({ zone: 'dock', archived: false });
  });

  it('archive and bring back keep counts and history', () => {
    reg.ingest(ev({ kind: 'end', sessionId: 'a' }));
    const id = reg.all()[0].id;
    reg.archive(id, 10);
    expect(reg.get(id)?.archived).toBe(true);
    reg.unarchive(id, 20);
    const crate = reg.get(id)!;
    expect(crate.archived).toBe(false);
    expect(crate.archiveCount).toBe(1);
    expect(crate.reactivationCount).toBe(1);
  });

  it('archives every crate sharing a label', () => {
    reg.ingest(ev({ kind: 'prompt', sessionId: 'a', prompt: 'TF-1 part one' }));
    reg.ingest(ev({ kind: 'prompt', sessionId: 'b', prompt: 'TF-1 part two' }));
    reg.ingest(ev({ kind: 'prompt', sessionId: 'c', prompt: 'other' }));
    expect(reg.archiveLabel('TF-1', 10)).toBe(2);
    expect(reg.all().filter((c) => c.archived)).toHaveLength(2);
  });
});

describe('ready-to-ship hint', () => {
  it('appears after three days in storage, without archiving', () => {
    reg.ingest(ev({ kind: 'end', sessionId: 'a' }));
    const crate = reg.all()[0];
    const at = crate.endedAt!;
    expect(reg.view(at + 2 * DAY)[0].readyToShip).toBeUndefined();
    expect(reg.view(at + 3 * DAY + 1)[0].readyToShip).toMatch(/storage/);
    expect(reg.get(crate.id)?.archived).toBe(false);
  });

  it('appears when the Jira ticket is resolved', () => {
    reg.ingest(ev({ kind: 'prompt', sessionId: 'a', prompt: 'TF-1' }));
    const id = reg.all()[0].id;
    reg.setJira(id, { status: 'Done', resolved: true }, 1);
    expect(reg.view(2)[0].readyToShip).toMatch(/Done/);
  });
});

describe('Jira status on archived crates', () => {
  it('a ticket that moves after archiving marks the crate returned, without unarchiving it', () => {
    reg.ingest(ev({ kind: 'prompt', sessionId: 'a', prompt: 'TF-1' }));
    const id = reg.all()[0].id;
    reg.setJira(id, { status: 'Done', resolved: true }, 1);
    reg.archive(id, 2);
    reg.setJira(id, { status: 'Done', resolved: true }, 3);
    expect(reg.get(id)?.returned).toBeUndefined();
    reg.setJira(id, { status: 'Reopened', resolved: false }, 4);
    expect(reg.get(id)?.returned?.reason).toBe('ticket moved to Reopened');
    expect(reg.get(id)?.archived).toBe(true);
  });

  it('uses the first status seen after archiving as the baseline when none was known', () => {
    reg.ingest(ev({ kind: 'prompt', sessionId: 'a', prompt: 'TF-2' }));
    const id = reg.all()[0].id;
    reg.archive(id, 1);
    reg.setJira(id, { status: 'In Review', resolved: false }, 2);
    expect(reg.get(id)?.returned).toBeUndefined();
    expect(reg.get(id)?.jira?.statusAtArchive).toBe('In Review');
  });
});
