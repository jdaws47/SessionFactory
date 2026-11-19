import { describe, expect, it } from 'vitest';
import { CATCH_UP_MAX, CatchUp } from '../web/catchup';
import { Scene } from '../web/scene';
import type { CrateView } from '../src/shared/types';

function crate(id: string, zone: CrateView['zone'], zoneSince: number): CrateView {
  return { id, sessionIds: [id], cwd: '/cr', repo: 'cr', label: id, labelSource: 'auto', zone, zoneSince, turns: 2, startedAt: zoneSince, updatedAt: zoneSince, archived: false, archiveCount: 0, reactivationCount: 0 };
}

/** A clock that moves on by `msPerCall` every time it is read, like real work taking time. */
const ticking = (msPerCall: number) => {
  let t = 0;
  return () => (t += msPerCall);
};

describe('catching up after the tab was hidden', () => {
  it('replays exactly the hidden time, a slice per frame, never more than the frame budget', () => {
    const c = new CatchUp();
    c.hidden(1_000);
    c.shown(31_000);
    expect(c.pending).toBeCloseTo(30);
    let replayed = 0;
    let frames = 0;
    while (c.pending > 0 && frames < 1000) {
      let thisFrame = 0;
      c.run((dt) => {
        expect(dt).toBeLessThanOrEqual(0.1);
        replayed += dt;
        thisFrame++;
      }, ticking(0.5));
      expect(thisFrame).toBeLessThanOrEqual(12); // 6 ms budget at 0.5 ms a step
      frames++;
    }
    expect(replayed).toBeCloseTo(30);
    expect(frames).toBeGreaterThan(1);
  });

  it('caps a long absence and ignores a show without a hide', () => {
    const c = new CatchUp();
    c.shown(5_000);
    expect(c.pending).toBe(0);
    c.hidden(0);
    c.shown(60 * 60_000);
    expect(c.pending).toBe(CATCH_UP_MAX);
  });

  it('a crate archived while the tab was hidden is already in the warehouse a few frames after coming back', () => {
    const run = (withCatchUp: boolean) => {
      const scene = new Scene();
      const a = crate('A', 'storage', 1);
      scene.setCrates([a], 1000);
      for (let i = 0; i < 60; i++) scene.update(1 / 60);
      const c = new CatchUp();
      c.hidden(0);
      // While hidden: the archive arrives, but no frames run.
      scene.setCrates([{ ...a, archived: true, archivedAt: 2 }], 2000);
      c.shown(90_000);
      // Ten frames after coming back.
      for (let f = 0; f < 10; f++) {
        scene.update(1 / 60);
        if (withCatchUp) c.run((dt) => scene.update(dt), ticking(0.01));
      }
      return scene.inspect().sprites.get('A')!.phase;
    };
    expect(run(true)).toBe('yard');
    expect(run(false)).not.toBe('yard');
  });
});
