import { describe, expect, it } from 'vitest';
import { applyEvent, newCrate } from '../src/server/machine';
import type { Crate } from '../src/shared/types';
import { CLEAN_ROOT, ev } from './helpers';

function run(...events: Parameters<typeof ev>[0][]): Crate {
  const built = events.map(ev);
  let crate = newCrate(built[0], CLEAN_ROOT, 'c1');
  for (const e of built) crate = applyEvent(crate, e);
  return crate;
}

describe('zone state machine', () => {
  it('a new session waits at intake until its first prompt', () => {
    expect(run({ kind: 'start', source: 'startup' }).zone).toBe('intake');
  });

  it('a prompt sends the crate into the assembly hall', () => {
    const crate = run({ kind: 'start', source: 'startup' }, { kind: 'prompt', prompt: 'fix the bug' });
    expect(crate.zone).toBe('working');
    expect(crate.firstPrompt).toBe('fix the bug');
  });

  it('a permission prompt pulls the crate into the alert bay', () => {
    const crate = run(
      { kind: 'prompt', prompt: 'go' },
      { kind: 'preTool', tool: 'Bash' },
      { kind: 'notify', notificationType: 'permission_prompt' },
    );
    expect(crate.zone).toBe('alert');
    expect(crate.alertReason).toBe('permission');
  });

  it('a question tool is an alert even before any notification', () => {
    const crate = run({ kind: 'prompt', prompt: 'go' }, { kind: 'preTool', tool: 'AskUserQuestion' });
    expect(crate.zone).toBe('alert');
    expect(crate.alertReason).toBe('question');
  });

  it('tool progress after an alert returns the crate to work', () => {
    const crate = run(
      { kind: 'prompt', prompt: 'go' },
      { kind: 'notify', notificationType: 'permission_prompt' },
      { kind: 'postTool', tool: 'Bash' },
    );
    expect(crate.zone).toBe('working');
    expect(crate.alertReason).toBeUndefined();
    expect(crate.lastTool).toBe('Bash');
  });

  it('a finished turn queues the crate at the dock and counts the turn', () => {
    const crate = run({ kind: 'prompt', prompt: 'go' }, { kind: 'stop', lastMessage: 'done' });
    expect(crate.zone).toBe('dock');
    expect(crate.turns).toBe(1);
    expect(crate.lastMessage).toBe('done');
  });

  it('a turn paused on background work stays in a machine until the final stop', () => {
    const paused = run({ kind: 'prompt', prompt: 'go' }, { kind: 'stop', waitingOn: 'shell: npm test' });
    expect(paused.zone).toBe('working');
    expect(paused.waitingOn).toBe('shell: npm test');
    const done = run({ kind: 'prompt', prompt: 'go' }, { kind: 'stop', waitingOn: 'shell' }, { kind: 'postTool', tool: 'Bash' }, { kind: 'stop' });
    expect(done.zone).toBe('dock');
    expect(done.waitingOn).toBeUndefined();
  });

  it('an idle reminder does not pull a fresh session out of intake', () => {
    const crate = run({ kind: 'start', source: 'startup' }, { kind: 'notify', notificationType: 'idle_prompt' });
    expect(crate.zone).toBe('intake');
  });

  it('a resumed session lands at the dock', () => {
    expect(run({ kind: 'start', source: 'resume' }).zone).toBe('dock');
  });

  it('session end parks the crate in storage; it is never removed', () => {
    const crate = run({ kind: 'prompt', prompt: 'go' }, { kind: 'end', reason: 'prompt_input_exit' });
    expect(crate.zone).toBe('storage');
    expect(crate.endedAt).toBeDefined();
    expect(crate.archived).toBe(false);
  });

  it('zoneSince only moves when the zone changes', () => {
    const built = [ev({ kind: 'prompt', prompt: 'go' }), ev({ kind: 'postTool', tool: 'Read' }), ev({ kind: 'postTool', tool: 'Edit' })];
    let crate = newCrate(built[0], CLEAN_ROOT, 'c1');
    for (const e of built) crate = applyEvent(crate, e);
    expect(crate.zoneSince).toBe(built[0].at);
  });

  it('activity on an archived crate marks it returned but keeps it archived', () => {
    const first = ev({ kind: 'end' });
    let crate = { ...newCrate(first, CLEAN_ROOT, 'c1'), archived: true };
    crate = applyEvent(crate, ev({ kind: 'start', source: 'resume' }));
    expect(crate.archived).toBe(true);
    expect(crate.returned?.reason).toMatch(/active/);
  });
});

describe('labels', () => {
  it('picks up a Jira key from the first prompt', () => {
    const crate = run({ kind: 'prompt', prompt: 'work on TF-735 reuse' });
    expect(crate.label).toBe('TF-735');
    expect(crate.jiraKey).toBe('TF-735');
    expect(crate.labelSource).toBe('jira');
  });

  it('ignores key-shaped text from unknown projects', () => {
    const crate = run({ kind: 'prompt', prompt: 'convert to UTF-8 please' });
    expect(crate.jiraKey).toBeUndefined();
    expect(crate.label).toBe('cerebrum: convert to UTF-8 please');
  });

  it('never overwrites a manual label', () => {
    const first = ev({ kind: 'start' });
    let crate: Crate = { ...newCrate(first, CLEAN_ROOT, 'c1'), label: 'mine', labelSource: 'manual' };
    crate = applyEvent(crate, ev({ kind: 'prompt', prompt: 'PORT-1 stuff' }));
    expect(crate.label).toBe('mine');
  });

  it('follows the session name, including a /rename picked up on the next prompt', () => {
    const crate = run({ kind: 'start', title: 'gamify-work' }, { kind: 'prompt', prompt: 'TF-735 go', title: 'factory' });
    expect(crate.label).toBe('factory');
    expect(crate.jiraKey).toBe('TF-735');
  });

  it('ignores prompts Claude Code injects itself, like background task notifications', () => {
    const crate = run({ kind: 'prompt', prompt: '<task-notification>\n<task-id>x</task-id>' }, { kind: 'prompt', prompt: 'fix flaky tests' });
    expect(crate.firstPrompt).toBe('fix flaky tests');
    expect(crate.zone).toBe('working');
  });

  it('uses the workspace root name for sessions started at the root', () => {
    const crate = run({ kind: 'start', cwd: CLEAN_ROOT });
    expect(crate.repo).toBe('clean-room');
  });
});
