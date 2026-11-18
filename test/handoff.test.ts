import { describe, expect, it } from 'vitest';
import { handoffBlocker } from '../src/server/handoff';
import { newCrate } from '../src/server/machine';
import type { Crate } from '../src/shared/types';
import { CLEAN_ROOT, ev } from './helpers';

function crate(over: Partial<Crate>): Crate {
  return { ...newCrate(ev({ kind: 'start' }), CLEAN_ROOT, 'c1'), sessionIds: ['s1'], ...over };
}

describe('moving a session into the factory', () => {
  it('stops while the original Claude process is still alive, even if it looks ended', () => {
    expect(handoffBlocker(crate({ pid: 42, zone: 'dock' }), () => true)).toMatch(/still open.*42/);
    expect(handoffBlocker(crate({ pid: 42, zone: 'storage' }), () => true)).toMatch(/still open/);
  });

  it('stops when there is no process to check and the session never reported ending', () => {
    expect(handoffBlocker(crate({ pid: undefined, zone: 'dock' }), () => false)).toMatch(/Can't confirm/);
  });

  it('allows the move once the original is gone', () => {
    expect(handoffBlocker(crate({ pid: 42, zone: 'dock' }), () => false)).toBeNull();
    expect(handoffBlocker(crate({ pid: undefined, zone: 'storage' }), () => false)).toBeNull();
  });

  it('allows it when its own factory terminal has closed and no Claude process ever reported (e.g. a resume that failed)', () => {
    expect(handoffBlocker(crate({ pid: undefined, zone: 'dock', slot: 'sf-1' }), () => false, { factoryTerminalGone: true })).toBeNull();
    expect(handoffBlocker(crate({ pid: undefined, zone: 'dock' }), () => false, { factoryTerminalGone: false })).toMatch(/Can't confirm/);
  });

  it('has nothing to move before a session exists', () => {
    expect(handoffBlocker(crate({ sessionIds: [] }), () => false)).toMatch(/no Claude session/);
  });
});
