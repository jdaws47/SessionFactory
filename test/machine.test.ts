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

  it('a turn that ends needing a decision or an answer from you stays jammed in its machine until you reply', () => {
    const decide = 'I found two fixes.\n\nWhich one do you want, the cache or the index?';
    const asked = run({ kind: 'prompt', prompt: 'go' }, { kind: 'stop', lastMessage: decide });
    expect(asked).toMatchObject({ zone: 'alert', alertReason: 'asked a question' });
    // Still waiting after Claude Code's idle reminder; answering sends it back to work.
    expect(run({ kind: 'prompt', prompt: 'go' }, { kind: 'stop', lastMessage: decide }, { kind: 'notify', notificationType: 'idle_prompt' }).zone).toBe('alert');
    expect(run({ kind: 'prompt', prompt: 'go' }, { kind: 'stop', lastMessage: decide }, { kind: 'prompt', prompt: 'the cache' }).zone).toBe('working');
  });

  it('decisions and open questions jam; a plan only waiting for your go-ahead goes to the dock', () => {
    const zoneAfter = (lastMessage: string) => run({ kind: 'prompt', prompt: 'go' }, { kind: 'stop', lastMessage }).zone;
    for (const decision of [
      '## Decision 1\n\n| A | B |\n\nIf you pick A, I\'ll start by checking whether ready_for_qc sessions come through dicom-pipeline.',
      'Not a decision, but blocking: I need the step order. Does any algorithms-runner step run after DTA?',
      "Two ways to do it.\n\nLet me know which you'd prefer.",
      'Before I write any code: is there a Jira ticket for this, or should I create one (Bug or Dev Bug)?',
      "How do you want the services' tests run?",
      'Should I build the recycle version? And is 30 minutes the right idle threshold?',
      'Should I implement the per-PR comment, and which flag option do you want?',
    ]) {
      expect(zoneAfter(decision), decision).toBe('alert');
    }
    for (const goAhead of [
      "Once the other session is done with cerebrum and you've created the TF-1198 branch, I'll start with the tests.",
      'I found two fixes.\n\nWant me to make it?',
      'Plan is above. Should I go ahead?',
      "Tell me when the branch is ready and I'll start.",
      "Say the word and I'll apply it.",
      'Ready to implement the resolvers when you say go.',
      'That shows the wait dropped. If you want the actual numbers, I can pull them from the logs.',
      'I\'ve checked the box on PR #290. The "How was it tested?" section already says that, so reviewers will know.',
      'Done. The template asks “Any breaking changes?” and I answered no.',
      '> Should we keep the old flag?\n\nI kept it, as the review asked.',
    ]) {
      expect(zoneAfter(goAhead), goAhead).toBe('dock');
    }
  });

  it('a question followed by its options still counts; a question earlier in the message does not', () => {
    const options = run({ kind: 'prompt', prompt: 'go' }, { kind: 'stop', lastMessage: 'Which one do you want?\n\n- **A:** fast\n- **B:** safe' });
    expect(options.zone).toBe('alert');
    const settled = run(
      { kind: 'prompt', prompt: 'go' },
      { kind: 'stop', lastMessage: 'Why did it lap?\n\nThe reroute waited for the dock turn-off.\n\nFixed, and all 118 tests pass.\n\nReload to see it.' },
    );
    expect(settled.zone).toBe('dock');
    // An open invitation to report back isn't waiting on you.
    const invited = run({ kind: 'prompt', prompt: 'go' }, { kind: 'stop', lastMessage: "Committed and built; reload to see it. I haven't seen it on screen, so tell me if the yellow is hard to read against the platform." });
    expect(invited.zone).toBe('dock');
    const codeQuestion = run({ kind: 'prompt', prompt: 'go' }, { kind: 'stop', lastMessage: 'Done.\n\n```ts\nconst x = a ? b : c?\n```' });
    expect(codeQuestion.zone).toBe('dock');
  });

  it('a question split from a short closing sentence by a blank line still counts', () => {
    const split = run({ kind: 'prompt', prompt: 'go' }, { kind: 'stop', lastMessage: 'Both fixes are in.\n\nWhich branch should the review go on?\n\nI can start either way.' });
    expect(split.zone).toBe('alert');
    // Only the sentence just before it: an earlier question in that paragraph is not the ending.
    const earlier = run({ kind: 'prompt', prompt: 'go' }, { kind: 'stop', lastMessage: 'Why did it lap? The reroute waited for the turn-off, so I fixed it.\n\nReload to see it.' });
    expect(earlier.zone).toBe('dock');
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
  it('picks up a Jira key from the session name only', () => {
    const named = run({ kind: 'start', title: 'TF-735' });
    expect(named.label).toBe('TF-735');
    expect(named.jiraKey).toBe('TF-735');
    expect(run({ kind: 'prompt', prompt: 'work on TF-735 reuse' }).jiraKey).toBeUndefined();
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
    const crate = run({ kind: 'start', title: 'gamify-work' }, { kind: 'prompt', prompt: 'go', title: 'TF-735 factory' });
    expect(crate.label).toBe('TF-735 factory');
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
